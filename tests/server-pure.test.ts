import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createInitialState } from '../lib/seeds.ts';
import { SKILL_LABELS, type SocialEvent, type Task } from '../lib/types.ts';
import { actionSchema, normalizeSkills, ownContext, taskVisibility, validateTaskAction } from '../lib/server/guardrails.ts';
import { stateRepository } from '../lib/server/repository.ts';
import { parseModelObject, retryableModelFormatError } from '../lib/server/model-json.ts';
import { PalaceError } from '../lib/server/errors.ts';

const timestamp = '2026-10-12T04:00:00.000Z';
const task: Task = { id: 't', title: '共同设计花园', status: 'running', rounds: 3, round: 2, participants: ['jade', 'mist', 'ember'], order: ['mist', 'jade', 'ember'], cursor: 0, createdAt: timestamp };
const event = (patch: Partial<SocialEvent> = {}): SocialEvent => ({ id: 'e', taskId: 't', round: 1, agentId: 'jade', kind: 'propose', content: '公开方案', createdAt: timestamp, checked: true, ...patch });

test('model JSON extraction handles commentary, fences, nested values and braces inside escaped strings', () => {
  const object = { content: '保留 {花园} 与 "引号"，路径\\参考', memories: [{ content: '短记忆', source: 'event-1' }] };
  assert.deepEqual(parseModelObject(`以下是行动：\n\`\`\`json\n${JSON.stringify(object)}\n\`\`\`\n已完成。`, 'stop'), object);
  assert.deepEqual(parseModelObject(JSON.stringify(object)), object);
});

test('truncated, ambiguous and malformed model output is rejected; only format failures are retryable', () => {
  assert.throws(() => parseModelObject('{"kind":"submit"}', 'length'), (error: unknown) => error instanceof PalaceError && error.code === 'PROVIDER_TRUNCATED');
  for (const text of ['{"kind":', '{"a":1}{"b":2}', '[{"a":1}]', '{"a": 1,}', 'no object', '{"a":"broken}']) {
    assert.throws(() => parseModelObject(text), (error: unknown) => retryableModelFormatError(error));
  }
  assert.equal(retryableModelFormatError(new PalaceError('timeout', 504, 'PROVIDER_TIMEOUT')), false);
  assert.equal(retryableModelFormatError(new PalaceError('offline', 502, 'PROVIDER_ERROR')), false);
});

test('model response cannot assign identity, age, abilities, recommendation weights, or its own memory ids', () => {
  const parsed = actionSchema.parse({ kind: 'submit', content: '一个草案', name: '新名字', age: 9, skills: { research: 999 }, weight: 999, hired: true, memories: [{ kind: 'experience', content: '写了草案', source: 'e', id: 'forced', createdAt: 'forged' }] });
  for (const field of ['name', 'age', 'skills', 'weight', 'hired']) assert.equal(field in parsed, false);
  assert.equal('id' in parsed.memories[0], false);
});

test('short-term context is private, bounded, and contains no external execution tools', () => {
  const [alice, bob] = createInitialState().agents;
  alice.chats = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, role: 'user' as const, content: `Alice ${i}`, createdAt: timestamp }));
  bob.chats = [{ id: 'b-secret', role: 'user', content: 'BOB_PRIVATE_SECRET', createdAt: timestamp }];
  bob.memories = [{ id: 'memory-secret', kind: 'preference', content: 'BOB_LONG_TERM_SECRET', source: 'b-secret', createdAt: timestamp }];
  const context = ownContext(alice, '花园');
  assert.equal(context.shortTermChats.length, 12);
  assert.equal(context.shortTermChats[0].sourceId, 'a8');
  assert.equal(JSON.stringify(context).includes('BOB_'), false);
  assert.deepEqual(context.tools, []);
});

test('task visibility excludes unrelated tasks, current-round messages to others, and rejected model output', () => {
  const agent = createInitialState().agents.find(person => person.id === 'mist')!;
  const view = taskVisibility(agent, task, [event(), event({ id: 'current', round: 2, targetId: 'ember' }), event({ id: 'inbox', round: 2, targetId: 'mist', kind: 'request' }), event({ id: 'rejected', checked: false, targetId: 'mist' }), event({ id: 'other-task', taskId: 'other' })]);
  assert.deepEqual(view.publicPreviousRounds.map(item => item.id), ['e']);
  assert.deepEqual(view.inbox.map(item => item.id), ['inbox']);
  assert.deepEqual(view.pendingRequests.map(item => item.id), ['inbox']);
});

