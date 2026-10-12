import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import sharp from 'sharp';
import type { AppState, Task } from '../lib/types.ts';
import type { DebugResult } from '../lib/debug-types.ts';

// Real SQLite, route handlers, provider serialization and object storage, with every HTTP call mocked.
// The directory is fresh and isolated: this suite never reads or writes the user's local save.
const prefix = 'palace-group-api-test-';
const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
const oldDirectory = process.env.PALACE_DATA_DIR;
process.env.PALACE_DATA_DIR = join(fixtureRoot, 'isolated-data');
const project = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({ configFile: join(project, 'local/vite.config.ts'), server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
const { env } = await vite.ssrLoadModule(join(project, 'local/runtime.ts'));
if (oldDirectory === undefined) delete process.env.PALACE_DATA_DIR; else process.env.PALACE_DATA_DIR = oldDirectory;
const { withLocalRequest } = await vite.ssrLoadModule(join(project, 'local/auth.ts'));
const palace = await vite.ssrLoadModule(join(project, 'app/api/palace/route.ts'));
const artifacts = await vite.ssrLoadModule(join(project, 'app/api/artifacts/[id]/route.ts'));
const debug = await vite.ssrLoadModule(join(project, 'app/api/debug/route.ts'));
const { mutateState } = await vite.ssrLoadModule(join(project, 'lib/server/store.ts'));
const { createInitialState } = await vite.ssrLoadModule(join(project, 'lib/seeds.ts'));
const { saveProviderSettings } = await vite.ssrLoadModule(join(project, 'lib/server/provider-settings.ts'));
const origin = 'http://127.0.0.1:5199', userId = 'local-owner';
const textEndpoint = 'https://group-text.invalid/v1/chat/completions', imageEndpoint = 'https://group-image.invalid/v1/images/generations';
const outputImage = new Uint8Array(await sharp({ create: { width: 3, height: 4, channels: 3, background: '#318A77' } }).png().toBuffer());
const originalFetch = globalThis.fetch;
const calls: { url: string; body: any }[] = [];
const responses: unknown[] = [];
let imageAllowed = false;
globalThis.fetch = async (url, init) => {
  const target = url instanceof Request ? url.url : String(url);
  assert.ok([textEndpoint, imageEndpoint].includes(target), `unexpected network destination ${target}`);
  assert.equal(init?.method, 'POST'); const body = JSON.parse(String(init?.body)); calls.push({ url: target, body });
  if (target === imageEndpoint) {
    assert.equal(imageAllowed, true, 'unexpected image request');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer group-image-test-only');
    return Response.json({ data: [{ b64_json: Buffer.from(outputImage).toString('base64') }] });
  }
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer group-text-test-only');
  assert.ok(responses.length, 'unexpected model call: scripted responses exhausted');
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(responses.shift()) } }], usage: { total_tokens: 10 } });
};

after(async context => {
  globalThis.fetch = originalFetch; await vite.close();
  if (!existsSync(fixtureRoot)) return;
  const target = realpathSync(fixtureRoot);
  assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith(prefix));
  try { rmSync(target, { recursive: true, force: true }); }
  catch (error) {
    if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    if ('diagnostic' in context) context.diagnostic('Only this test fixture may remain locked until the SQLite worker exits.');
  }
});

