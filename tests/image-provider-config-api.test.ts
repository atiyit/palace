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
import type { ImagePromptStyle } from '../lib/image-prompts.ts';

const prefix = 'palace-image-config-api-test-', fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
const previousDirectory = process.env.PALACE_DATA_DIR; process.env.PALACE_DATA_DIR = join(fixtureRoot, 'isolated-data');
const project = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({ configFile: join(project, 'local/vite.config.ts'), server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
const { env } = await vite.ssrLoadModule(join(project, 'local/runtime.ts'));
if (previousDirectory === undefined) delete process.env.PALACE_DATA_DIR; else process.env.PALACE_DATA_DIR = previousDirectory;
const { withLocalRequest } = await vite.ssrLoadModule(join(project, 'local/auth.ts'));
const palace = await vite.ssrLoadModule(join(project, 'app/api/palace/route.ts'));
const settings = await vite.ssrLoadModule(join(project, 'app/api/provider-settings/route.ts'));
const debug = await vite.ssrLoadModule(join(project, 'app/api/debug/route.ts'));
const { mutateState } = await vite.ssrLoadModule(join(project, 'lib/server/store.ts'));
const { createInitialState } = await vite.ssrLoadModule(join(project, 'lib/seeds.ts'));
const { withProviderSettings, getEffectiveProvider } = await vite.ssrLoadModule(join(project, 'lib/server/provider-settings.ts'));
const { referenceImageModelName } = await vite.ssrLoadModule(join(project, 'lib/server/provider.ts'));
const userId = 'local-owner', origin = 'http://127.0.0.1:5199', providerBase = 'https://image-config.example.test';
const picture = new Uint8Array(await sharp({ create: { width: 10, height: 15, channels: 3, background: '#B86633' } }).png().toBuffer());
const originalFetch = globalThis.fetch;
const calls: { url: string; model: string; prompt: string; reference?: File; body?: any }[] = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer image-config-test-only');
  assert.equal(init?.redirect, 'manual');
  if (target === `${providerBase}/v1/images/edits`) {
    const body = init?.body as FormData; assert.ok(body instanceof FormData); const reference = body.get('image') as File; assert.ok(reference instanceof Blob);
    calls.push({ url: target, model: String(body.get('model')), prompt: String(body.get('prompt')), reference });
  } else {
    assert.ok([`${providerBase}/v1/images/generations`, `${providerBase}/ai/generate-image`].includes(target), 'every request must stay in the mock image provider');
    const body = JSON.parse(String(init?.body)); calls.push({ url: target, model: body.model, prompt: body.prompt || body.input, body });
    if (target.endsWith('/ai/generate-image')) return new Response(zipSync({ 'image_0.png': picture }) as BodyInit, { headers: { 'content-type': 'application/zip' } });
  }
  return Response.json({ data: [{ b64_json: Buffer.from(picture).toString('base64') }] });
};
after(async context => {
  globalThis.fetch = originalFetch; await vite.close();
  if (!existsSync(fixtureRoot)) return;
  const target = realpathSync(fixtureRoot); assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith(prefix));
  try { rmSync(target, { recursive: true, force: true }); }
  catch (error) { if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error; if ('diagnostic' in context) context.diagnostic('Only the new fixture may remain locked until SQLite exits.'); }
});

async function post<T = any>(module: Record<string, any>, path: string, body: object) {
  const response: Response = await withLocalRequest(() => module.POST(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })));
  return { status: response.status, value: await response.json() as T };
}
const act = (action: string, body: object) => post(palace, '/api/palace', { action, requestId: crypto.randomUUID(), ...body });
const saveImage = (body: object) => post(settings, '/api/provider-settings', { action: 'save', kind: 'image', ...body });
async function getState(): Promise<AppState> { const response: Response = await withLocalRequest(() => palace.GET()); assert.equal(response.status, 200); return response.json(); }
function failedMessage(id: string): ChatMessage { return { id, role: 'assistant', content: '我给你看看换上旅行装的样子。', checked: true, createdAt: '2026-10-12T00:00:00Z', image: { status: 'failed', request: 'same character wearing a travel outfit', prompt: 'previous failed attempt', model: 'old-model' } }; }

