import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import sharp from 'sharp';
import { zipSync } from 'fflate';
import type { AppState, ChatMessage } from '../lib/types.ts';
import type { DebugResult } from '../lib/debug-types.ts';

// Real route, SQLite, object storage, and provider serialization; only HTTP is mocked.
// All state and credentials live in this newly created temporary directory.
const prefix = 'palace-reference-api-test-';
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
const portraits = await vite.ssrLoadModule(join(project, 'app/api/portraits/[id]/route.ts'));
const debug = await vite.ssrLoadModule(join(project, 'app/api/debug/route.ts'));
const { mutateState } = await vite.ssrLoadModule(join(project, 'lib/server/store.ts'));
const { createInitialState } = await vite.ssrLoadModule(join(project, 'lib/seeds.ts'));
const { saveProviderSettings } = await vite.ssrLoadModule(join(project, 'lib/server/provider-settings.ts'));
const originalFetch = globalThis.fetch;
const calls: { url: string; init?: RequestInit }[] = [];
let allowFetch = false;
const endpoint = 'https://reference-provider.invalid/ai/generate-image';
const avatar = new Uint8Array(await sharp({ create: { width: 2, height: 3, channels: 3, background: { r: 213, g: 81, b: 47 } } }).png().toBuffer());
const outputImage = new Uint8Array(await sharp({ create: { width: 4, height: 5, channels: 3, background: '#228899' } }).png().toBuffer());
const archive = zipSync({ 'image_0.png': outputImage });
globalThis.fetch = async (url, init) => {
  const target = url instanceof Request ? url.url : String(url);
  calls.push({ url: target, init });
  assert.equal(allowFetch, true, 'this operation must not call any network provider');
  assert.equal(target, endpoint, 'only the intended mocked NovelAI native endpoint is allowed');
  return new Response(archive as BodyInit, { headers: { 'Content-Type': 'application/zip' } });
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
    if ('diagnostic' in context) context.diagnostic('Only this newly created fixture may remain locked until the SQLite worker exits.');
  }
});

const origin = 'http://127.0.0.1:5199';
const userId = 'local-owner';
interface ActionResult { state: AppState; message?: string; code?: string; }
async function post<T>(module: { POST: (request: Request) => Promise<Response> }, path: string, body: object): Promise<{ status: number; value: T }> {
  const response: Response = await withLocalRequest(() => module.POST(new Request(origin + path, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })));
  return { status: response.status, value: await response.json() as T };
}
const retry = (agentId: string, messageId: string) => post<ActionResult>(palace as { POST: (request: Request) => Promise<Response> }, '/api/palace', {
  action: 'chat.image.retry', agentId, messageId, requestId: crypto.randomUUID(),
});
async function getState(): Promise<AppState> {
  const response: Response = await withLocalRequest(() => palace.GET());
  assert.equal(response.status, 200);
  return response.json();
}
async function getPicture(id: string): Promise<Response> {
  return withLocalRequest(() => portraits.GET(new Request(`${origin}/api/portraits/${id}`), { params: Promise.resolve({ id }) }));
}
function failedReply(id: string): ChatMessage {
  return {
    id, role: 'assistant', content: '我会换上女仆装，并保留自己的样貌。', checked: true, createdAt: '2026-10-12T00:00:00Z',
    image: { status: 'failed', request: 'maid outfit, same face and hair', prompt: 'previous attempt', model: 'nai-diffusion-5-full', error: 'previous fixture failure' },
  };
}