interface ActionResult { state: AppState; taskId?: string; message?: string; code?: string; replayed?: boolean; }
async function post<T>(module: Record<string, any>, path: string, body: object) {
  const response: Response = await withLocalRequest(() => module.POST(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })));
  return { status: response.status, value: await response.json() as T };
}
const act = (action: string, body: object = {}) => post<ActionResult>(palace, '/api/palace', { action, requestId: crypto.randomUUID(), ...body });
async function getState(): Promise<AppState> { const response: Response = await withLocalRequest(() => palace.GET()); assert.equal(response.status, 200); return response.json(); }
const getArtifact = (id: string, inline = false): Promise<Response> => withLocalRequest(() => artifacts.GET(new Request(`${origin}/api/artifacts/${id}${inline ? '?inline=1' : ''}`), { params: Promise.resolve({ id }) }));
const approved = { pass: true, reason: '与真实成果和角色一致。' };
const finish = (content = '文件和配图已附在这一条群消息中。') => ({ type: 'finish', kind: 'submit', content, memories: [] });
const write = (name = 'travel.md', content = '# 路线\n步行游览公园。') => ({ type: 'tool', tool: 'file.write', input: { name, content } });
const image = { type: 'tool', tool: 'image.generate', input: { prompt: 'A simple illustrated walking map, green park, safe public paths.' } };
let taskId = '';

test('real group routes create shared memories and return actual file and inline-image attachments', async () => {
  const initial = await getState();
  await saveProviderSettings(userId, 'text', { baseUrl: 'https://group-text.invalid/v1', model: 'group-test-text', apiKey: 'group-text-test-only' });
  await saveProviderSettings(userId, 'image', { baseUrl: 'https://group-image.invalid/v1', model: 'nai-diffusion-4-5-full', apiKey: 'group-image-test-only' });
  for (const member of initial.agents.slice(0, 2)) assert.equal((await act('hire', { agentId: member.id })).status, 200);
  const created = await act('task.create', { title: '请一起制作公园路线的文字文件和插图。', rounds: 1 });
  assert.equal(created.status, 200); taskId = created.value.taskId!;
  const task = created.value.state.tasks.find(item => item.id === taskId)!;
  assert.equal(task.mode, 'group'); assert.equal(task.participants.length, 2); assert.equal(task.cursor, 0);
  assert.equal(created.value.state.events.length, 1); assert.equal(created.value.state.events[0].actorType, 'user');
  for (const id of task.participants) assert.match(created.value.state.agents.find(agent => agent.id === id)!.memories.find(memory => memory.source === `task-group:${taskId}`)!.content, /公园路线/);
  assert.equal(calls.length, 0, 'creating the group and posting its initial request makes no provider call');
  responses.push(write(), image, approved, finish(), approved); imageAllowed = true;
  const stepped = await act('task.step', { taskId }); imageAllowed = false;
  assert.equal(stepped.status, 200); assert.equal(responses.length, 0);
  const updated = stepped.value.state.tasks.find(item => item.id === taskId)!;
  assert.equal(updated.cursor, 1); assert.equal(updated.artifacts!.length, 2); assert.equal(updated.toolRuns!.length, 2);
  const file = updated.artifacts!.find(item => item.kind === 'file')!, picture = updated.artifacts!.find(item => item.kind === 'image')!;
  const event = stepped.value.state.events.at(-1)!;
  assert.equal(event.actorType, 'agent'); assert.deepEqual(event.artifactIds, [file.id, picture.id]); assert.equal(event.checked, true);
  assert.equal(file.eventId, event.id); assert.equal(picture.eventId, event.id);
  const downloaded = await getArtifact(file.id); assert.equal(downloaded.status, 200); assert.equal(await downloaded.text(), '# 路线\n步行游览公园。');
  assert.match(downloaded.headers.get('content-disposition')!, /^attachment/); assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
  const inline = await getArtifact(picture.id, true); assert.equal(inline.status, 200); assert.equal(inline.headers.get('content-type'), 'image/png');
  assert.match(inline.headers.get('content-disposition')!, /^inline/); assert.deepEqual(new Uint8Array(await inline.arrayBuffer()), outputImage);
  assert.match((await getArtifact(picture.id)).headers.get('content-disposition')!, /^attachment/);
  assert.match((await getArtifact(file.id, true)).headers.get('content-disposition')!, /^attachment/, 'text files cannot request active inline rendering');
  await env.BUCKET.put('artifacts/another-owner/foreign-file', new TextEncoder().encode('private'));
  assert.equal((await getArtifact('foreign-file')).status, 404, 'unreferenced foreign artifacts never download');
  const textCalls = calls.filter(call => call.url === textEndpoint);
  assert.equal(textCalls.length, 5); assert.equal(calls.filter(call => call.url === imageEndpoint).length, 1);
  assert.equal(JSON.parse(textCalls[0].body.messages[1].content).mode, 'task-group');
  assert.equal(JSON.stringify(stepped.value.state).includes('group-text-test-only'), false);
  for (const id of task.participants) assert.match(stepped.value.state.agents.find(agent => agent.id === id)!.memories.find(memory => memory.source === `task-group:${taskId}`)!.content, /travel.md/);
  responses.push(finish('我看到了初稿与配图，建议增加雨天备选路线。'), approved);
  const lastTurn = await act('task.step', { taskId }); assert.equal(lastTurn.status, 200);
  assert.equal(lastTurn.value.state.tasks.find(item => item.id === taskId)!.status, 'completed');
  const nextInput = JSON.parse(calls.filter(call => call.url === textEndpoint).at(-2)!.body.messages[1].content);
  assert.ok(nextInput.messages.some((item: { id: string }) => item.id === event.id)); assert.equal(nextInput.fileContents[0].content, '# 路线\n步行游览公园。');
});

