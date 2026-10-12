import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityRunner, type ActivityDependencies } from '../lib/server/activity-runner.ts';

const base = (): ActivityDependencies => ({ step: async () => ({ continuing: false, completedStep: true }), pause: async () => {}, error: () => '公开的失败说明', delay: async () => {} });

test('activity runner counts completed turns, not saved tool continuations, and isolates owners', async () => {
  const runner = createActivityRunner();
  const steps = [false, false, true, true];
  const first = runner.start('alice', { kind: 'task', taskId: 'task-1', steps: 0 }, { ...base(), step: async () => ({ continuing: steps.length > 1, completedStep: steps.shift()! }) });
  runner.start('bob', { kind: 'daily', steps: 1 }, base());
  assert.throws(() => runner.start('alice', { kind: 'daily', steps: 1 }, base()), /已有/);
  first.done = 900;
  assert.equal(runner.snapshot('alice')!.done, 0);
  await Promise.all([runner.settled('alice'), runner.settled('bob')]);
  assert.equal(runner.snapshot('alice')!.done, 2);
  assert.equal(runner.snapshot('bob')!.done, 1);
  assert.equal(runner.snapshot('alice')!.status, 'completed');
  assert.equal(runner.snapshot('nobody'), null);
  assert.equal(runner.active('alice'), false);
});

test('finite daily schedules stop exactly at their requested steps, while zero continues until paused', async () => {
  const runner = createActivityRunner();
  let calls = 0;
  const request = { kind: 'daily' as const, steps: 3 };
  runner.start('finite', request, { ...base(), step: async () => { calls++; return { continuing: true, completedStep: true }; } });
  request.steps = 100;
  await runner.settled('finite');
  assert.equal(calls, 3);
  const pauses: boolean[] = [];
  let ongoingId = '';
  ongoingId = runner.start('ongoing', { kind: 'daily', steps: 0 }, {
    ...base(), pause: async (_request, finish) => { pauses.push(finish); },
    step: async () => { if (++calls === 9) runner.pause('ongoing', ongoingId); return { continuing: true, completedStep: true }; },
  }).id;
  await runner.settled('ongoing');
  assert.equal(runner.snapshot('ongoing')!.status, 'paused');
  assert.equal(runner.snapshot('ongoing')!.done, 6);
  assert.deepEqual(pauses, [false]);
});

test('pause waits for the active step and finishing an already paused task does not call another model', async () => {
  const runner = createActivityRunner();
  const started = Promise.withResolvers<void>(), finishStep = Promise.withResolvers<void>();
  let calls = 0;
  const pauses: boolean[] = [];
  const run = runner.start('owner', { kind: 'task', taskId: 'task-1', steps: 0 }, {
    ...base(), step: async () => { calls++; started.resolve(); await finishStep.promise; return { continuing: true, completedStep: false }; },
    pause: async (_request, finish) => { pauses.push(finish); },
  });
  await started.promise;
  assert.throws(() => runner.pause('another-owner', run.id));
  assert.throws(() => runner.pause('owner', 'stale-id'));
  assert.equal(runner.pause('owner', run.id)!.status, 'pausing');
  assert.equal(runner.active('owner'), true);
  finishStep.resolve(); await runner.settled('owner');
  assert.equal(runner.snapshot('owner')!.done, 0);
  assert.equal(runner.snapshot('owner')!.status, 'paused');
  runner.pause('owner', run.id, true); await runner.settled('owner');
  assert.equal(runner.snapshot('owner')!.status, 'completed');
  assert.equal(calls, 1);
  assert.deepEqual(pauses, [false, true]);
});

test('only retryable lease conflicts back off; provider failures stop once and retain a public error', async () => {
  const runner = createActivityRunner();
  let calls = 0;
  const delays: number[] = [], pauses: boolean[] = [];
  runner.start('lease', { kind: 'daily', steps: 1 }, { ...base(), retryable: error => error === 'lease-busy',
    delay: async duration => { delays.push(duration); },
    step: async () => { if (++calls < 4) throw 'lease-busy'; return { continuing: true, completedStep: true }; },
  });
  await runner.settled('lease');
  assert.equal(calls, 4); assert.equal(runner.snapshot('lease')!.done, 1); assert.deepEqual(delays, [500, 1000, 2000]);
  calls = 0;
  runner.start('failed', { kind: 'task', taskId: 'task-2', steps: 0 }, { ...base(), retryable: () => false,
    step: async () => { calls++; throw new Error('private upstream detail'); },
    pause: async (_request, finish) => { pauses.push(finish); },
  });
  await runner.settled('failed');
  assert.equal(calls, 1); assert.equal(runner.snapshot('failed')!.status, 'failed');
  assert.equal(runner.snapshot('failed')!.error, '公开的失败说明'); assert.equal(runner.snapshot('failed')!.done, 0);
  assert.deepEqual(pauses, [false]);
});

test('pausing during a lease retry never starts another step, and pause persistence can retry its own lease', async () => {
  const runner = createActivityRunner();
  let id = '', calls = 0, pauseCalls = 0;
  id = runner.start('owner', { kind: 'daily', steps: 0 }, { ...base(),
    retryable: error => error === 'lease-busy',
    step: async () => { calls++; throw 'lease-busy'; },
    delay: async () => { runner.pause('owner', id); },
    pause: async () => { if (++pauseCalls === 1) throw 'lease-busy'; },
  }).id;
  await runner.settled('owner');
  assert.equal(calls, 1); assert.equal(pauseCalls, 2); assert.equal(runner.snapshot('owner')!.status, 'paused');
});

test('an externally paused task ends scheduling as paused without marking its work completed', async () => {
  const runner = createActivityRunner(); let calls = 0;
  runner.start('owner', { kind: 'task', taskId: 'external-pause', steps: 0 }, {
    ...base(), step: async () => { calls++; return calls === 1 ? { continuing: true, completedStep: true } : { continuing: false, completedStep: false, stopped: 'paused' }; },
  });
  await runner.settled('owner');
  assert.equal(calls, 2); assert.equal(runner.snapshot('owner')!.status, 'paused'); assert.equal(runner.snapshot('owner')!.done, 1);
});

test('discard removes only an inactive owner job and cannot hide in-flight work', async () => {
  const runner = createActivityRunner(), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  runner.start('owner', { kind: 'daily', topic: '要删除的旧话题', steps: 1 }, { ...base(), step: async () => { entered.resolve(); await released.promise; return { continuing: false, completedStep: true }; } });
  await entered.promise;
  assert.equal(runner.discard('owner'), false); assert.equal(runner.active('owner'), true);
  released.resolve(); await runner.settled('owner');
  assert.equal(runner.discard('owner'), true); assert.equal(runner.snapshot('owner'), null);
  assert.equal(runner.discard('missing'), false);
});
