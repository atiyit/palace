import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { AppState, Task } from '../lib/types.ts';
import type { ActivityStatus } from '../lib/server/activity-runner.ts';

const prefix = 'palace-activity-api-test-', fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
const oldDirectory = process.env.PALACE_DATA_DIR; process.env.PALACE_DATA_DIR = join(fixtureRoot, 'isolated-data');
const project = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({ configFile: join(project, 'local/vite.config.ts'), server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
await vite.ssrLoadModule(join(project, 'local/runtime.ts'));
if (oldDirectory === undefined) delete process.env.PALACE_DATA_DIR; else process.env.PALACE_DATA_DIR = oldDirectory;
const { withLocalRequest } = await vite.ssrLoadModule(join(project, 'local/auth.ts'));
const api = await vite.ssrLoadModule(join(project, 'app/api/activity/route.ts'));
const palace = await vite.ssrLoadModule(join(project, 'app/api/palace/route.ts'));
const { activityRunner } = await vite.ssrLoadModule(join(project, 'lib/server/activity-runner.ts'));
const { saveProviderSettings } = await vite.ssrLoadModule(join(project, 'lib/server/provider-settings.ts'));
const { mutateState, readState } = await vite.ssrLoadModule(join(project, 'lib/server/store.ts'));
const { createInitialState } = await vite.ssrLoadModule(join(project, 'lib/seeds.ts'));
const owner = 'local-owner', origin = 'http://127.0.0.1:5199';
const originalFetch = globalThis.fetch, calls: unknown[] = [], responses: Array<unknown | (() => Promise<unknown>)> = [];
globalThis.fetch = async (url, init) => {
  assert.equal(String(url), 'https://activity-model.example.test/v1/chat/completions');
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer activity-test-only');
  assert.equal(init?.redirect, 'manual');
  calls.push(JSON.parse(String(init?.body)));
  assert.ok(responses.length, '不允许没有脚本响应的模型请求');
  const next = responses.shift();
  const value = typeof next === 'function' ? await next() : next;
  return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }], usage: { total_tokens: 20 } });
};
await saveProviderSettings(owner, 'text', { baseUrl: 'https://activity-model.example.test/v1', model: 'activity-fixture', apiKey: 'activity-test-only' });
await mutateState(owner, crypto.randomUUID(), createInitialState, async (state: AppState) => { state.agents = state.agents.slice(0, 1); state.agents[0].hired = true; });

after(async context => {
  const active = activityRunner.snapshot(owner);
  if (active && activityRunner.active(owner)) activityRunner.pause(owner, active.id);
  await activityRunner.settled(owner);
  globalThis.fetch = originalFetch; await vite.close();
  if (!existsSync(fixtureRoot)) return;
  const target = realpathSync(fixtureRoot); assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith(prefix));
  try { rmSync(target, { recursive: true, force: true }); }
  catch (error) { if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error; if ('diagnostic' in context) context.diagnostic('Only this isolated fixture may remain locked until SQLite exits.'); }
});

async function post(body: object, headers: Record<string, string> = {}) {
  const response: Response = await withLocalRequest(() => api.POST(new Request(origin + '/api/activity', { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })));
  return { status: response.status, value: await response.json() as { activity?: ActivityStatus; error?: string } };
}
async function palaceAction(action: string, payload: object = {}) {
  const response: Response = await withLocalRequest(() => palace.POST(new Request(origin + '/api/palace', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action, requestId: crypto.randomUUID(), ...payload }) })));
  return { status: response.status, value: await response.json() as { state?: AppState; code?: string; error?: string } };
}
const state = (): Promise<AppState> => readState(owner, createInitialState);
const speech = { kind: 'chat', content: '今天想和大家聊聊庭院中的花。', memories: [] };
const approved = { pass: true, reason: '符合人设与实际信息。' };

