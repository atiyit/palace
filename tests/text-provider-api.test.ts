import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import sharp from 'sharp';
import type { AppState } from '../lib/types.ts';
import type { DebugResult } from '../lib/debug-types.ts';
import type { ProviderProtocol } from '../lib/server/provider-config-core.ts';

// All four provider formats traverse the real save/chat/debug handlers and an isolated SQLite save.
// Only HTTP transport is mocked; no request reaches a local or remote model service.
const prefix = 'palace-text-protocol-api-test-', fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
const oldDirectory = process.env.PALACE_DATA_DIR; process.env.PALACE_DATA_DIR = join(fixtureRoot, 'isolated-data');
const project = fileURLToPath(new URL('../', import.meta.url));
const vite = await createServer({ configFile: join(project, 'local/vite.config.ts'), server: { middlewareMode: true, hmr: false }, logLevel: 'silent' });
const { env } = await vite.ssrLoadModule(join(project, 'local/runtime.ts'));
if (oldDirectory === undefined) delete process.env.PALACE_DATA_DIR; else process.env.PALACE_DATA_DIR = oldDirectory;
const { withLocalRequest } = await vite.ssrLoadModule(join(project, 'local/auth.ts'));
const palace = await vite.ssrLoadModule(join(project, 'app/api/palace/route.ts'));
const settings = await vite.ssrLoadModule(join(project, 'app/api/provider-settings/route.ts'));
const debug = await vite.ssrLoadModule(join(project, 'app/api/debug/route.ts'));
const uploads = await vite.ssrLoadModule(join(project, 'app/api/chat-uploads/route.ts'));
const { mutateState } = await vite.ssrLoadModule(join(project, 'lib/server/store.ts'));
const { createInitialState } = await vite.ssrLoadModule(join(project, 'lib/seeds.ts'));
const origin = 'http://127.0.0.1:5199';
type Call = { url: string; headers: Headers; body: any };
const calls: Call[] = [], responses: unknown[] = []; const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = String(url); const parsed = new URL(target);
  assert.ok(['multi-protocol.example.test', 'localhost', '127.0.0.1'].includes(parsed.hostname), 'unexpected provider destination');
  assert.equal(init?.redirect, 'manual'); assert.equal(init?.method, 'POST');
  const body = JSON.parse(String(init?.body)); calls.push({ url: target, headers: new Headers(init?.headers), body });
  assert.ok(responses.length, 'no unscripted model calls are permitted');
  if (target.endsWith('/images/generations')) return Response.json(responses.shift());
  const response = JSON.stringify(responses.shift());
  if (target.endsWith('/api/chat')) return Response.json({ model: body.model, message: { role: 'assistant', content: response }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 10 });
  if (target.endsWith('/messages')) return Response.json({ id: 'mock-message', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: response }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } });
  if (target.endsWith('/responses')) return Response.json({ id: 'mock-response', status: 'completed', model: body.model, output: [{ id: 'mock-output', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: response, annotations: [] }] }], usage: { total_tokens: 20, input_tokens: 10, output_tokens: 10 } });
  assert.ok(target.endsWith('/chat/completions'));
  return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: response } }], usage: { total_tokens: 20 } });
};
after(async context => {
  globalThis.fetch = originalFetch; await vite.close();
  if (!existsSync(fixtureRoot)) return;
  const target = realpathSync(fixtureRoot); assert.equal(dirname(target), realpathSync(tmpdir())); assert.ok(basename(target).startsWith(prefix));
  try { rmSync(target, { recursive: true, force: true }); }
  catch (error) { if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error; if ('diagnostic' in context) context.diagnostic('Only this isolated fixture may remain locked until SQLite exits.'); }
});
async function post<T = any>(module: Record<string, any>, path: string, body: object) {
  const response: Response = await withLocalRequest(() => module.POST(new Request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })));
  return { status: response.status, value: await response.json() as T };
}
const act = (action: string, body: object) => post(palace, '/api/palace', { action, requestId: crypto.randomUUID(), ...body });
async function getState(): Promise<AppState> { const response: Response = await withLocalRequest(() => palace.GET()); assert.equal(response.status, 200); return response.json(); }
const approved = { pass: true, reason: '符合人设与实际信息。' };
const provider = (protocol: ProviderProtocol, local = protocol === 'ollama') => ({ action: 'save', kind: 'text', protocol, local, baseUrl: local ? protocol === 'ollama' ? 'http://localhost:11434' : 'http://127.0.0.1:1234/v1' : 'https://multi-protocol.example.test/v1', model: `fixture-${protocol}`, apiKey: local ? '' : 'protocol-api-test-only' });
const endpoint = (protocol: ProviderProtocol, local = protocol === 'ollama') => `${provider(protocol, local).baseUrl}${protocol === 'ollama' ? '/api/chat' : protocol === 'anthropic' ? '/messages' : protocol === 'openai-responses' ? '/responses' : '/chat/completions'}`;