test('completed group messages extend rounds once, paused resumes preserve schedule, and pure continuation adds no invented user message', async () => {
  const before = await getState(), initial = before.tasks.find(task => task.id === taskId)!;
  assert.equal(initial.status, 'completed'); const beforeCalls = calls.length;
  const requestId = crypto.randomUUID();
  const addition = await act('task.message', { taskId, message: '请继续加入雨天方案。', rounds: 3, requestId });
  assert.equal(addition.status, 200); const next = addition.value.state.tasks.find(task => task.id === taskId)!;
  assert.equal(next.status, 'paused'); assert.equal(next.round, 2); assert.equal(next.rounds, 4); assert.equal(next.cursor, 0); assert.equal(next.completedAt, undefined);
  assert.equal(addition.value.state.events.at(-1)!.actorType, 'user'); assert.equal(addition.value.state.events.at(-1)!.content, '请继续加入雨天方案。');
  const replay = await act('task.message', { taskId, message: '请继续加入雨天方案。', rounds: 3, requestId });
  assert.equal(replay.status, 200); assert.equal(replay.value.replayed, true); assert.equal(replay.value.state.events.length, addition.value.state.events.length); assert.equal(replay.value.state.tasks.find(task => task.id === taskId)!.rounds, 4);
  assert.equal((await act('task.resume', { taskId })).status, 200);
  assert.equal((await act('task.pause', { taskId })).status, 200);
  const resumed = await act('task.resume', { taskId }); assert.equal(resumed.value.state.tasks.find(task => task.id === taskId)!.rounds, 4);
  const whileRunning = await act('task.message', { taskId, message: '优先控制预算。', rounds: 3 });
  assert.equal(whileRunning.value.state.tasks.find(task => task.id === taskId)!.rounds, 4, 'posting during an unfinished round does not silently add rounds');
  await mutateState(userId, crypto.randomUUID(), createInitialState, async (saved: AppState) => {
    const task = saved.tasks.find(item => item.id === taskId)!; task.status = 'completed'; task.round = task.rounds; task.cursor = task.order.length; task.completedAt = new Date().toISOString();
  });
  const beforeContinue = await getState();
  const continued = await act('task.continue', { taskId, rounds: 2 }); assert.equal(continued.status, 200);
  const task = continued.value.state.tasks.find(item => item.id === taskId)!;
  assert.equal(task.round, 5); assert.equal(task.rounds, 6); assert.equal(task.status, 'paused'); assert.equal(task.cursor, 0);
  assert.equal(continued.value.state.events.length, beforeContinue.events.length, 'pure continuation must not impersonate a user message');
  assert.equal(calls.length, beforeCalls, 'schedule and user-message actions do not incur model costs');
});

