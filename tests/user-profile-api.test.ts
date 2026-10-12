import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import sharp from 'sharp';
import type { AppState, UserImage } from '../lib/types.ts';
import { createImagePromptProfile } from '../lib/image-prompts.ts';

const prefix = 'palace-user-profile-test-';
const fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
const oldDirectory = process.env.PALACE_DATA_DIR;
process.env.PALACE_DATA_DIR = join(fixtureRoot, 'isolated-data');
const project = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({ configFile: join(project, 'local/vite.config.ts'), server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
const { env } = await vite.ssrLoadModule(join(project, 'local/runtime.ts'));
if (oldDirectory === undefined) delete process.env.PALACE_DATA_DIR; else process.env.PALACE_DATA_DIR = oldDirectory;
const { withLocalRequest } = await vite.ssrLoadModule(join(project, 'local/auth.ts'));
const profile = await vite.ssrLoadModule(join(project, 'app/api/user-profile/route.ts'));
const uploads = await vite.ssrLoadModule(join(project, 'app/api/chat-uploads/route.ts'));
const portraits = await vite.ssrLoadModule(join(project, 'app/api/portraits/[id]/route.ts'));
const { mutateState, readState } = await vite.ssrLoadModule(join(project, 'lib/server/store.ts'));
const { createInitialState } = await vite.ssrLoadModule(join(project, 'lib/seeds.ts'));
const { saveProviderSettings } = await vite.ssrLoadModule(join(project, 'lib/server/provider-settings.ts'));
const origin = 'http://127.0.0.1:5199', userId = 'local-owner';
const textEndpoint = 'https://profile-text.invalid/v1/chat/completions', imageEndpoint = 'https://profile-image.invalid/v1/images/generations';
const inputImage = await sharp({ create: { width: 8, height: 9, channels: 3, background: '#5D796E' } }).withMetadata({ exif: { IFD0: { Artist: 'private-marker' } } }).jpeg().toBuffer();
const generatedImage = await sharp({ create: { width: 8, height: 9, channels: 3, background: '#AF899B' } }).png().toBuffer();
const originalFetch = globalThis.fetch;
const calls: { url: string; body: any }[] = [];
let allowedCall: 'text' | 'image' | undefined;
globalThis.fetch = async (url, init) => {
  const target = url instanceof Request ? url.url : String(url);
  assert.ok([textEndpoint, imageEndpoint].includes(target), `unexpected network destination ${target}`);
  assert.equal(init?.method, 'POST'); const body = JSON.parse(String(init?.body)); calls.push({ url: target, body });
  if (target === imageEndpoint) {
    assert.equal(allowedCall, 'image');
    return Response.json({ data: [{ b64_json: generatedImage.toString('base64') }] });
  }
  assert.equal(allowedCall, 'text');
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ name: '阿遥', description: '喜欢做科幻小项目。', preferences: '表达直接一点。' }) } }], usage: { total_tokens: 10 } });
};

after(async context => {
  globalThis.fetch = originalFetch; await vite.close();
  if (!existsSync(fixtureRoot)) return;
  const target = realpathSync(fixtureRoot);
  assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith(prefix));
  try { rmSync(target, { recursive: true, force: true }); }
  catch (error) {
    if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    if ('diagnostic' in context) context.diagnostic('Only this isolated test fixture may remain locked until the SQLite worker exits.');
  }
});

interface Result { state: AppState; image?: UserImage; draft?: { name: string; description: string; preferences?: string }; error?: string; code?: string; replayed?: boolean; }
async function post(module: Record<string, any>, path: string, body: object, headers: Record<string, string> = {}) {
  const response: Response = await withLocalRequest(() => module.POST(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }) })));
  return { status: response.status, value: await response.json() as Result };
}
const setProfile = (body: object) => post(profile, '/api/user-profile', body);
const upload = (body: object = {}) => post(uploads, '/api/chat-uploads', { dataBase64: inputImage.toString('base64'), contentType: 'image/jpeg', name: 'photo.jpg', ...body });
const state = (): Promise<AppState> => readState(userId, createInitialState);
const image = (id: string): Promise<Response> => withLocalRequest(() => portraits.GET(new Request(`${origin}/api/portraits/${id}`), { params: Promise.resolve({ id }) }));