test('real chat uses each configured text protocol for both actor and independent review, including keyless Ollama and LM Studio', async () => {
  const person = (await getState()).agents[0]; assert.equal((await act('hire', { agentId: person.id })).status, 200);
  for (const [protocol, local] of [['openai-chat', false], ['openai-responses', false], ['anthropic', false], ['ollama', true], ['openai-chat', true]] as [ProviderProtocol, boolean][]) {
    const saved = await post(settings, '/api/provider-settings', provider(protocol, local)); assert.equal(saved.status, 200); assert.equal(saved.value.settings.text.protocol, protocol); assert.equal(saved.value.settings.text.local, local);
    assert.equal((await getState()).config.textReady, true, 'a configured local model works without an API key');
    const count = calls.length, content = `${protocol}-${local}: 我先整理任务的优先级。`;
    responses.push({ kind: 'submit', content, memories: [] }, approved);
    const result = await act('chat', { agentId: person.id, message: `请用 ${protocol} 帮我安排今天。` }); assert.equal(result.status, 200); assert.equal(responses.length, 0);
    const reply = (result.value.state as AppState).agents.find(agent => agent.id === person.id)!.chats.at(-1)!;
    assert.equal(reply.content, content); assert.equal(reply.checked, true); assert.equal(calls.length - count, 2);
    for (const call of calls.slice(count)) {
      assert.equal(call.url, endpoint(protocol, local)); assert.equal(call.body.model, `fixture-${protocol}`);
      if (local) { assert.equal(call.headers.has('authorization'), false); assert.equal(call.headers.has('x-api-key'), false); }
      else if (protocol === 'anthropic') { assert.equal(call.headers.get('x-api-key'), 'protocol-api-test-only'); assert.equal(call.headers.get('anthropic-version'), '2023-06-01'); assert.equal(call.headers.has('authorization'), false); assert.equal(typeof call.body.system, 'string'); }
      else assert.equal(call.headers.get('authorization'), 'Bearer protocol-api-test-only');
      if (protocol === 'openai-responses') { assert.ok(call.body.input); assert.ok(call.body.max_output_tokens > 0); assert.equal(call.body.messages, undefined); }
      if (protocol === 'ollama') { assert.equal(call.body.stream, false); assert.ok(call.body.options.num_predict > 0); }
    }
    const beforePreview = calls.length;
    const preview = await post<DebugResult>(debug, '/api/debug', { action: 'preview', stage: 'actor', agentId: person.id });
    assert.equal(preview.status, 200); assert.equal(preview.value.status, 'preview'); assert.equal(preview.value.trace[0].endpoint, endpoint(protocol, local)); assert.equal(calls.length, beforePreview);
    assert.equal(JSON.stringify(preview.value).includes('protocol-api-test-only'), false);
  }
});

test('switching local services back to remote never reuses the local or previously configured cloud credential', async () => {
  const before = calls.length;
  const blocked = await post(settings, '/api/provider-settings', { action: 'save', kind: 'text', baseUrl: 'https://multi-protocol.example.test/v1', local: false, protocol: 'openai-chat', apiKey: '' }); assert.equal(blocked.status, 400);
  const current: Response = await withLocalRequest(() => settings.GET()); const configuration = await current.json() as { text: { local: boolean; keyConfigured: boolean } };
  assert.equal(configuration.text.local, true); assert.equal(configuration.text.keyConfigured, false); assert.equal(calls.length, before);
});

function imagePayloads(value: unknown): string[] {
  if (typeof value === 'string') return value.startsWith('data:image/') ? [value.slice(value.indexOf(',') + 1)] : [];
  if (Array.isArray(value)) return value.flatMap(imagePayloads);
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  const own = item.type === 'base64' && typeof item.data === 'string' ? [item.data] : [];
  return [...own, ...Object.entries(item).flatMap(([key, entry]) => key === 'images' && Array.isArray(entry) ? entry.filter((image): image is string => typeof image === 'string') : imagePayloads(entry))];
}

