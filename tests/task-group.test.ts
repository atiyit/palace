import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../lib/seeds.ts';
import { appendGroupUserMessage, runGroupTurn, taskGroupContext, GROUP_REQUEST_TOOL_LIMIT, type GroupDependencies } from '../lib/server/task-group.ts';
import { runCode } from '../lib/server/code-interpreter.ts';
import type { SocialEvent, Task, TaskArtifact } from '../lib/types.ts';

const NOW = '2026-10-12T16:00:00.000Z';
function fixture() {
  const state = createInitialState(); state.agents = state.agents.slice(0, 4);
  state.agents.forEach(agent => { agent.hired = true; });
  const task: Task = { id: 'group-task', mode: 'group', title: '一起准备一份旅行攻略', status: 'running', rounds: 3, round: 1,
    participants: state.agents.slice(0, 3).map(agent => agent.id), order: state.agents.slice(0, 3).map(agent => agent.id), cursor: 0, createdAt: NOW };
  state.tasks.push(task); return { state, task, author: state.agents[0] };
}
const approved = { pass: true, reason: '与人设和实际事实一致。' };
const finish = (content = '我建议先确认出发时间和目的地。', extra = {}) => ({ type: 'finish', kind: 'propose', content, ...extra });
const write = (name = 'draft.md', content = '# 旅行计划', baseArtifactIds: string[] = []) => ({ type: 'tool', tool: 'file.write', input: { name, content, baseArtifactIds } });
function script(values: unknown[], overrides: Partial<GroupDependencies> = {}) {
  const calls: { system: string; input: any; timeout: number }[] = [];
  const stored = new Map<string, string>(), images = new Map<string, Uint8Array>();
  const deps: GroupDependencies = {
    prompt: id => id,
    generate: async (system, input, _tokens, timeout) => { calls.push({ system, input: structuredClone(input), timeout }); const value = values.shift(); if (value instanceof Error) throw value; if (!value) throw new Error('Missing scripted response'); return value; },
    search: async query => [{ title: query, url: 'https://example.com', snippet: 'source' }], read: async url => ({ url, text: 'public source' }), code: runCode,
    store: async (file, artifact) => { stored.set(artifact.id, file.content); }, load: async artifact => { const file = stored.get(artifact.id); if (file === undefined) throw new Error('Missing file'); return file; },
    image: async () => ({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }), storeImage: async (image, artifact) => { images.set(artifact.id, image.bytes); },
    ...overrides,
  };
  return { deps, calls, stored, images };
}
const message = (task: Task, id: string, agentId: string, extra: Partial<SocialEvent> = {}): SocialEvent => ({ id, taskId: task.id, round: task.round, agentId, kind: 'propose', content: id, createdAt: NOW, checked: true, ...extra });

test('a checked text response completes a group turn without requiring artifacts or changing scheduling', async () => {
  const { state, task, author } = fixture(); const run = script([finish(), approved]);
  assert.equal(await runGroupTurn(state, task, author, run.deps), undefined);
  assert.equal(state.events.length, 1); assert.equal(state.events[0].actorType, 'agent'); assert.equal(state.events[0].content, finish().content);
  assert.deepEqual(task.artifacts, []); assert.equal(task.cursor, 0); assert.equal(task.round, 1);
  assert.deepEqual(run.calls.map(call => call.system), ['task.group', 'task.group.review']);
  for (const member of state.agents.slice(0, 3)) assert.match(member.memories.find(memory => memory.source === `task-group:${task.id}`)!.content, /出发时间/);
  assert.equal(state.agents[3].memories.length, 0);
});

test('current-round addressed messages are public while other chats, tasks, and private memories stay isolated', async () => {
  const { state, task, author } = fixture(); const [, b, c] = state.agents;
  b.strategy = 'PRIVATE_STRATEGY'; b.chats.push({ id: 'private-b', role: 'user', content: 'PRIVATE_CHAT', createdAt: NOW });
  b.memories.push({ id: 'private-memory', kind: 'experience', source: 'private-b', content: 'PRIVATE_MEMORY', createdAt: NOW });
  state.events.push(message(task, 'PUBLIC_ADDRESSED', b.id, { targetId: c.id }), message(task, 'UNCHECKED', b.id, { checked: false }), message(task, 'OTHER_TASK', b.id, { taskId: 'other' }));
  const run = script([finish(), approved]); await runGroupTurn(state, task, author, run.deps);
  assert.equal(run.calls[0].input.messages[0].content, 'PUBLIC_ADDRESSED');
  for (const secret of ['PRIVATE_STRATEGY', 'PRIVATE_CHAT', 'PRIVATE_MEMORY', 'UNCHECKED', 'OTHER_TASK']) assert.equal(JSON.stringify(run.calls).includes(secret), false);
});