test('public settings persist separate image models and every preset reaches actual portrait and reference requests once', async () => {
  const initial = await getState(), person = initial.agents[0];
  assert.equal((await act('hire', { agentId: person.id })).status, 200);
  const first = await saveImage({ baseUrl: providerBase + '/v1', model: 'nai-diffusion-5-full', referenceModel: 'gpt-image-1', promptStyle: 'default', apiKey: 'image-config-test-only' });
  assert.equal(first.status, 200); assert.equal(first.value.settings.image.model, 'nai-diffusion-5-full'); assert.equal(first.value.settings.image.referenceModel, 'gpt-image-1');
  assert.equal(first.value.settings.image.promptStyle, 'default'); assert.equal(JSON.stringify(first.value).includes('image-config-test-only'), false);
  const originalText = first.value.settings.text;
  for (const [index, style] of (['default', 'novelai', 'gpt-image', 'custom'] as ImagePromptStyle[]).entries()) {
    const saved = await saveImage({ promptStyle: style, customPrompt: 'MY-CUSTOM {{name}} {{request}}\n{{prompt}}', apiKey: '' });
    assert.equal(saved.status, 200); assert.deepEqual(saved.value.settings.text, originalText); assert.equal(saved.value.settings.image.referenceModel, 'gpt-image-1');
    assert.equal(await withProviderSettings(userId, () => referenceImageModelName()), 'gpt-image-1');
    const beforePortrait = calls.length; const portrait = await act('portrait', { agentId: person.id }); assert.equal(portrait.status, 200);
    assert.equal(calls.length, beforePortrait + 1); const portraitCall = calls.at(-1)!;
    assert.equal(portraitCall.url, `${providerBase}/v1/images/generations`); assert.equal(portraitCall.model, 'nai-diffusion-5-full');
    const reply = failedMessage(`preset-reply-${index}`);
    await mutateState(userId, crypto.randomUUID(), createInitialState, async (state: AppState) => { state.agents.find(agent => agent.id === person.id)!.chats.push({ id: `preset-user-${index}`, role: 'user', content: '看看你穿旅行装的样子。', createdAt: reply.createdAt }, reply); });
    const result = await act('chat.image.retry', { agentId: person.id, messageId: reply.id }); assert.equal(result.status, 200);
    const image = (result.value.state as AppState).agents.find(agent => agent.id === person.id)!.chats.find(item => item.id === reply.id)!.image!;
    assert.equal(image.status, 'ready'); assert.equal(image.model, 'gpt-image-1');
    const referenceCall = calls.at(-1)!; assert.equal(referenceCall.url, `${providerBase}/v1/images/edits`); assert.equal(referenceCall.model, 'gpt-image-1');
    assert.deepEqual(await sharp(new Uint8Array(await referenceCall.reference!.arrayBuffer())).raw().toBuffer(), await sharp(picture).raw().toBuffer(), 'the actual saved portrait is uploaded');
    for (const prompt of [portraitCall.prompt, referenceCall.prompt]) {
      if (style === 'novelai') assert.equal(prompt.split('best quality, very aesthetic, detailed composition').length - 1, 1);
      if (style === 'gpt-image') assert.equal(prompt.split('Create a single finished image').length - 1, 1);
      if (style === 'custom') { assert.ok(prompt.startsWith(`MY-CUSTOM ${person.name}`)); assert.equal(prompt.includes('{{prompt}}'), false); }
      if (style === 'default') assert.equal(prompt.startsWith('Create a single finished image'), false);
    }
    const beforePreview = calls.length;
    const preview = await post<DebugResult>(debug, '/api/debug', { action: 'preview', stage: 'chat-image', promptId: 'chat.image.template', agentId: person.id, input: { request: 'same character wearing a travel outfit', userMessage: '看看你穿旅行装的样子。' } });
    assert.equal(preview.status, 200); assert.equal(preview.value.status, 'preview'); assert.equal(calls.length, beforePreview);
    assert.equal(preview.value.trace[0].model, 'gpt-image-1'); assert.equal(preview.value.trace[0].endpoint, `${providerBase}/v1/images/edits`);
    if (style === 'novelai') assert.ok(preview.value.trace[0].prompt!.startsWith('best quality'));
    if (style === 'gpt-image') assert.ok(preview.value.trace[0].prompt!.startsWith('Create a single finished image'));
    if (style === 'custom') assert.ok(preview.value.trace[0].prompt!.startsWith(`MY-CUSTOM ${person.name}`));
  }
});