test('profile and upload routes require local-owner context, reject cross-origin operations and unknown overwrite fields', async () => {
  const unauthorized: Response = await profile.GET(); assert.equal(unauthorized.status, 401);
  const unauthorizedUpload: Response = await uploads.POST(new Request(`${origin}/api/chat-uploads`, { method: 'POST' })); assert.equal(unauthorizedUpload.status, 401);
  const blocked = await post(profile, '/api/user-profile', { action: 'save', name: '阿遥', description: '' }, { origin: 'https://outside.invalid' });
  assert.equal(blocked.status, 403); assert.equal(blocked.value.code, 'ORIGIN_MISMATCH');
  const overwrite = await upload({ id: 'fixed-id', url: '/api/portraits/somebody' }); assert.equal(overwrite.status, 400);
  assert.equal(calls.length, 0);
});

test('AI profile generation returns a draft without storing it, and explicit save changes only user-authored fields', async () => {
  await saveProviderSettings(userId, 'text', { baseUrl: 'https://profile-text.invalid/v1', model: 'test-profile-model', apiKey: 'test-only-text-key' });
  await saveProviderSettings(userId, 'image', { baseUrl: 'https://profile-image.invalid/v1', model: 'nai-diffusion-4-5-full', apiKey: 'test-only-image-key', promptStyle: 'custom', customPrompt: 'PREFIX {{name}} {{prompt}} SUFFIX' });
  const before = await state(); allowedCall = 'text';
  const draft = await setProfile({ action: 'draft', brief: '称呼我阿遥，喜欢做科幻项目。' }); allowedCall = undefined;
  assert.equal(draft.status, 200); assert.equal(draft.value.draft!.name, '阿遥'); assert.deepEqual(await state(), before);
  const saved = await setProfile({ action: 'save', ...draft.value.draft });
  assert.equal(saved.status, 200); assert.equal(saved.value.state.userProfile!.description, '喜欢做科幻小项目。'); assert.deepEqual(saved.value.state.agents, before.agents);
  assert.equal(JSON.stringify(saved.value).includes('test-only-text-key'), false);
});

test('uploaded chat images get server-owned IDs, normalized private pixels and exact idempotent replay', async () => {
  const firstRequest = crypto.randomUUID(); const first = await upload({ requestId: firstRequest });
  assert.equal(first.status, 200); assert.equal(first.value.image!.contentType, 'image/png');
  const id = first.value.image!.id; assert.match(id, /^[a-f0-9-]{36}$/); assert.equal(first.value.image!.url, `/api/portraits/upload-${id}`);
  const served = await image(`upload-${id}`); assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/png');
  const metadata = await sharp(new Uint8Array(await served.arrayBuffer())).metadata(); assert.equal(metadata.format, 'png'); assert.equal(metadata.exif, undefined);
  const second = await upload(); assert.equal(second.status, 200); assert.notEqual(second.value.image!.id, id);
  const replay = await upload({ requestId: firstRequest }); assert.equal(replay.status, 200); assert.equal(replay.value.replayed, true); assert.equal(replay.value.image!.id, id);
  assert.equal(replay.value.state.userUploads!.length, 2);
  assert.equal((await image('upload-not-owned')).status, 404);
});