test('user group messages enter participant memories immediately without model calls or scheduling changes', () => {
  const { state, task } = fixture(); state.agents[2].archivedAt = NOW;
  const event = appendGroupUserMessage(state, task, '  请先考虑交通费用。  ');
  assert.equal(event.actorType, 'user'); assert.equal(event.content, '请先考虑交通费用。'); assert.equal(event.checked, true);
  assert.equal(task.cursor, 0); assert.equal(task.status, 'running');
  assert.match(state.agents[0].memories[0].content, /用户：请先考虑交通费用/);
  assert.equal(state.agents[2].memories.length, 0); assert.equal(state.agents[3].memories.length, 0);
  assert.throws(() => appendGroupUserMessage(state, task, ' '), /群消息需为/);
});

test('each task has one updating reserved memory even when ordinary memory capacity is full', () => {
  const { state, task, author } = fixture();
  state.settings.memoryLimit = 100;
  author.memories = Array.from({ length: 100 }, (_, index) => ({ id: `memory-${index}`, kind: 'experience', source: `source-${index}`, content: `已有记忆${index}`, createdAt: NOW }));
  appendGroupUserMessage(state, task, '第一条群消息');
  assert.equal(author.memories.length, 101); const groupMemory = author.memories.at(-1)!;
  appendGroupUserMessage(state, task, '第二条群消息');
  assert.equal(author.memories.length, 101); assert.equal(author.memories.at(-1)!.id, groupMemory.id);
  assert.match(groupMemory.content, /第二条群消息/); assert.ok(groupMemory.updatedAt); assert.ok(groupMemory.content.length <= 600);
  assert.equal(author.memories[0].content, '已有记忆0');
  assert.ok(taskGroupContext(state, task, author, 'source').longTermMemories.some(memory => memory.id === groupMemory.id));
});

test('a member can continue a real file as a new version with server-derived joint attribution', async () => {
  const { state, task, author } = fixture();
  const first = script([write('draft.md', '第一版'), finish('初稿已附上。', { kind: 'submit' }), approved]);
  await runGroupTurn(state, task, author, first.deps); const original = task.artifacts![0];
  const secondAuthor = state.agents[1];
  const second = script([{ type: 'tool', tool: 'code.run', input: { code: "emitFile('draft.md', files['draft.md'] + '\\n补充交通预算');", baseArtifactIds: [original.id] } }, finish('我在初稿上补充了预算。', { kind: 'submit' }), approved], { load: async artifact => first.stored.get(artifact.id)! });
  await runGroupTurn(state, task, secondAuthor, second.deps); const revision = task.artifacts![1];
  assert.notEqual(original.id, revision.id); assert.equal(original.name, revision.name); assert.equal(first.stored.get(original.id), '第一版');
  assert.equal(second.stored.get(revision.id), '第一版\n补充交通预算');
  assert.equal(revision.agentId, secondAuthor.id); assert.deepEqual(revision.contributorIds, [secondAuthor.id, author.id]); assert.deepEqual(revision.derivedFromIds, [original.id]);
  assert.deepEqual(state.events.at(-1)!.artifactIds, [revision.id]); assert.equal(revision.eventId, state.events.at(-1)!.id);
  assert.equal(second.calls[0].input.fileContents[0].content, '第一版');
  assert.match(secondAuthor.memories.find(memory => memory.source === `task-group:${task.id}`)!.content, /draft.md/);
});

test('invented or cross-task source IDs cannot produce attributed file versions', async () => {
  const { state, task, author } = fixture();
  const run = script([write('stolen.md', 'claim', ['foreign-artifact']), finish('没有找到可续写的文件。'), approved]);
  await runGroupTurn(state, task, author, run.deps);
  assert.equal(task.artifacts!.length, 0); assert.equal(task.toolRuns![0].status, 'error'); assert.match(task.toolRuns![0].error!, /本事务已有成果/);
  assert.equal(state.events.length, 1);
});