test('uploaded image and user avatar pixels reach actor and reviewer under all explicitly enabled vision protocols', async () => {
  const avatar = new Uint8Array(await sharp({ create: { width: 12, height: 18, channels: 3, background: '#BB4400' } }).png().toBuffer());
  const uploaded = new Uint8Array(await sharp({ create: { width: 15, height: 10, channels: 3, background: '#2266AA' } }).png().toBuffer());
  const avatarUrl = '/api/portraits/user-profile?v=vision-fixture';
  await env.BUCKET.put('portraits/local-owner/user-profile', avatar, { httpMetadata: { contentType: 'image/png' } });
  await mutateState('local-owner', crypto.randomUUID(), createInitialState, async (state: AppState) => {
    state.userProfile = { name: '路由测试用户', description: '喜欢讨论图片里的设计。', preferences: '先解释再给建议。', avatar: avatarUrl, updatedAt: new Date().toISOString() };
  });
  const person = (await getState()).agents[0];
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'ollama'] as ProviderProtocol[]) {
    const configured = await post(settings, '/api/provider-settings', { ...provider(protocol), visionEnabled: true }); assert.equal(configured.status, 200);
    const beforeUpload = calls.length;
    const upload = await post(uploads, '/api/chat-uploads', { dataBase64: Buffer.from(uploaded).toString('base64'), contentType: 'image/png', name: 'vision-fixture.png', requestId: crypto.randomUUID() });
    assert.equal(upload.status, 200); assert.equal(calls.length, beforeUpload, 'uploading files does not contact the model'); assert.ok(upload.value.image.id);
    const imageId = upload.value.image.id as string;
    assert.ok((upload.value.state as AppState).userUploads!.some(image => image.id === imageId));
    responses.push({ kind: 'submit', content: `${protocol}：我收到你的图片了。`, memories: [] }, approved);
    const result = await act('chat', { agentId: person.id, imageId }); assert.equal(result.status, 200); assert.equal(responses.length, 0);
    const state = result.value.state as AppState, recent = state.agents.find(agent => agent.id === person.id)!.chats;
    assert.equal(recent.at(-1)!.checked, true); assert.equal(recent.at(-2)!.attachments?.[0]?.id, imageId);
    assert.equal(state.userUploads!.some(image => image.id === imageId), false); assert.equal(state.userProfile!.avatar, avatarUrl);
    assert.equal(JSON.stringify(state).includes(Buffer.from(uploaded).toString('base64')), false, 'stored state references local image objects rather than duplicating pixels');
    assert.equal(calls.length - beforeUpload, 2, 'actor and independent reviewer both receive this turn');
    for (const call of calls.slice(beforeUpload)) {
      const pixels = imagePayloads(call.body); assert.equal(pixels.length, 2, `${protocol} must send the actual avatar and latest upload`);
      const colors: string[] = [];
      for (const encoded of pixels) colors.push((await sharp(Buffer.from(encoded, 'base64')).removeAlpha().raw().toBuffer()).subarray(0, 3).join(','));
      assert.deepEqual(colors.sort(), ['187,68,0', '34,102,170'].sort());
      assert.ok(JSON.stringify(call.body).includes('路由测试用户'));
    }
  }
  const other = (await getState()).agents[1]; assert.equal((await act('hire', { agentId: other.id })).status, 200);
  const beforeOther = calls.length; responses.push({ kind: 'submit', content: '我只收到了你的头像。', memories: [] }, approved);
  assert.equal((await act('chat', { agentId: other.id, message: '你好。' })).status, 200);
  for (const call of calls.slice(beforeOther)) {
    const pixels = imagePayloads(call.body); assert.equal(pixels.length, 1, 'another member never receives pictures from the first member private conversation');
    assert.equal((await sharp(Buffer.from(pixels[0], 'base64')).removeAlpha().raw().toBuffer()).subarray(0, 3).join(','), '187,68,0');
  }
  const disabled = await post(settings, '/api/provider-settings', { ...provider('ollama'), visionEnabled: false }); assert.equal(disabled.status, 200);
  const queued = await post(uploads, '/api/chat-uploads', { dataBase64: Buffer.from(uploaded).toString('base64'), contentType: 'image/png', requestId: crypto.randomUUID() }); assert.equal(queued.status, 200);
  const beforeDisabled = calls.length;
  responses.push({ kind: 'submit', content: '当前未启用视觉，我可以根据你的文字描述讨论。', memories: [] }, approved);
  const result = await act('chat', { agentId: person.id, imageId: queued.value.image.id, message: '保留这张图。' }); assert.equal(result.status, 200);
  assert.equal(calls.length - beforeDisabled, 2); for (const call of calls.slice(beforeDisabled)) assert.deepEqual(imagePayloads(call.body), []);
  const saved = (result.value.state as AppState).agents.find(agent => agent.id === person.id)!.chats.at(-2)!;
  assert.equal(saved.attachments?.[0]?.id, queued.value.image.id, 'disabled vision still preserves the user attachment');
  const beforeMissing = calls.length; const missing = await act('chat', { agentId: person.id, imageId: crypto.randomUUID() });
  assert.equal(missing.status, 400); assert.equal(missing.value.code, 'CHAT_IMAGE_NOT_FOUND'); assert.equal(calls.length, beforeMissing, 'an invented attachment id cannot reach a model');
});