test('activity endpoints enforce authentication, origin, complete input and owner-scoped job ids', async () => {
  assert.equal((await api.GET()).status, 401);
  assert.equal((await api.POST(new Request(origin + '/api/activity', { method: 'POST' }))).status, 401);
  assert.equal((await post({ action: 'start', kind: 'daily', steps: 1 }, { origin: 'https://evil.example.test' })).status, 403);
  assert.equal((await post({ action: 'start', kind: 'daily', steps: 1 }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ action: 'start', kind: 'daily', steps: 1 }, { 'content-type': 'text/plain' })).status, 415);
  for (const body of [{ action: 'start', kind: 'daily', steps: -1 }, { action: 'start', kind: 'daily', steps: 1.1 }, { action: 'start', kind: 'daily', extra: true }, { action: 'start', kind: 'task', taskId: '' }]) assert.equal((await post(body)).status, 400);
  assert.equal((await post({ action: 'pause', id: crypto.randomUUID() })).status, 409);
  assert.equal(calls.length, 0);
});

test('one hired member can complete background daily turns after the start response and persist both', async () => {
  const before = calls.length;
  responses.push(speech, approved, speech, approved);
  const started = await post({ action: 'start', kind: 'daily', topic: '庭院中的花', steps: 2 });
  assert.equal(started.status, 200); assert.equal(started.value.activity!.status, 'running');
  assert.equal('action' in started.value.activity!, false);
  const duplicate = await post({ action: 'start', kind: 'daily', steps: 1 }); assert.equal(duplicate.status, 409);
  await activityRunner.settled(owner);
  const statusResponse: Response = await withLocalRequest(() => api.GET());
  const status = (await statusResponse.json() as { activity: ActivityStatus }).activity;
  assert.equal(status.status, 'completed'); assert.equal(status.done, 2);
  assert.equal(calls.length - before, 4);
  const saved = await state(); assert.equal(saved.dailyEvents!.length, 2); assert.equal(saved.dailyTurn, 2);
  assert.ok(saved.dailyEvents!.every(event => event.checked && event.agentId === saved.agents[0].id));
});

test('a rejected daily turn is saved once, reports failure, and never restarts an unlimited activity', async () => {
  const before = calls.length;
  responses.push(speech, { pass: false, reason: '测试审校拒绝' }, speech, { pass: false, reason: '测试审校拒绝' });
  assert.equal((await post({ action: 'start', kind: 'daily', steps: 0 })).status, 200);
  await activityRunner.settled(owner);
  const status = activityRunner.snapshot(owner);
  assert.equal(status.status, 'failed'); assert.equal(status.done, 0); assert.match(status.error, /未通过/);
  assert.equal(calls.length - before, 4); assert.equal((await state()).dailyEvents!.at(-1)!.checked, false);
});

test('background task continues after four tools without counting the partial turn as complete', async () => {
  await mutateState(owner, crypto.randomUUID(), createInitialState, async (saved: AppState) => {
    const member = saved.agents[0].id;
    saved.settings.groupToolLimit = 0; saved.settings.groupArtifactLimit = 0;
    const task: Task = { id: 'background-task', mode: 'group', title: '整理四份小笔记', status: 'running', rounds: 1, round: 1, participants: [member], order: [member], cursor: 0, createdAt: new Date().toISOString() };
    saved.tasks.push(task);
  });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  for (let i = 0; i < 4; i++) responses.push({ type: 'tool', tool: 'file.write', input: { name: `note-${i}.md`, content: `# Note ${i}` } });
  responses.push(async () => { entered.resolve(); await release.promise; return { type: 'finish', kind: 'submit', content: '四份笔记已经保存。' }; }, approved);
  const started = await post({ action: 'start', kind: 'task', taskId: 'background-task', steps: 0 }); assert.equal(started.status, 200);
  try {
    await Promise.race([entered.promise, activityRunner.settled(owner).then(() => { throw new Error('后台任务未进入第二段工具请求'); })]);
    const partial = (await state()).tasks.find(task => task.id === 'background-task')!;
    assert.equal(partial.groupTurn!.toolCalls, 4); assert.equal(partial.artifacts!.length, 4);
    assert.equal(activityRunner.snapshot(owner).done, 0);
  } finally { release.resolve(); }
  await activityRunner.settled(owner);
  assert.equal(activityRunner.snapshot(owner).done, 1); assert.equal(activityRunner.snapshot(owner).status, 'completed');
  const completed = (await state()).tasks.find(task => task.id === 'background-task')!;
  assert.equal(completed.status, 'completed'); assert.equal(completed.groupTurn, undefined);
});