test('explicit model choices never get remapped and GPT text generation uses supported parameters', async () => {
  const person = (await getState()).agents[0];
  const saved = await saveImage({ model: 'gpt-image-1', referenceModel: 'nai-diffusion-5-full', promptStyle: 'default' }); assert.equal(saved.status, 200);
  assert.equal(saved.value.settings.image.referenceModel, 'nai-diffusion-5-full');
  await act('portrait', { agentId: person.id }); const portraitCall = calls.at(-1)!;
  assert.equal(portraitCall.model, 'gpt-image-1'); assert.equal(portraitCall.body.size, '1024x1536'); assert.equal(portraitCall.body.output_format, 'png'); assert.equal(portraitCall.body.response_format, undefined);
  const reply = failedMessage('explicit-nai5'); await mutateState(userId, crypto.randomUUID(), createInitialState, async (state: AppState) => { state.agents[0].chats.push(reply); });
  const result = await act('chat.image.retry', { agentId: person.id, messageId: reply.id }); assert.equal(result.status, 200);
  assert.equal(calls.at(-1)!.model, 'nai-diffusion-5-full'); assert.equal(calls.at(-1)!.url, `${providerBase}/v1/images/edits`, 'explicit V5 is not silently changed to the V4.5 native model');
  await saveImage({ referenceModel: 'nai-diffusion-4-5-full' });
  const native = failedMessage('explicit-nai45'); await mutateState(userId, crypto.randomUUID(), createInitialState, async (state: AppState) => { state.agents[0].chats.push(native); });
  await act('chat.image.retry', { agentId: person.id, messageId: native.id });
  assert.equal(calls.at(-1)!.model, 'nai-diffusion-4-5-full'); assert.equal(calls.at(-1)!.url, `${providerBase}/ai/generate-image`);
  assert.equal(calls.at(-1)!.body.parameters.director_reference_images.length, 1);
});

test('image-only fields cannot leak into text settings and invalid saves preserve the previous snapshot', async () => {
  const before = await withProviderSettings(userId, () => ({ ...getEffectiveProvider('image') })); const beforeCalls = calls.length;
  assert.equal((await post(settings, '/api/provider-settings', { action: 'save', kind: 'text', referenceModel: 'gpt-image-1' })).status, 400);
  assert.equal((await saveImage({ referenceModel: ' ' })).status, 400);
  assert.equal((await saveImage({ promptStyle: 'unexpected' })).status, 400);
  assert.equal((await saveImage({ customPrompt: 'x'.repeat(6001) })).status, 400);
  assert.deepEqual(await withProviderSettings(userId, () => ({ ...getEffectiveProvider('image') })), before); assert.equal(calls.length, beforeCalls);
  const reset = await post(settings, '/api/provider-settings', { action: 'reset', kind: 'image' }); assert.equal(reset.status, 200);
  assert.equal(reset.value.settings.image.model, 'nai-diffusion-5-full'); assert.equal(reset.value.settings.image.referenceModel, 'nai-diffusion-4-5-full'); assert.equal(reset.value.settings.image.promptStyle, 'default'); assert.equal(reset.value.settings.image.customPrompt, '');
});