test('user-profile debug previews and runs use the chosen native endpoint and draft prompt without saving user facts', async () => {
  assert.equal((await post(settings, '/api/provider-settings', provider('anthropic'))).status, 200);
  const before = await getState(), beforeCalls = calls.length;
  const request = { stage: 'user-profile', promptId: 'user.profile', input: { brief: '请叫我临时草稿，喜欢写故事。' }, draftOverrides: { 'user.profile': 'PROFILE_DEBUG_OVERRIDE: produce an editable profile with name, description, preferences.' } };
  const preview = await post<DebugResult>(debug, '/api/debug', { ...request, action: 'preview' });
  assert.equal(preview.status, 200); assert.equal(preview.value.status, 'preview'); assert.equal(preview.value.persisted, false);
  assert.equal(preview.value.trace[0].endpoint, endpoint('anthropic')); assert.equal(preview.value.trace[0].protocol, 'anthropic');
  assert.ok(preview.value.trace[0].messages![0].content.includes('PROFILE_DEBUG_OVERRIDE'));
  assert.ok(preview.value.trace[0].messages![1].content.includes('请叫我临时草稿'));
  assert.equal(calls.length, beforeCalls); assert.deepEqual(await getState(), before);
  const draft = { name: '临时草稿', description: '喜欢写故事。', preferences: '希望一起讨论情节。' };
  responses.push(draft);
  const run = await post<DebugResult>(debug, '/api/debug', { ...request, action: 'run' });
  assert.equal(run.status, 200); assert.equal(run.value.status, 'ok'); assert.equal(run.value.persisted, false); assert.deepEqual(run.value.output, draft);
  assert.equal(calls.length, beforeCalls + 1); assert.ok(calls.at(-1)!.body.system.includes('PROFILE_DEBUG_OVERRIDE'));
  assert.deepEqual(await getState(), before, 'sandbox output and temporary prompt do not replace the saved profile or prompts');
  assert.equal(JSON.stringify(run.value.trace).includes('protocol-api-test-only'), false);
});