test('a request never implies acceptance and only its intended recipient can create cooperation', async () => {
  const { state, task, author } = fixture(); const [, b, c] = state.agents;
  await runGroupTurn(state, task, author, script([finish('请你帮我补充预算。', { kind: 'request', targetId: b.id }), approved]).deps);
  const request = state.events[0]; assert.equal(state.relationships.length, 0);
  const impostor = script([finish('我替她答应。', { kind: 'accept', replyTo: request.id, targetId: author.id }), finish('我先提供自己的想法。'), approved]);
  await runGroupTurn(state, task, c, impostor.deps);
  assert.match(impostor.calls[1].input.correction, /不能替别人接受/); assert.equal(state.relationships.length, 0);
  await runGroupTurn(state, task, b, script([finish('我愿意合作补充预算。', { kind: 'accept', replyTo: request.id }), approved]).deps);
  assert.equal(state.relationships.length, 1); assert.equal(state.relationships[0].kind, 'cooperation'); assert.equal(state.relationships[0].from, author.id); assert.equal(state.relationships[0].to, b.id);
  const duplicate = script([finish('再次接受。', { kind: 'accept', replyTo: request.id }), finish('已确认，开始整理。'), approved]);
  await runGroupTurn(state, task, b, duplicate.deps); assert.match(duplicate.calls[1].input.correction, /尚未处理/); assert.equal(state.relationships.length, 1);
});

test('a refusal resolves an explicit request without inventing a cooperation relationship', async () => {
  const { state, task, author } = fixture(); const b = state.agents[1];
  state.events.push(message(task, 'request-b', author.id, { kind: 'request', targetId: b.id }));
  await runGroupTurn(state, task, b, script([finish('这次我先不参与这部分。', { kind: 'refuse', replyTo: 'request-b' }), approved]).deps);
  assert.equal(state.relationships.length, 0); assert.equal(taskGroupContext(state, task, b, 'next').pendingRequests.length, 0);
});