test('background task failure retains its failure event and pauses further scheduling', async () => {
  await mutateState(owner, crypto.randomUUID(), createInitialState, async (saved: AppState) => {
    const task = saved.tasks.find(item => item.id === 'background-task')!;
    task.status = 'running'; task.rounds = 0; task.round = 1; task.cursor = 0; delete task.completedAt;
  });
  const before = calls.length;
  responses.push({ invalid: true }, { invalid: true });
  assert.equal((await post({ action: 'start', kind: 'task', taskId: 'background-task', steps: 0 })).status, 200);
  await activityRunner.settled(owner);
  assert.equal(activityRunner.snapshot(owner).status, 'failed'); assert.equal(activityRunner.snapshot(owner).done, 0);
  assert.equal(calls.length - before, 2);
  const saved = await state(); const task = saved.tasks.find(item => item.id === 'background-task')!;
  assert.equal(task.status, 'paused'); assert.match(saved.events.at(-1)!.content, /结构检查/);
});

test('a task paused by another request stays paused after the current background step', async () => {
  const before = calls.length, waiting = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  const originalStart = activityRunner.start;
  activityRunner.start = (owner: string, request: unknown, deps: any) => originalStart(owner, request, { ...deps, delay: async () => { waiting.resolve(); await released.promise; } });
  responses.push({ type: 'finish', kind: 'propose', content: '这一步已完成。', memories: [] }, approved);
  try {
    const started = await post({ action: 'start', kind: 'task', taskId: 'background-task', steps: 0 });
    assert.equal(started.status, 200);
    await Promise.race([waiting.promise, activityRunner.settled(owner).then(() => { throw new Error('未进入分步间隔'); })]);
    const paused = await palaceAction('task.pause', { taskId: 'background-task' }); assert.equal(paused.status, 200);
    assert.equal(paused.value.state!.tasks.find(task => task.id === 'background-task')!.status, 'paused');
  } finally { released.resolve(); activityRunner.start = originalStart; }
  await activityRunner.settled(owner);
  assert.equal(calls.length - before, 2); assert.equal(activityRunner.snapshot(owner).status, 'paused');
  assert.equal(activityRunner.snapshot(owner).done, 1); assert.equal((await state()).tasks.find(task => task.id === 'background-task')!.status, 'paused');
});

test('activity GET discards an old task snapshot when its stored task no longer exists', async () => {
  await mutateState(owner, crypto.randomUUID(), createInitialState, async (saved: AppState) => { saved.tasks = saved.tasks.filter(task => task.id !== 'background-task'); });
  const response: Response = await withLocalRequest(() => api.GET());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { activity: null });
  assert.equal(activityRunner.snapshot(owner), null);
});

test('clear-all rejects an active job and discards its completed or paused summary after successful clearing', async () => {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
  responses.push(async () => { entered.resolve(); await released.promise; return speech; }, approved);
  const started = await post({ action: 'start', kind: 'daily', topic: '清档前的私人话题', steps: 0 }); assert.equal(started.status, 200);
  try {
    await entered.promise;
    const refused = await palaceAction('data.clear', { confirmation: '清除所有数据' });
    assert.equal(refused.status, 409); assert.equal(refused.value.code, 'ACTIVITY_RUNNING');
    assert.equal(activityRunner.active(owner), true);
    assert.equal((await post({ action: 'pause', id: started.value.activity!.id })).status, 200);
  } finally { released.resolve(); }
  await activityRunner.settled(owner);
  assert.equal(activityRunner.snapshot(owner).status, 'paused');
  assert.equal((await palaceAction('data.clear', { confirmation: '错误确认' })).status, 400);
  assert.notEqual(activityRunner.snapshot(owner), null, 'failed clear must preserve activity status');
  const cleared = await palaceAction('data.clear', { confirmation: '清除所有数据' }); assert.equal(cleared.status, 200);
  assert.equal(cleared.value.state!.agents.length, 0); assert.equal(activityRunner.snapshot(owner), null);
  const response: Response = await withLocalRequest(() => api.GET()); assert.deepEqual(await response.json(), { activity: null });
});
