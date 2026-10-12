import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { AppState } from '../lib/types.ts';

// 主人，这里只用临时数据库与拦截的模型响应，真实存档和付费接口都不会被测试碰到呢。
const prefix = 'palace-random-recruitment-test-';
const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
const oldDirectory = process.env.PALACE_DATA_DIR;
process.env.PALACE_DATA_DIR = join(fixtureRoot, 'isolated-data');
const project = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({ configFile: join(project, 'local/vite.config.ts'), server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
await vite.ssrLoadModule(join(project, 'local/runtime.ts'));
if (oldDirectory === undefined) delete process.env.PALACE_DATA_DIR; else process.env.PALACE_DATA_DIR = oldDirectory;
const { withLocalRequest } = await vite.ssrLoadModule(join(project, 'local/auth.ts'));
const route = await vite.ssrLoadModule(join(project, 'app/api/recruitment-ideas/route.ts'));
const { readState, mutateState } = await vite.ssrLoadModule(join(project, 'lib/server/store.ts'));
const { createInitialState } = await vite.ssrLoadModule(join(project, 'lib/seeds.ts'));
const { saveProviderSettings } = await vite.ssrLoadModule(join(project, 'lib/server/provider-settings.ts'));
const origin = 'http://127.0.0.1:5199';
const endpoint = 'https://random-recruitment.invalid/v1/chat/completions';
const brief = '请寻访具有独立生活经历的原创角色，她曾在偏远海岸经营小型修复工坊，因一次主动放弃的机会开始重新认识自己的愿望。外貌有与故乡有关的配饰，但日常衣装以实用为主。她擅长耐心观察材料，能够拆解复杂的问题，却不擅长安排多人协作。表达时先给结论，再用生活中的小事作比喻。她希望被认可，又害怕竞争会破坏关系，愿意通过一起完成具体的小事建立信任。让候选人之间保留不同的语言节奏、私人爱好与成长方向，不照搬已有的姓名和完整人物设定。';
const calls: { url: string; body: { model: string; messages: { content: string }[] } }[] = [];
let modelResult: unknown = { brief };
let providerStatus = 200;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = url instanceof Request ? url.url : String(url);
  assert.equal(target, endpoint, '所有模型请求只能进入隔离测试桩');
  calls.push({ url: target, body: JSON.parse(String(init?.body)) });
  if (providerStatus !== 200) return Response.json({ error: { message: 'fixture failure' } }, { status: providerStatus });
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(modelResult) } }], usage: { total_tokens: 60 } });
};

after(async context => {
  globalThis.fetch = originalFetch;
  await vite.close();
  if (!existsSync(fixtureRoot)) return;
  const target = realpathSync(fixtureRoot);
  assert.equal(dirname(target), realpathSync(tmpdir()));
  assert.ok(basename(target).startsWith(prefix));
  try { rmSync(target, { recursive: true, force: true }); }
  catch (error) {
    if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    if ('diagnostic' in context) context.diagnostic('隔离测试目录将在SQLite工作进程退出后释放。');
  }
});

async function post(body: object = {}, headers: Record<string, string> = {}) {
  const response: Response = await withLocalRequest(() => route.POST(new Request(`${origin}/api/recruitment-ideas`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })));
  return { status: response.status, value: await response.json() as { brief?: string; code?: string; error?: string }, headers: response.headers };
}
const state = (): Promise<AppState> => readState('local-owner', createInitialState);

test('ideas route checks authentication, origin and bounded input before any model request', async () => {
  const unauthorized: Response = await route.POST(new Request(`${origin}/api/recruitment-ideas`, { method: 'POST' }));
  assert.equal(unauthorized.status, 401);
  for (const headers of [{ origin: 'https://outside.invalid' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
    const result = await post({}, headers);
    assert.equal(result.status, 403); assert.equal(result.value.code, 'ORIGIN_MISMATCH');
  }
  assert.equal((await post({}, { 'content-type': 'text/plain' })).status, 415);
  for (const body of [{ count: 11 }, { brief: '长'.repeat(1801) }, { count: '2' }, { state: {} }]) assert.equal((await post(body)).status, 400);
  assert.equal(calls.length, 0);
});

test('ideas use configured providers and public diversity but never persist a draft or expose private data', async () => {
  await saveProviderSettings('local-owner', 'text', { baseUrl: 'https://random-recruitment.invalid/v1', model: 'fixture-idea-model', apiKey: 'test-only-random-key' });
  await mutateState('local-owner', crypto.randomUUID(), createInitialState, async (current: AppState) => {
    current.agents[0].chats.push({ id: 'private-chat', role: 'user', content: 'private-chat-marker', createdAt: current.updatedAt });
    current.agents[0].strategy = 'private-strategy-marker';
    current.promptOverrides = { 'recruiter.idea': '当前测试用户的随机设定提示词' };
  });
  const before = await state();
  const result = await post({ brief: '偏好温和的机器人', count: 3 });
  assert.equal(result.status, 200); assert.equal(result.value.brief, brief);
  assert.match(result.headers.get('cache-control') || '', /no-store/);
  assert.deepEqual(await state(), before);
  const body = calls.at(-1)!.body;
  assert.equal(body.model, 'fixture-idea-model');
  assert.match(body.messages[0].content, /当前测试用户的随机设定提示词/);
  const context = JSON.parse(body.messages[1].content);
  assert.equal(context.direction, '偏好温和的机器人'); assert.equal(context.requestedCount, 3);
  assert.equal(context.diversity.totalKnownCharacters, before.agents.length);
  for (const marker of ['private-chat-marker', 'private-strategy-marker', 'test-only-random-key']) assert.ok(!JSON.stringify(context).includes(marker));
  assert.ok(!JSON.stringify(result.value).includes('test-only-random-key'));
  assert.equal((await post()).status, 200);
});

test('invalid model output, provider failures and pending cleanup preserve the original save', async () => {
  const before = await state();
  modelResult = { brief: '字'.repeat(1801) };
  const invalid = await post();
  assert.equal(invalid.status, 502); assert.equal(invalid.value.code, 'RECRUITMENT_IDEA_INVALID');
  modelResult = { brief }; providerStatus = 503;
  assert.equal((await post()).value.code, 'PROVIDER_ERROR');
  providerStatus = 200;
  assert.deepEqual(await state(), before);
  await mutateState('local-owner', crypto.randomUUID(), createInitialState, async (current: AppState) => {
    current.pendingCleanup = [{ id: 'cleanup', kind: 'all', imageIds: [], createdAt: current.updatedAt }];
  });
  const countBefore = calls.length;
  assert.equal((await post()).value.code, 'CLEANUP_PENDING');
  assert.equal(calls.length, countBefore);
});