test('group debug preview and execution use isolated artifacts without writing state or the real bucket', async () => {
  const before = await getState(); const member = before.tasks.find(task => task.id === taskId)!.order[0];
  const bucketBefore = await env.BUCKET.list({ prefix: `artifacts/${userId}/` });
  const countBefore = calls.length;
  const preview = await post<DebugResult>(debug, '/api/debug', { action: 'preview', stage: 'task', taskId, agentId: member });
  assert.equal(preview.status, 200); assert.equal(preview.value.status, 'preview'); assert.equal(preview.value.trace.length, 1);
  assert.equal(calls.length, countBefore); assert.deepEqual(await getState(), before);
  const originalPut = env.BUCKET.put.bind(env.BUCKET); let writes = 0;
  env.BUCKET.put = async () => { writes++; throw new Error('debug must not write durable storage'); };
  let result: { status: number; value: DebugResult };
  try {
    responses.push(write('sandbox-only.md', '沙盒草稿'), image, approved, finish('沙盒结果已生成。'), approved); imageAllowed = true;
    result = await post<DebugResult>(debug, '/api/debug', { action: 'run', stage: 'task', taskId, agentId: member });
  } finally { imageAllowed = false; env.BUCKET.put = originalPut; }
  assert.equal(result.status, 200); assert.equal(result.value.status, 'ok'); assert.equal(result.value.persisted, false); assert.equal(responses.length, 0);
  assert.equal(writes, 0); assert.deepEqual(await getState(), before);
  const after = await env.BUCKET.list({ prefix: `artifacts/${userId}/` }); assert.deepEqual(after.objects.map((item: { key: string }) => item.key).sort(), bucketBefore.objects.map((item: { key: string }) => item.key).sort());
  const output = result.value.output as { task: Task; events: { artifactIds?: string[] }[] };
  const sandboxArtifacts = output.task.artifacts!.filter(artifact => artifact.name === 'sandbox-only.md' || output.events.some(event => event.artifactIds?.includes(artifact.id)));
  assert.equal(sandboxArtifacts.length, 2);
  for (const artifact of sandboxArtifacts) { assert.equal((await getArtifact(artifact.id)).status, 404); assert.equal(await env.BUCKET.get(`artifacts/${userId}/${artifact.id}`), null); }
});

test('removing a failed recruitment slot applies successful candidates without another paid request', async () => {
  const beforeCalls = calls.length; let batchId = '', candidateId = '';
  await mutateState(userId, crypto.randomUUID(), createInitialState, async (saved: AppState) => {
    const candidate = structuredClone(saved.agents.find(agent => !agent.hired)!); candidate.id = crypto.randomUUID(); candidate.name = '路由测试独立候选'; candidateId = candidate.id;
    batchId = crypto.randomUUID(); const createdAt = new Date().toISOString();
    saved.recruitment = { id: batchId, brief: '测试删除失败档案', count: 2, createdAt, updatedAt: createdAt, applied: false, slots: [
      { slot: 1, status: 'succeeded', attempts: 1, candidate, issues: [] }, { slot: 2, status: 'failed', attempts: 1, issues: [{ path: 'candidates.0.profile', message: '字段缺失' }], errorCode: 'RECRUITMENT_SCHEMA' },
    ] };
  });
  const result = await act('recruit.skip', { batchId, slot: 2 }); assert.equal(result.status, 200);
  assert.equal(result.value.state.recruitment!.slots[1].status, 'skipped'); assert.equal(result.value.state.recruitment!.applied, true);
  assert.ok(result.value.state.agents.some(agent => agent.id === candidateId)); assert.equal(calls.length, beforeCalls);
  const repeat = await act('recruit.skip', { batchId, slot: 2 }); assert.equal(repeat.status, 200); assert.equal(calls.length, beforeCalls);
});