test('image generation is independently reviewed and obeys the configured attempt limit', async () => {
  const { state, task, author } = fixture(); let imageCalls = 0;
  state.settings.groupImageLimit = 1;
  const image = { type: 'tool', tool: 'image.generate', input: { prompt: '旅行计划插图', referenceAgentId: author.id } };
  const run = script([image, approved, image, finish('已附上配图。', { kind: 'submit' }), approved], { image: async (_prompt, reference) => { imageCalls++; assert.equal(reference, author.id); return { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' }; } });
  await runGroupTurn(state, task, author, run.deps);
  assert.equal(imageCalls, 1); assert.equal(task.artifacts!.length, 1); assert.equal(task.artifacts![0].kind, 'image'); assert.equal(run.images.size, 1);
  assert.equal(task.toolRuns![1].status, 'error'); assert.match(task.toolRuns![1].error!, /图片尝试次数上限/);
  assert.equal(run.calls[1].system, 'task.group.review'); assert.equal(run.calls[1].input.candidate.tool, 'image.generate');
  assert.equal(run.calls[2].input.artifacts[0].visuallyObserved, false); assert.equal(run.calls[2].input.fileContents.length, 0);
  assert.deepEqual(state.events[0].artifactIds, [task.artifacts![0].id]); assert.equal(JSON.stringify(run.calls).includes('bytes'), false);
});

test('image failure or absence still permits a reviewed text response and records an honest error', async () => {
  for (const available of [false, true]) {
    const { state, task, author } = fixture(); let imageCalls = 0;
    const tool = { type: 'tool', tool: 'image.generate', input: { prompt: '示意图' } };
    const run = script([tool, ...(available ? [approved] : []), finish('图片暂时未能生成，我先解释思路。'), approved], { image: available ? async () => { imageCalls++; throw new Error('sk-DO-NOT-LEAK'); } : undefined });
    await runGroupTurn(state, task, author, run.deps);
    assert.equal(state.events[0].content, '图片暂时未能生成，我先解释思路。'); assert.equal(task.artifacts!.length, 0); assert.equal(task.toolRuns![0].status, 'error');
    assert.equal(imageCalls, Number(available)); assert.equal(JSON.stringify(state).includes('sk-DO-NOT-LEAK'), false);
  }
});

test('a rejected image instruction never triggers a paid image call', async () => {
  const { state, task, author } = fixture(); let calls = 0;
  const run = script([{ type: 'tool', tool: 'image.generate', input: { prompt: '与任务不符' } }, { pass: false, reason: '不符合任务及人设。' }, finish(), approved], { image: async () => { calls++; throw new Error('must not run'); } });
  await runGroupTurn(state, task, author, run.deps); assert.equal(calls, 0); assert.match(task.toolRuns![0].error!, /未通过审校/);
});

test('stored artifacts survive model failure or repeated review failure as system attachments, not fabricated member speech', async () => {
  for (const responses of [[new Error('provider failed')], [finish('不真实的声明。'), { pass: false, reason: '不实。' }, finish('仍然不实。'), { pass: false, reason: '不实。' }]]) {
    const { state, task, author } = fixture(); const run = script([write(), ...responses]);
    const result = await runGroupTurn(state, task, author, run.deps);
    assert.ok(result); assert.equal(task.artifacts!.length, 1); assert.equal(state.events.length, 1); assert.equal(state.events[0].actorType, 'system'); assert.equal(state.events[0].agentId, 'system');
    assert.deepEqual(state.events[0].artifactIds, [task.artifacts![0].id]); assert.equal(task.artifacts![0].eventId, state.events[0].id);
    assert.match(state.agents[1].memories[0].content, /draft.md/); assert.equal(state.events[0].content.includes('不真实的声明'), false);
  }
});

test('file storage failure exposes no download metadata and allows text recovery', async () => {
  const { state, task, author } = fixture(); const run = script([write(), finish('文件保存失败，先给出文字说明。'), approved], { store: async () => { throw new Error('disk full'); } });
  await runGroupTurn(state, task, author, run.deps); assert.equal(task.artifacts!.length, 0); assert.equal(task.toolRuns![0].status, 'error'); assert.deepEqual(state.events[0].artifactIds, []);
});

test('memory sources and strategy changes are validated before learning, and other members learn only the public group summary', async () => {
  const { state, task, author } = fixture(); const oldStrategy = author.strategy;
  const run = script([finish('共享回答', { memories: [{ kind: 'experience', content: '我读取过他人私聊', source: 'unseen-private' }], revisedStrategy: '不应提交' }), finish('已确认交通优先。', { memories: [{ kind: 'preference', content: '用户关注交通费用。', source: 'user-source' }], revisedStrategy: '先核对成本再提出建议。' }), approved]);
  state.events.push(message(task, 'user-source', 'user', { actorType: 'user', content: '关注交通费用。' }));
  await runGroupTurn(state, task, author, run.deps);
  assert.match(run.calls[1].input.correction, /记忆只能引用/); assert.notEqual(author.strategy, oldStrategy); assert.equal(author.strategy, '先核对成本再提出建议。');
  assert.ok(author.memories.some(memory => memory.kind === 'preference' && memory.source === 'user-source'));
  assert.equal(state.agents[1].memories.some(memory => memory.kind === 'preference'), false); assert.equal(JSON.stringify(author.memories).includes('我读取过他人私聊'), false);
});

test('rejected actions do not change strategy or create unreviewed learned memories', async () => {
  const { state, task, author } = fixture(); const strategy = author.strategy;
  const run = script([finish('不实', { revisedStrategy: '恶意新策略' }), { pass: false, reason: '不实' }, finish('不实2', { revisedStrategy: '第二策略' }), { pass: false, reason: '仍不实' }]);
  await runGroupTurn(state, task, author, run.deps); assert.equal(author.strategy, strategy);
  assert.equal(state.events.length, 1); assert.equal(state.events[0].actorType, 'system'); assert.equal(author.memories.length, 1);
  assert.equal(author.memories[0].source, `task-group:${task.id}`); assert.equal(author.memories[0].content.includes('恶意新策略'), false);
});

test('configured tool and correction budgets prevent extra calls after a finite limit', async () => {
  const { state, task, author } = fixture(); let searches = 0;
  state.settings.groupToolLimit = 4;
  const run = script(Array.from({ length: 9 }, () => ({ type: 'tool', tool: 'web.search', input: { query: '攻略' } })), { search: async () => { searches++; return []; } });
  await runGroupTurn(state, task, author, run.deps);
  assert.equal(searches, 4); assert.equal(task.toolRuns!.length, 4); assert.equal(run.calls.length, 5); assert.equal(run.calls.at(-1)!.input.mustFinish, true);
  assert.equal(task.groupTurn, undefined);
  assert.ok(run.calls.every(call => call.timeout > 0 && call.timeout <= 42_000));
  const broken = fixture(); const malformed = script([{ impossible: true }, { impossible: true }, finish(), approved]);
  await runGroupTurn(broken.state, broken.task, broken.author, malformed.deps); assert.equal(malformed.calls.length, 2);
  assert.equal(broken.state.events.length, 1); assert.equal(broken.state.events[0].actorType, 'system'); assert.deepEqual(broken.state.events[0].artifactIds, []);
});

test('history and shared text context are bounded and image data is never loaded as text', async () => {
  const { state, task, author } = fixture();
  state.events = Array.from({ length: 40 }, (_, index) => message(task, `message-${index}`, author.id));
  const artifact = (index: number, kind: 'file' | 'image' = 'file'): TaskArtifact => ({ id: `file-${index}`, name: `${index}.txt`, kind, mimeType: kind === 'image' ? 'image/png' : 'text/plain', agentId: author.id, size: 9000, url: `/api/artifacts/file-${index}`, createdAt: NOW });
  task.artifacts = [...Array.from({ length: 8 }, (_, index) => artifact(index)), artifact(9, 'image')];
  let reads = 0; const run = script([finish(), approved], { load: async item => { reads++; assert.notEqual(item.kind, 'image'); return 'x'.repeat(9000); } });
  await runGroupTurn(state, task, author, run.deps);
  assert.equal(run.calls[0].input.messages.length, 30); assert.ok(reads <= 5); assert.equal(run.calls[0].input.fileContents.reduce((sum: number, file: { content: string }) => sum + file.content.length, 0), 12_000);
});

test('SVG artifacts remain readable text and can be continued through the code interpreter', async () => {
  const { state, task, author } = fixture();
  const first = script([write('diagram.svg', '<svg><!--original--></svg>'), finish(), approved]);
  await runGroupTurn(state, task, author, first.deps); const svg = task.artifacts![0];
  const second = script([{ type: 'tool', tool: 'code.run', input: { code: "emitFile('diagram.svg', files['diagram.svg'].replace('original', 'revised'));", baseArtifactIds: [svg.id] } }, finish(), approved], { load: async artifact => first.stored.get(artifact.id)! });
  await runGroupTurn(state, task, state.agents[1], second.deps);
  assert.equal(second.calls[0].input.fileContents[0].content, '<svg><!--original--></svg>');
  assert.equal(task.toolRuns!.at(-1)!.status, 'ok'); assert.equal(second.stored.get(task.artifacts![1].id), '<svg><!--revised--></svg>');
});

test('archived and nonparticipating members cannot execute group turns', async () => {
  const { state, task, author } = fixture(); author.archivedAt = NOW;
  await assert.rejects(runGroupTurn(state, task, author, script([]).deps), /本群当前在庭成员/);
  await assert.rejects(runGroupTurn(state, task, state.agents[3], script([]).deps), /本群当前在庭成员/);
});

test('unlimited tools yield durable chunks and resume the same turn without duplicate artifacts', async () => {
  const { state, task, author } = fixture();
  const run = script([...Array.from({ length: 9 }, (_, index) => write(`part-${index}.md`, `第${index}份`)), finish('九份资料已经保存。'), approved]);
  await runGroupTurn(state, task, author, run.deps);
  assert.equal(run.calls.length, GROUP_REQUEST_TOOL_LIMIT);
  assert.equal(task.groupTurn?.toolCalls, 4); assert.equal(task.artifacts!.length, 4);
  assert.equal(state.events.length, 0); assert.equal(task.cursor, 0);
  assert.equal(run.calls[0].input.maxToolCalls, 0); assert.equal(run.calls[0].input.remainingToolCalls, null);
  assert.equal(run.calls[0].input.mustFinish, false);
  const eventId = task.groupTurn!.eventId;
  assert.ok(author.memories.some(memory => memory.source === `task-group:${task.id}` && memory.content.includes('part-3.md')));
  const restored = structuredClone(state), restoredTask = restored.tasks[0], restoredAuthor = restored.agents[0];
  await runGroupTurn(restored, restoredTask, restoredAuthor, run.deps);
  assert.equal(restoredTask.groupTurn?.toolCalls, 8); assert.equal(restoredTask.groupTurn?.eventId, eventId);
  await runGroupTurn(restored, restoredTask, restoredAuthor, run.deps);
  assert.equal(restoredTask.groupTurn, undefined); assert.equal(restoredTask.artifacts!.length, 9);
  assert.equal(restored.events.length, 1); assert.equal(restored.events[0].id, eventId);
  assert.deepEqual(restored.events[0].artifactIds, restoredTask.artifacts!.map(item => item.id));
  assert.ok(restoredTask.artifacts!.every(item => item.eventId === eventId));
});

test('finite tool and image budgets survive a persisted continuation and cannot be reset by a new request', async () => {
  const { state, task, author } = fixture();
  state.settings.groupToolLimit = 6; state.settings.groupImageLimit = 1;
  const image = { type: 'tool', tool: 'image.generate', input: { prompt: '插图' } };
  let images = 0;
  const run = script([image, approved, write(), write(), write(), image, write(), finish(), approved], { image: async () => { images++; return { bytes: new Uint8Array([1]), contentType: 'image/png' }; } });
  await runGroupTurn(state, task, author, run.deps);
  assert.equal(task.groupTurn?.toolCalls, 4); assert.equal(task.groupTurn?.imageCalls, 1);
  const restored = structuredClone(state);
  await runGroupTurn(restored, restored.tasks[0], restored.agents[0], run.deps);
  assert.equal(images, 1); assert.equal(restored.tasks[0].toolRuns!.length, 6);
  assert.equal(restored.tasks[0].toolRuns![4].status, 'error');
  assert.equal(run.calls.at(-2)!.input.mustFinish, true);
  assert.equal(run.calls.at(-2)!.input.remainingToolCalls, 0);
  assert.equal(restored.tasks[0].groupTurn, undefined);
});

test('image and artifact counts are unlimited by default while configurable artifact limits apply before paid calls', async () => {
  const { state, task, author } = fixture();
  const image = { type: 'tool', tool: 'image.generate', input: { prompt: '插图' } };
  const run = script([image, approved, image, approved, finish(), approved]);
  await runGroupTurn(state, task, author, run.deps);
  assert.equal(run.images.size, 2);
  const original: TaskArtifact = task.artifacts![0];
  task.artifacts = Array.from({ length: 31 }, (_, index) => ({ ...original, id: `old-${index}` }));
  await runGroupTurn(state, task, author, script([write(), finish(), approved]).deps);
  assert.equal(task.artifacts.length, 32);
  state.settings.groupArtifactLimit = 32;
  let paidCalls = 0;
  await runGroupTurn(state, task, author, script([image, finish(), approved], { image: async () => { paidCalls++; throw new Error('must not run'); } }).deps);
  assert.equal(paidCalls, 0); assert.equal(task.artifacts.length, 32);
  assert.match(task.toolRuns!.at(-1)!.error!, /成果版本上限/);
  assert.equal(taskGroupContext(state, task, author, 'next').artifacts.length, 30);
});

test('historical tool records persist beyond sixty entries and learned memories obey an optional limit', async () => {
  const { state, task, author } = fixture();
  task.toolRuns = Array.from({ length: 60 }, (_, index) => ({ id: `old-tool-${index}`, agentId: author.id, tool: 'web.search', inputSummary: '旧检索', status: 'ok', createdAt: NOW }));
  state.settings.memoryLimit = 1;
  author.memories.push({ id: 'kept', kind: 'experience', content: '保留的个人记忆', source: 'kept-source', createdAt: NOW });
  state.events.push(message(task, 'user-source', 'user', { actorType: 'user' }));
  const action = finish('已核对', { memories: [{ kind: 'experience', content: '新学习', source: 'user-source' }] });
  await runGroupTurn(state, task, author, script([write(), action, approved]).deps);
  assert.equal(task.toolRuns.length, 61); assert.equal(task.toolRuns[0].id, 'old-tool-0');
  assert.equal(author.memories.some(memory => memory.content === '新学习'), false);
  state.settings.memoryLimit = 0;
  await runGroupTurn(state, task, author, script([action, approved]).deps);
  assert.equal(author.memories.some(memory => memory.content === '新学习'), true);
});

test('an unlimited tool turn reports failure when a whole chunk fails instead of endlessly scheduling more paid requests', async () => {
  const { state, task, author } = fixture();
  const run = script(Array.from({ length: 9 }, () => ({ type: 'tool', tool: 'web.search', input: { query: '重试检索' } })), { search: async () => { throw new Error('unavailable'); } });
  const failure = await runGroupTurn(state, task, author, run.deps);
  assert.match(failure!, /工具均未成功/); assert.equal(run.calls.length, 4);
  assert.equal(task.groupTurn, undefined); assert.equal(task.toolRuns!.length, 4);
  assert.equal(state.events.length, 1); assert.equal(state.events[0].actorType, 'system');
});
