import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { AppState } from '../lib/types.ts';

// SSR handler integration only: no listening server, user data or paid provider request.
const prefix = 'palace-lifecycle-api-test-';
const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
const oldDirectory = process.env.PALACE_DATA_DIR;
process.env.PALACE_DATA_DIR = join(fixtureRoot, 'isolated-data');
const project = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({ configFile: join(project, 'local/vite.config.ts'), server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
const { env } = await vite.ssrLoadModule(join(project, 'local/runtime.ts'));
if (oldDirectory === undefined) delete process.env.PALACE_DATA_DIR;
else process.env.PALACE_DATA_DIR = oldDirectory;
const { withLocalRequest } = await vite.ssrLoadModule(join(project, 'local/auth.ts'));
const palace = await vite.ssrLoadModule(join(project, 'app/api/palace/route.ts'));
const providers = await vite.ssrLoadModule(join(project, 'app/api/provider-settings/route.ts'));
const portraits = await vite.ssrLoadModule(join(project, 'app/api/portraits/[id]/route.ts'));
const debug = await vite.ssrLoadModule(join(project, 'app/api/debug/route.ts'));
const { mutateState } = await vite.ssrLoadModule(join(project, 'lib/server/store.ts'));
const { createInitialState } = await vite.ssrLoadModule(join(project, 'lib/seeds.ts'));
const originalFetch = globalThis.fetch;
let providerCalls = 0;
globalThis.fetch = async () => { providerCalls++; throw new Error('Network calls are forbidden in lifecycle fixtures.'); };

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
    if ('diagnostic' in context) context.diagnostic('Only this newly created fixture may remain locked until the SQLite worker exits.');
  }
});

const origin = 'http://127.0.0.1:5199';
interface ProviderFixture { text: { keyConfigured: boolean }; image: { keyConfigured: boolean }; }
interface FixtureResponse { state: AppState; settings: ProviderFixture; status?: string; code?: string; message?: string; }
async function post(module: typeof palace, path: string, body: object) {
  const response: Response = await withLocalRequest(() => module.POST(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })));
  return { status: response.status, value: await response.json() as FixtureResponse };
}
const act = (action: string, data: object = {}) => post(palace, '/api/palace', { action, requestId: crypto.randomUUID(), ...data });
async function getState(): Promise<AppState> {
  const response: Response = await withLocalRequest(() => palace.GET());
  assert.equal(response.status, 200);
  return response.json();
}
async function imageStatus(id: string): Promise<number> {
  const response: Response = await withLocalRequest(() => portraits.GET(new Request(`${origin}/api/portraits/${id}`), { params: Promise.resolve({ id }) }));
  return response.status;
}

test('real local API lifecycle keeps deleted data inaccessible across cleanup failures and leaves a durable empty reset', async () => {
  let state = await getState();
  const [first, second] = state.agents;
  assert.equal((await act('hire', { agentId: first.id })).status, 200);
  assert.equal((await act('hire', { agentId: second.id })).status, 200);
  const keyResult = await post(providers, '/api/provider-settings', { action: 'save', kind: 'text', apiKey: 'test-only-lifecycle-key' });
  assert.equal(keyResult.status, 200);
  assert.equal(keyResult.value.settings.text.keyConfigured, true);
  const before = (await getState()).agents.find(agent => agent.id === first.id)!;
  assert.equal((await act('member.trash', { agentId: first.id })).status, 200);
  const blockedChat = await act('chat', { agentId: first.id, message: '不得调用模型' });
  assert.equal(blockedChat.status, 409);
  assert.equal(blockedChat.value.code, 'MEMBER_ARCHIVED');
  assert.equal((await act('member.restore', { agentId: first.id })).status, 200);
  assert.deepEqual((await getState()).agents.find(agent => agent.id === first.id), before);

  await mutateState('local-owner', crypto.randomUUID(), createInitialState, async (saved: AppState) => {
    const agent = saved.agents.find(item => item.id === first.id)!;
    agent.portrait = `/api/portraits/${first.id}`;
    agent.chats.push({ id: 'private-fixture', role: 'assistant', content: 'private text to erase', createdAt: new Date().toISOString(), image: { status: 'ready', request: 'private', prompt: 'private', model: 'fixture', url: '/api/portraits/chat-private-fixture' } });
  });
  await env.BUCKET.put(`portraits/local-owner/${first.id}`, new Uint8Array([1]));
  await env.BUCKET.put('portraits/local-owner/chat-private-fixture', new Uint8Array([2]));
  assert.equal(await imageStatus(first.id), 200);
  assert.equal((await act('member.trash', { agentId: first.id })).status, 200);
  assert.equal((await act('member.delete', { agentId: first.id, confirmation: 'wrong' })).status, 400);

  const originalDelete = env.BUCKET.delete.bind(env.BUCKET);
  env.BUCKET.delete = async () => { throw new Error('simulated unavailable storage'); };
  try {
    const deleted = await act('member.delete', { agentId: first.id, confirmation: '永久删除' });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.value.state.agents.some((agent: AppState['agents'][number]) => agent.id === first.id), false);
    assert.equal(deleted.value.state.pendingCleanup?.length, 1);
    assert.match(deleted.value.message || '', /重试清理/);
    assert.equal(await imageStatus(first.id), 404, 'removed member pictures must be hidden even while physical deletion awaits retry');
    assert.equal(await imageStatus('chat-private-fixture'), 404);
    const blocked = await post(providers, '/api/provider-settings', { action: 'save', kind: 'text', apiKey: 'test-only-racing-key' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.value.code, 'CLEANUP_PENDING');
    const pending = await getState();
    assert.equal(pending.pendingCleanup?.length, 1);
    assert.equal(JSON.stringify(pending).includes('private text to erase'), false);
  } finally { env.BUCKET.delete = originalDelete; }
  assert.equal((await act('cleanup.retry')).value.state.pendingCleanup?.length, 0);
  assert.equal(await env.BUCKET.get(`portraits/local-owner/${first.id}`), null);
  assert.equal(await env.BUCKET.get('portraits/local-owner/chat-private-fixture'), null);

  const cleared = await act('data.clear', { confirmation: '清除所有数据' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.value.state.agents.length, 0);
  assert.equal(cleared.value.state.config.textReady, false, 'clear response must resolve provider settings after removing the old snapshot');
  assert.equal(cleared.value.state.config.imageReady, false);
  state = await getState();
  assert.deepEqual(state.agents, []);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.pendingCleanup, []);
  const settings: Response = await withLocalRequest(() => providers.GET());
  const publicSettings = await settings.json() as ProviderFixture;
  assert.equal(publicSettings.text.keyConfigured, false);
  assert.equal(publicSettings.image.keyConfigured, false);
  const catalog: Response = await withLocalRequest(() => debug.GET(new Request(origin + '/api/debug')));
  assert.equal(catalog.status, 200, 'an empty courtyard must still expose prompt debugging');
  assert.ok((await catalog.json() as { stages: unknown[] }).stages.length > 0);
  const preview = await post(debug, '/api/debug', { action: 'preview', stage: 'recruiter' });
  assert.equal(preview.status, 200);
  assert.equal(preview.value.status, 'preview');
  assert.deepEqual((await getState()).agents, [], 'temporary debug examples must not repopulate cleared saves');
  assert.equal(providerCalls, 0);
});