test('avatar uploads and generation use saved identity/channel options; profile clearing preserves chat attachments', async () => {
  const uploaded = await setProfile({ action: 'avatar.upload', dataBase64: inputImage.toString('base64'), contentType: 'image/jpeg' });
  assert.equal(uploaded.status, 200); assert.match(uploaded.value.state.userProfile!.avatar!, /^\/api\/portraits\/user-profile\?v=/);
  assert.equal((await image('user-profile')).status, 200);
  const requestId = crypto.randomUUID(); allowedCall = 'image';
  const generated = await setProfile({ action: 'avatar.generate', prompt: 'portrait with round glasses', requestId }); allowedCall = undefined;
  assert.equal(generated.status, 200);
  const sent = calls.at(-1)!; assert.equal(sent.url, imageEndpoint); assert.match(sent.body.prompt, /^PREFIX 阿遥 /); assert.match(sent.body.prompt, /round glasses/); assert.match(sent.body.prompt, /SUFFIX$/);
  const beforeCalls = calls.length;
  const replay = await setProfile({ action: 'avatar.generate', prompt: 'portrait with round glasses', requestId }); assert.equal(replay.value.replayed, true); assert.equal(calls.length, beforeCalls);
  const custom = { ...createImagePromptProfile('custom'), llmEnabled: false, positivePrompt: '{{prompt}}\nAVATAR-SUFFIX', negativePrompt: 'avoid duplicate {{name}} / {{appearance}} / {{request}} / {{userMessage}}' };
  await saveProviderSettings(userId, 'image', { promptProfiles: { generation: custom, reference: custom } });
  allowedCall = 'image';
  const lettered = await setProfile({ action: 'avatar.generate', prompt: 'hold a sign\nText: Welcome home' }); allowedCall = undefined;
  assert.equal(lettered.status, 200);
  const letteredBody = calls.at(-1)!.body;
  assert.ok(letteredBody.prompt.endsWith('AVATAR-SUFFIX\nText: Welcome home'));
  assert.equal(letteredBody.prompt.split('Text:').length - 1, 1);
  assert.equal(letteredBody.negative_prompt, 'avoid duplicate 阿遥 / 喜欢做科幻小项目。 / hold a sign\nText: Welcome home / hold a sign\nText: Welcome home');
  const toSend = generated.value.state.userUploads![0];
  await mutateState(userId, crypto.randomUUID(), createInitialState, async (saved: AppState) => {
    saved.userUploads = saved.userUploads!.filter(item => item.id !== toSend.id);
    saved.agents[0].chats.push({ id: crypto.randomUUID(), role: 'user', content: '照片已发送', attachments: [toSend], createdAt: new Date().toISOString() });
  });
  const cleared = await setProfile({ action: 'clear' }); assert.equal(cleared.status, 200); assert.equal(cleared.value.state.userProfile, undefined);
  assert.equal((await image('user-profile')).status, 404); assert.equal(await env.BUCKET.get(`portraits/${userId}/user-profile`), null);
  assert.equal((await image(`upload-${toSend.id}`)).status, 200);
  assert.equal((await image(`upload-${cleared.value.state.userUploads![0].id}`)).status, 200);
  const forbiddenDelete = await post(uploads, '/api/chat-uploads', { action: 'remove', imageId: toSend.id }); assert.equal(forbiddenDelete.status, 404); assert.equal(forbiddenDelete.value.code, 'USER_IMAGE_NOT_PENDING');
});

test('removing a pending upload cleans only unreferenced pixels and leaves other pending or sent images intact', async () => {
  const before = await state(); const pending = before.userUploads![0]; const sent = before.agents[0].chats.at(-1)!.attachments![0];
  const removed = await post(uploads, '/api/chat-uploads', { action: 'remove', imageId: pending.id });
  assert.equal(removed.status, 200); assert.equal(removed.value.state.userUploads!.some(item => item.id === pending.id), false);
  assert.equal((await image(`upload-${pending.id}`)).status, 404); assert.equal(await env.BUCKET.get(`portraits/${userId}/upload-${pending.id}`), null);
  assert.equal((await image(`upload-${sent.id}`)).status, 200);
});

test('pending uploads are capped independently from sent attachments and cleanup locks apply to both routes', async () => {
  await mutateState(userId, crypto.randomUUID(), createInitialState, async (saved: AppState) => {
    saved.userUploads = Array.from({ length: 20 }, () => { const id = crypto.randomUUID(); return { id, url: `/api/portraits/upload-${id}`, contentType: 'image/png', createdAt: saved.updatedAt }; });
  });
  const overflow = await upload(); assert.equal(overflow.status, 409); assert.equal(overflow.value.code, 'USER_UPLOAD_LIMIT');
  await mutateState(userId, crypto.randomUUID(), createInitialState, async (saved: AppState) => { saved.pendingCleanup = [{ id: crypto.randomUUID(), kind: 'all', imageIds: [], createdAt: saved.updatedAt }]; });
  const blocked = await setProfile({ action: 'save', name: '阿遥', description: 'new' }); assert.equal(blocked.status, 409); assert.equal(blocked.value.code, 'CLEANUP_PENDING');
  const blockedUpload = await upload(); assert.equal(blockedUpload.status, 409); assert.equal(blockedUpload.value.code, 'CLEANUP_PENDING');
});
