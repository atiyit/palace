import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../lib/seeds.ts';
import { deliverTask, type DeliveryDependencies } from '../lib/server/task-delivery.ts';
import { runCode } from '../lib/server/code-interpreter.ts';
import type { Task, TaskArtifact, SocialEvent } from '../lib/types.ts';

const NOW = '2026-10-12T16:00:00.000Z';
function fixture() {
  const state = createInitialState(); state.agents = state.agents.slice(0, 3);
  state.agents.forEach(agent => { agent.hired = true; });
  const task: Task = { id: 'task-delivery', title: '计算数据并交付文件', status: 'running', rounds: 3, round: 2, participants: state.agents.map(agent => agent.id), order: state.agents.map(agent => agent.id), cursor: 0, createdAt: NOW };
  state.tasks.push(task);
  return { state, task };
}
const finish = { type: 'finish', summary: '计算结果已写入可下载的文件。' };
const approved = { pass: true, reason: '与真实工具和文件一致。' };
const write = (name = 'result.csv', content = 'value\n12') => ({ type: 'tool', tool: 'file.write', input: { name, content } });
function scripted(values: unknown[], overrides: Partial<DeliveryDependencies> = {}) {
  const calls: { system: string; input: any }[] = [];
  const stored = new Map<string, string>();
  const deps: DeliveryDependencies = {
    prompt: id => id,
    generate: async (system, input) => {
      calls.push({ system, input: structuredClone(input) });
      if (!values.length) throw new Error('No scripted model response');
      const value = values.shift(); if (value instanceof Error) throw value;
      return value;
    },
    search: async query => [{ title: `真实测试结果:${query}`, url: 'https://example.com/reference', snippet: 'mock search evidence' }],
    read: async url => ({ url, text: 'mock read evidence' }),
    code: runCode,
    store: async (file, metadata) => { stored.set(metadata.id, file.content); },
    load: async artifact => { const content = stored.get(artifact.id); if (content === undefined) throw new Error('Missing test artifact'); return content; },
    ...overrides,
  };
  return { deps, calls, stored };
}

test('delivery records real code output and files before publishing an independently checked summary', async () => {
  const { state, task } = fixture();
  const run = scripted([{ type: 'tool', tool: 'code.run', input: { code: "console.log(7 * 6); emitFile('result.csv', 'answer\\n42');" } }, finish, approved]);
  const message = await deliverTask(state, task, run.deps, '给我CSV');
  assert.match(message, /1个可下载文件/);
  assert.equal(task.toolRuns?.length, 1);
  assert.equal(task.toolRuns![0].output, '42');
  assert.equal(task.toolRuns![0].status, 'ok');
  assert.equal(task.artifacts?.length, 1);
  const artifact = task.artifacts![0];
  assert.equal(artifact.name, 'result.csv'); assert.equal(artifact.mimeType, 'text/csv');
  assert.equal(artifact.size, 9); assert.equal(run.stored.get(artifact.id), 'answer\n42');
  assert.deepEqual(task.toolRuns![0].artifactIds, [artifact.id]);
  assert.equal(state.events.length, 1); assert.equal(state.events[0].checked, true);
  assert.deepEqual(run.calls.map(call => call.system), ['task.delivery', 'task.delivery', 'task.delivery.review']);
  const review = run.calls[2].input;
  assert.equal(review.actualToolResults[0].output, '42'); assert.equal(review.artifacts[0].id, artifact.id);
});

test('a model cannot finish with promises before creating an actual downloadable file', async () => {
  const { state, task } = fixture();
  const run = scripted([finish, write(), finish, approved]);
  await deliverTask(state, task, run.deps);
  assert.match(run.calls[1].input.correction, /没有生成可下载的实际文件/);
  assert.equal(run.calls[1].system, 'task.delivery');
  assert.equal(task.artifacts?.length, 1);
  assert.equal(state.events.length, 1);
  const nothing = fixture(); const promises = scripted(Array.from({ length: 7 }, () => finish));
  assert.match(await deliverTask(nothing.state, nothing.task, promises.deps), /尚未产出文件/);
  assert.equal(nothing.task.artifacts?.length, 0); assert.equal(nothing.state.events.length, 0);
  assert.equal(promises.calls.length, 7);
});

test('failed tools remain visible as errors and are fed into the next decision without fabricated results', async () => {
  const { state, task } = fixture();
  const run = scripted([{ type: 'tool', tool: 'web.read', input: { url: 'https://example.com/unavailable' } }, write('explanation.md', '网页暂时无法读取。'), finish, approved], {
    read: async () => { throw new Error('source unavailable'); },
  });
  await deliverTask(state, task, run.deps);
  assert.equal(task.toolRuns![0].status, 'error'); assert.equal(task.toolRuns![0].error, 'source unavailable');
  assert.equal(task.toolRuns![0].output, undefined);
  assert.equal(run.calls[1].input.previousTools[0].status, 'error');
  assert.equal(task.toolRuns![1].status, 'ok'); assert.equal(task.artifacts!.length, 1);
});

test('failed artifact storage does not expose a downloadable metadata record', async () => {
  const { state, task } = fixture();
  const run = scripted([write(), new Error('model unavailable')], { store: async () => { throw new Error('storage unavailable'); } });
  const message = await deliverTask(state, task, run.deps);
  assert.match(message, /已保留0个新文件/);
  assert.equal(task.artifacts!.length, 0); assert.equal(task.toolRuns![0].status, 'error');
  assert.equal(task.toolRuns![0].error, 'storage unavailable'); assert.equal(state.events.length, 0);
});