test('real local chat-image retry uses the saved avatar through the native provider and keeps previews and missing-avatar retries isolated', async () => {
  const state = await getState();
  const agentId = state.agents[0].id;
  const sourceUrl = `/api/portraits/${agentId}?v=fixture-avatar`;
  const avatarKey = `portraits/${userId}/${agentId}`;
  const reply = failedReply('reference-api-reply');
  await saveProviderSettings(userId, 'image', { baseUrl: 'https://reference-provider.invalid/v1', model: 'nai-diffusion-5-full', apiKey: 'image-test-only' });
  await mutateState(userId, crypto.randomUUID(), createInitialState, async (saved: AppState) => {
    const selected = saved.agents.find(item => item.id === agentId)!;
    selected.hired = true;
    selected.portrait = sourceUrl;
    selected.chats = [{ id: 'reference-user-message', role: 'user', content: '给我看看你穿女仆装的样子', createdAt: reply.createdAt }, reply];
  });
  await env.BUCKET.put(avatarKey, avatar, { httpMetadata: { contentType: 'image/png' } });
  // A same-id avatar in another namespace must never become this user's reference.
  await env.BUCKET.put(`portraits/another-owner/${agentId}`, outputImage, { httpMetadata: { contentType: 'image/png' } });

  allowFetch = true;
  const result = await retry(agentId, reply.id);
  allowFetch = false;
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1, 'only one image request, with no text-only fallback');
  assert.equal(calls[0].url, endpoint);
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(new Headers(calls[0].init?.headers).get('Authorization'), 'Bearer image-test-only');
  const sent = JSON.parse(String(calls[0].init?.body)) as {
    model: string; input: string; parameters: { uc: string; negative_prompt: string; v4_negative_prompt: { caption: { base_caption: string } }; director_reference_images: string[]; director_reference_descriptions: { caption: { base_caption: string } }[] };
  };
  assert.equal(sent.model, 'nai-diffusion-4-5-full');
  assert.match(sent.input, /maid outfit/);
  assert.match(sent.input, /^no text,/);
  assert.match(sent.parameters.uc, /speech bubble/);
  assert.equal(sent.parameters.negative_prompt, sent.parameters.uc);
  assert.equal(sent.parameters.v4_negative_prompt.caption.base_caption, sent.parameters.uc);
  assert.equal(sent.parameters.director_reference_images.length, 1);
  assert.equal(sent.parameters.director_reference_descriptions[0].caption.base_caption, 'character');
  const sentAvatar = Buffer.from(sent.parameters.director_reference_images[0], 'base64');
  assert.deepEqual([...sentAvatar.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const metadata = await sharp(sentAvatar).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.height, 1536);
  const pixel = await sharp(sentAvatar).extract({ left: 512, top: 768, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  assert.deepEqual([...pixel], [213, 81, 47], 'native reference contains this owner\'s real avatar pixels');

  const updated = result.value.state.agents.find(item => item.id === agentId)!;
  const image = updated.chats.find(item => item.id === reply.id)!.image!;
  assert.equal(image.status, 'ready');
  assert.equal(image.model, 'nai-diffusion-4-5-full');
  assert.equal(image.url, `/api/portraits/chat-${reply.id}`);
  assert.deepEqual(image.reference, { sourceUrl, mode: 'character' });
  assert.equal(updated.portrait, sourceUrl);
  assert.equal(updated.chats[1].content, reply.content);
  assert.equal(updated.chats.length, 2);
  assert.equal(JSON.stringify(result.value).includes('image-test-only'), false);
  assert.equal(JSON.stringify(result.value).includes(sent.parameters.director_reference_images[0]), false);
  const storedAvatar = await env.BUCKET.get(avatarKey);
  assert.deepEqual(new Uint8Array(await new Response(storedAvatar.body).arrayBuffer()), avatar, 'chat generation never overwrites the original avatar');
  const downloaded = await getPicture(`chat-${reply.id}`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), outputImage);
  const avatarDownload = await getPicture(agentId);
  assert.equal(avatarDownload.status, 200);
  assert.deepEqual(new Uint8Array(await avatarDownload.arrayBuffer()), avatar);

  const beforePreview = await getState();
  const preview = await post<DebugResult>(debug as { POST: (request: Request) => Promise<Response> }, '/api/debug', {
    action: 'preview', stage: 'chat-image', promptId: 'chat.image.template', agentId,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.value.status, 'preview');
  assert.equal(preview.value.trace.length, 1);
  assert.equal(preview.value.trace[0].endpoint, endpoint);
  assert.equal(preview.value.trace[0].model, 'nai-diffusion-4-5-full');
  assert.deepEqual(preview.value.trace[0].reference, { sourceUrl, mode: 'character', strength: 1, fidelity: 0.5, width: 1024, height: 1536 });
  assert.equal(preview.value.imageDataUrl, undefined);
  assert.equal(calls.length, 1, 'preview may load the avatar locally but must not call the provider');
  assert.equal(JSON.stringify(preview.value).includes(sent.parameters.director_reference_images[0]), false);
  assert.deepEqual(await getState(), beforePreview, 'debug preview must not alter the stored avatar, chat, or other saved data');

  for (const mode of ['empty', 'deleted'] as const) {
    const missingReply = failedReply(`reference-${mode}-reply`);
    await mutateState(userId, crypto.randomUUID(), createInitialState, async (saved: AppState) => {
      const selected = saved.agents.find(item => item.id === agentId)!;
      selected.portrait = mode === 'empty' ? '' : sourceUrl;
      selected.chats.push(missingReply);
    });
    if (mode === 'deleted') await env.BUCKET.delete(avatarKey);
    const failed = await retry(agentId, missingReply.id);
    assert.equal(failed.status, 200, 'the accepted caption survives a recoverable image error');
    const saved = failed.value.state.agents.find(item => item.id === agentId)!;
    const failedMessage = saved.chats.find(item => item.id === missingReply.id)!;
    assert.equal(failedMessage.image?.status, 'failed');
    assert.equal(failedMessage.image?.url, undefined);
    assert.match(failedMessage.image?.error || '', /先.*头像/);
    assert.equal(failedMessage.content, missingReply.content);
    assert.equal(failedMessage.checked, true);
    assert.equal(calls.length, 1, 'no paid image request, text model call, or fallback after a missing avatar');
    assert.equal((await getPicture(`chat-${missingReply.id}`)).status, 404);
  }
});