test('user-portrait debug substitutes custom template variables and never replaces the saved avatar', async () => {
  assert.equal((await post(settings, '/api/provider-settings', { action: 'save', kind: 'image', protocol: 'openai-chat', local: false, baseUrl: 'https://multi-protocol.example.test/v1', model: 'gpt-image-1', referenceModel: 'gpt-image-1', promptStyle: 'default', apiKey: 'image-debug-test-only' })).status, 200);
  const before = await getState(), beforeCalls = calls.length;
  const originalAvatar = await env.BUCKET.get('portraits/local-owner/user-profile');
  assert.ok(originalAvatar); const originalBytes = new Uint8Array(await new Response(originalAvatar.body).arrayBuffer());
  const request = { stage: 'user-portrait', promptId: 'user.portrait.template', input: { name: '临时头像', description: '蓝色围巾', preferences: '安静', request: '像素风格' }, draftOverrides: { 'user.portrait.template': 'PORTRAIT_DEBUG_OVERRIDE: {{name}} / {{description}} / {{preferences}} / {{request}}' } };
  const expectedPrompt = 'PORTRAIT_DEBUG_OVERRIDE: 临时头像 / 蓝色围巾 / 安静 / 像素风格';
  const preview = await post<DebugResult>(debug, '/api/debug', { ...request, action: 'preview' });
  assert.equal(preview.status, 200); assert.equal(preview.value.status, 'preview'); assert.equal(preview.value.persisted, false);
  assert.equal(preview.value.trace[0].kind, 'text'); assert.ok(preview.value.trace[0].messages![1].content.includes(expectedPrompt));
  assert.equal(calls.length, beforeCalls); assert.deepEqual(await getState(), before);
  const generated = await sharp({ create: { width: 8, height: 12, channels: 3, background: '#1100DD' } }).png().toBuffer();
  responses.push({ prompt: expectedPrompt, negativePrompt: '' }, { data: [{ b64_json: generated.toString('base64') }] });
  const run = await post<DebugResult>(debug, '/api/debug', { ...request, action: 'run' });
  assert.equal(run.status, 200); assert.equal(run.value.status, 'ok'); assert.equal(run.value.persisted, false);
  assert.equal(run.value.imageDataUrl, `data:image/png;base64,${generated.toString('base64')}`); assert.equal(calls.length, beforeCalls + 2); assert.equal(calls.at(-1)!.body.prompt, expectedPrompt);
  assert.deepEqual(await getState(), before);
  const savedAvatar = await env.BUCKET.get('portraits/local-owner/user-profile'); assert.ok(savedAvatar);
  assert.deepEqual(new Uint8Array(await new Response(savedAvatar.body).arrayBuffer()), originalBytes, 'running avatar preview never overwrites stored user pixels');
  assert.equal(JSON.stringify(run.value.trace).includes('image-debug-test-only'), false); assert.equal(JSON.stringify(run.value.trace).includes(generated.toString('base64')), false);
});

test('vision debug traces reveal only image metadata and sandbox chat does not consume a pending upload', async () => {
  assert.equal((await post(settings, '/api/provider-settings', { ...provider('openai-responses'), visionEnabled: true })).status, 200);
  const uploaded = await sharp({ create: { width: 7, height: 11, channels: 3, background: '#22AA55' } }).png().toBuffer();
  const upload = await post(uploads, '/api/chat-uploads', { dataBase64: uploaded.toString('base64'), contentType: 'image/png', name: 'debug-only.png', requestId: crypto.randomUUID() }); assert.equal(upload.status, 200);
  const before = await getState(), beforeCalls = calls.length, agentId = before.agents[0].id;
  const request = { stage: 'chat', agentId, input: { message: '这张图是什么颜色？', imageId: upload.value.image.id } };
  const preview = await post<DebugResult>(debug, '/api/debug', { ...request, action: 'preview' });
  assert.equal(preview.status, 200); assert.equal(preview.value.status, 'preview'); assert.equal(calls.length, beforeCalls);
  assert.equal(preview.value.trace[0].endpoint, endpoint('openai-responses')); assert.equal(preview.value.trace[0].inputImages?.length, 2);
  for (const metadata of preview.value.trace[0].inputImages!) { assert.ok(metadata.sourceUrl?.startsWith('/api/portraits/')); assert.equal(metadata.contentType, 'image/png'); assert.ok(metadata.bytes > 0); }
  assert.deepEqual(await getState(), before);
  responses.push({ kind: 'submit', content: '图片以绿色为主。', memories: [] }, approved);
  const run = await post<DebugResult>(debug, '/api/debug', { ...request, action: 'run' });
  assert.equal(run.status, 200); assert.equal(run.value.status, 'ok'); assert.equal(run.value.persisted, false); assert.equal(calls.length, beforeCalls + 2);
  assert.equal(run.value.trace.length, 2);
  const traceText = JSON.stringify({ preview: preview.value.trace, run: run.value.trace });
  for (const call of calls.slice(beforeCalls)) for (const pixels of imagePayloads(call.body)) assert.equal(traceText.includes(pixels), false, 'raw pixels are confined to provider transport');
  assert.equal(traceText.includes('data:image/'), false); assert.equal(traceText.includes('protocol-api-test-only'), false); assert.equal(traceText.includes('image-debug-test-only'), false);
  assert.deepEqual(await getState(), before, 'the sandbox does not append chats, change memory, or consume pending user images');
});