test('acceptance must reference an outstanding request to this agent; server derives its target', () => {
  const agent = createInitialState().agents.find(person => person.id === 'mist')!;
  const request = event({ id: 'request', targetId: 'mist', kind: 'request' });
  const action = actionSchema.parse({ kind: 'accept', replyTo: 'request', targetId: 'forged-target', content: '我愿意协助。' });
  const accepted = validateTaskAction(action, agent, task, [request]);
  assert.equal(accepted.targetId, 'jade');
  assert.throws(() => validateTaskAction(action, agent, task, []), /尚未处理/);
  assert.throws(() => validateTaskAction(action, agent, task, [{ ...request, targetId: 'ember' }]), /尚未处理/);
  assert.throws(() => validateTaskAction(action, agent, task, [request, event({ id: 'old-accept', agentId: 'mist', kind: 'accept', replyTo: 'request' })]), /尚未处理/);
  assert.throws(() => validateTaskAction(actionSchema.parse({ kind: 'request', targetId: 'outsider', content: '求助' }), agent, task, []), /另一位参与者/);
});

test('ability normalization has exactly 960 points over sixteen dimensions and two visible weaknesses', () => {
  for (const values of [Array(16).fill(95), Array(16).fill(15), Array.from({ length: 16 }, (_, i) => 15 + i * 5), Array.from({ length: 16 }, (_, i) => i % 2 ? 95 : 20)]) {
    const normalized = normalizeSkills(Object.fromEntries(Object.keys(SKILL_LABELS).map((key, i) => [key, values[i]])));
    assert.equal(Object.keys(normalized).length, 16);
    assert.equal(Object.values(normalized).reduce((sum, value) => sum + value, 0), 960);
    assert.ok(Object.values(normalized).every(value => value >= 15 && value <= 95));
    assert.ok(Object.values(normalized).filter(value => value < 50).length >= 2);
  }
});

function sqliteRepository() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../drizzle/0000_same_blink.sql', import.meta.url), 'utf8'));
  const adapter = { prepare(sql: string) {
    const statement = db.prepare(sql);
    let parameters: SQLInputValue[] = [];
    const bound = {
      bind(...values: SQLInputValue[]) { parameters = values; return bound; },
      async run() { const result = statement.run(...parameters); return { meta: { changes: Number(result.changes) } }; },
      async first() { return statement.get(...parameters) || null; },
    };
    return bound;
  } } as unknown as D1Database;
  return { db, repo: stateRepository(adapter) };
}

test('committed request ids do not replay model side effects, and user state is isolated', async () => {
  const { db, repo } = sqliteRepository();
  let calls = 0;
  const initial = () => ({ count: 0 });
  const mutate = async (state: { count: number }) => { calls++; state.count++; };
  await repo.mutateState('alice', 'same-request', initial, mutate);
  const replay = await repo.mutateState('alice', 'same-request', initial, mutate);
  assert.equal(calls, 1);
  assert.equal(replay.replayed, true);
  assert.equal(replay.state.count, 1);
  assert.equal((await repo.readState('bob', initial)).count, 0);
  db.close();
});

test('failed model operation commits nothing and releases its lease', async () => {
  const { db, repo } = sqliteRepository();
  const initial = () => ({ count: 0 });
  await assert.rejects(repo.mutateState('alice', 'failed', initial, async state => { state.count++; throw new Error('provider timeout'); }), /provider timeout/);
  assert.equal((await repo.readState('alice', initial)).count, 0);
  assert.equal(db.prepare('SELECT lease_token FROM palace_states WHERE user_id=?').get('alice')?.lease_token, null);
  await repo.mutateState('alice', 'next', initial, async state => { state.count++; });
  assert.equal((await repo.readState('alice', initial)).count, 1);
  db.close();
});

test('overlapping mutations are rejected before model calls, while the original turn commits', async () => {
  const { db, repo } = sqliteRepository();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocker = new Promise<void>(resolve => { release = resolve; });
  const initial = () => ({ count: 0 });
  const first = repo.mutateState('alice', 'one', initial, async state => { enter(); await blocker; state.count++; });
  await entered;
  await assert.rejects(repo.mutateState('alice', 'two', initial, async () => { assert.fail('second provider call must never run'); }), /上一个请求/);
  release();
  await first;
  assert.equal((await repo.readState('alice', initial)).count, 1);
  db.close();
});

test('expired leases cannot commit and stale cleanup never unlocks a replacement lease', async () => {
  const { db, repo } = sqliteRepository();
  const initial = () => ({ count: 0 });
  await assert.rejects(repo.mutateState('alice', 'expired', initial, async state => {
    state.count = 99;
    db.prepare('UPDATE palace_states SET lease_until=0 WHERE user_id=?').run('alice');
  }), /超时/);
  assert.equal((await repo.readState('alice', initial)).count, 0);
  await assert.rejects(repo.mutateState('alice', 'replaced', initial, async state => {
    state.count = 88;
    db.prepare('UPDATE palace_states SET lease_token=? WHERE user_id=?').run('new-owner', 'alice');
  }), /超时/);
  assert.equal(db.prepare('SELECT lease_token FROM palace_states WHERE user_id=?').get('alice')?.lease_token, 'new-owner');
  assert.equal((await repo.readState('alice', initial)).count, 0);
  db.close();
});