test('tool budget cannot exceed six calls even when the model continues requesting tools', async () => {
  const { state, task } = fixture();
  let searches = 0;
  const run = scripted(Array.from({ length: 7 }, () => ({ type: 'tool', tool: 'web.search', input: { query: '公开资料' } })), { search: async () => { searches++; return []; } });
  await deliverTask(state, task, run.deps);
  assert.equal(searches, 6); assert.equal(task.toolRuns!.length, 6); assert.equal(run.calls.length, 7);
  assert.equal(run.calls[6].input.mustFinish, true); assert.equal(state.events.length, 0);
});

test('rejected summaries are corrected and never published until independent review passes', async () => {
  const { state, task } = fixture();
  const run = scripted([write(), { type: 'finish', summary: '我已经完成没有执行过的现实操作。' }, { pass: false, reason: '没有该现实操作的工具证据。' }, finish, approved]);
  await deliverTask(state, task, run.deps);
  assert.match(run.calls[3].input.correction, /没有该现实操作/);
  assert.equal(state.events.length, 1); assert.equal(state.events[0].content, finish.summary);
  assert.equal(task.artifacts!.length, 1);
});

test('archived members cannot execute delivery and other members private data is absent', async () => {
  const { state, task } = fixture();
  state.agents[0].archivedAt = NOW;
  state.agents[2].strategy = 'OTHER_PRIVATE_STRATEGY';
  state.agents[2].chats.push({ id: 'private', role: 'user', content: 'OTHER_PRIVATE_CHAT', createdAt: NOW });
  state.agents[2].memories.push({ id: 'secret', kind: 'experience', content: 'OTHER_PRIVATE_MEMORY', source: 'private', createdAt: NOW });
  const run = scripted([write(), finish, approved]); await deliverTask(state, task, run.deps);
  assert.equal(task.toolRuns![0].agentId, state.agents[1].id);
  assert.equal(run.calls[0].input.immutableCore.name, state.agents[1].name);
  for (const token of ['OTHER_PRIVATE_STRATEGY', 'OTHER_PRIVATE_CHAT', 'OTHER_PRIVATE_MEMORY']) assert.equal(JSON.stringify(run.calls).includes(token), false);
  assert.ok(run.calls[0].input.members.every((member: { id: string }) => member.id !== state.agents[0].id));
  state.agents.forEach(agent => { agent.archivedAt = NOW; });
  await assert.rejects(() => deliverTask(state, task, scripted([]).deps), /没有在庭成员/);
});

test('delivery respects task-round visibility instead of reading another members current directed exchange', async () => {
  const { state, task } = fixture();
  const [a, b, c] = state.agents;
  const message = (id: string, from: string, target: string | undefined, round = 2): SocialEvent => ({ id, taskId: task.id, round, agentId: from, kind: 'propose', targetId: target, content: id, checked: true, createdAt: NOW });
  state.events = [message('old-public', b.id, c.id, 1), message('current-public', b.id, undefined), message('current-inbox', b.id, a.id), message('current-own', a.id, c.id), message('OTHER_DIRECTED_CURRENT', b.id, c.id), { ...message('unreviewed', a.id, undefined), checked: false }];
  const run = scripted([write(), finish, approved]); await deliverTask(state, task, run.deps);
  const ids = run.calls[0].input.contributions.map((item: SocialEvent) => item.id);
  assert.deepEqual(ids, ['old-public', 'current-public', 'current-inbox', 'current-own']);
  assert.equal(JSON.stringify(run.calls).includes('OTHER_DIRECTED_CURRENT'), false);
});

test('subsequent delivery can use actual prior artifacts and tool records as shared workspace context', async () => {
  const { state, task } = fixture();
  const first = scripted([write('input.csv', 'value\n3\n7'), finish, approved]);
  await deliverTask(state, task, first.deps);
  const artifact: TaskArtifact = task.artifacts![0];
  const second = scripted([{ type: 'tool', tool: 'code.run', input: { code: "const sum=files['input.csv'].split('\\n').slice(1).map(Number).reduce((a,b)=>a+b,0);console.log(sum);emitFile('sum.csv', 'sum\\n'+sum);" } }, finish, approved], { load: async item => first.stored.get(item.id)! });
  await deliverTask(state, task, second.deps);
  assert.equal(second.calls[0].input.files[0].id, artifact.id);
  assert.equal(second.calls[0].input.previousTools[0].status, 'ok');
  assert.equal(task.toolRuns![1].output, '10');
  assert.notEqual(task.toolRuns![1].agentId, task.toolRuns![0].agentId);
  assert.equal(task.artifacts!.length, 2);
});

test('delivery rotates across members even after a run consumes exactly six tools', async () => {
  const { state, task } = fixture();
  const first = scripted(Array.from({ length: 7 }, () => ({ type: 'tool', tool: 'web.search', input: { query: '公开资料' } })));
  await deliverTask(state, task, first.deps);
  const second = scripted([write(), finish, approved]); await deliverTask(state, task, second.deps);
  assert.notEqual(second.calls[0].input.immutableCore.name, first.calls[0].input.immutableCore.name);
});