test('real settings routes persist native protocols, local opt-in and vision independently without leaking cloud keys', async () => {
  const beforeCalls = calls.length;
  const remote = await post(settings, '/api/provider-settings', { action: 'save', kind: 'text', baseUrl: 'https://text-config.example.test/v1/messages', protocol: 'anthropic', local: false, visionEnabled: true, model: 'custom-claude', apiKey: 'text-cloud-test-only' });
  assert.equal(remote.status, 200); assert.equal(remote.value.settings.text.baseUrl, 'https://text-config.example.test/v1'); assert.equal(remote.value.settings.text.protocol, 'anthropic'); assert.equal(remote.value.settings.text.visionEnabled, true);
  const local = await post(settings, '/api/provider-settings', { action: 'save', kind: 'text', baseUrl: 'http://localhost:11434/api/chat', protocol: 'ollama', local: true, model: 'local-model', apiKey: '' });
  assert.equal(local.status, 200); assert.equal(local.value.settings.text.baseUrl, 'http://localhost:11434'); assert.equal(local.value.settings.text.local, true); assert.equal(local.value.settings.text.visionEnabled, true); assert.equal(local.value.settings.text.keyConfigured, false);
  const effective = await withProviderSettings(userId, () => ({ ...getEffectiveProvider('text') })); assert.equal(effective.apiKey, ''); assert.equal(effective.protocol, 'ollama');
  const getResponse: Response = await withLocalRequest(() => settings.GET()); const reread = await getResponse.json() as { text: { local: boolean; keyConfigured: boolean; protocol: string } }; assert.equal(reread.text.local, true); assert.equal(reread.text.keyConfigured, false); assert.equal(reread.text.protocol, 'ollama');
  const disabled = await post(settings, '/api/provider-settings', { action: 'save', kind: 'text', visionEnabled: false }); assert.equal(disabled.status, 200); assert.equal(disabled.value.settings.text.visionEnabled, false);
  const restoreWithoutKey = await post(settings, '/api/provider-settings', { action: 'save', kind: 'text', baseUrl: 'https://text-config.example.test/v1', protocol: 'openai-responses', local: false }); assert.equal(restoreWithoutKey.status, 400);
  assert.equal((await withProviderSettings(userId, () => getEffectiveProvider('text'))).local, true);
  const remoteAgain = await post(settings, '/api/provider-settings', { action: 'save', kind: 'text', baseUrl: 'https://text-config.example.test/v1/responses', protocol: 'openai-responses', local: false, apiKey: 'fresh-text-cloud-test-only' });
  assert.equal(remoteAgain.status, 200); assert.equal(remoteAgain.value.settings.text.baseUrl, 'https://text-config.example.test/v1'); assert.equal(remoteAgain.value.settings.text.local, false); assert.equal(remoteAgain.value.settings.text.protocol, 'openai-responses');
  assert.equal(JSON.stringify(remoteAgain.value).includes('fresh-text-cloud-test-only'), false);
  for (const bad of [{ kind: 'image', protocol: 'anthropic' }, { kind: 'image', visionEnabled: false }, { kind: 'text', local: true, baseUrl: 'http://192.168.1.9:1234' }, { kind: 'text', protocol: 'unknown' }]) {
    assert.equal((await post(settings, '/api/provider-settings', { action: 'save', ...bad })).status, 400);
  }
  const localImage = await saveImage({ baseUrl: 'http://127.0.0.1:5678/v1', local: true, protocol: 'openai-chat', model: 'local-image', referenceModel: 'local-reference', promptStyle: 'custom', customPrompt: '{{prompt}} local', apiKey: '' });
  assert.equal(localImage.status, 200); assert.equal(localImage.value.settings.image.keyConfigured, false); assert.equal(localImage.value.settings.image.referenceModel, 'local-reference'); assert.equal(localImage.value.settings.image.customPrompt, '{{prompt}} local');
  assert.equal(localImage.value.settings.text.protocol, 'openai-responses'); assert.equal(calls.length, beforeCalls, 'saving settings never sends network requests');
});
