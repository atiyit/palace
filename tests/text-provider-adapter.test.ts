import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTextRequest, extractTextResult, readTextResponse, type TextImageInput } from '../lib/server/text-provider-adapter.ts';
import type { ProviderConfig, ProviderProtocol } from '../lib/server/provider-config-core.ts';
import { parseModelObject } from '../lib/server/model-json.ts';

const config = (protocol: ProviderProtocol, overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({ protocol, baseUrl: 'https://adapter.example.test/v1', model: 'fixture-model', apiKey: 'test-key-only', ...overrides });
const image: TextImageInput = { dataBase64: 'cGl4ZWxz', contentType: 'image/png', label: '用户头像', sourceUrl: '/api/portraits/user-profile' };
const input = { message: '请看这张图片。' }, system = 'Respond with a JSON object.';
const errorCode = (code: string) => (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === code;

test('cloud protocols use their native message, image, authentication, and token contracts', () => {
  const chat = buildTextRequest(config('openai-chat', { visionEnabled: true }), system, input, 512, [image]);
  assert.equal(chat.endpoint, 'https://adapter.example.test/v1/chat/completions');
  assert.equal(chat.headers.Authorization, 'Bearer test-key-only');
  assert.deepEqual(chat.body.messages, [{ role: 'system', content: system }, { role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,cGl4ZWxz' } }] }]);
  assert.equal(chat.body.max_tokens, 512);

  const responses = buildTextRequest(config('openai-responses', { visionEnabled: true }), system, input, 512, [image]);
  assert.equal(responses.endpoint, 'https://adapter.example.test/v1/responses');
  assert.equal(responses.body.instructions, system); assert.equal(responses.body.max_output_tokens, 512);
  assert.equal(responses.body.store, false); assert.equal(responses.body.messages, undefined);
  assert.deepEqual(responses.body.input, [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(input) }, { type: 'input_image', image_url: 'data:image/png;base64,cGl4ZWxz' }] }]);

  const anthropic = buildTextRequest(config('anthropic', { visionEnabled: true }), system, input, 512, [image]);
  assert.equal(anthropic.endpoint, 'https://adapter.example.test/v1/messages');
  assert.equal(anthropic.headers['x-api-key'], 'test-key-only'); assert.equal(anthropic.headers['anthropic-version'], '2023-06-01'); assert.equal(anthropic.headers.Authorization, undefined);
  assert.equal(anthropic.body.system, system); assert.equal(anthropic.body.max_tokens, 512); assert.equal(anthropic.body.temperature, undefined);
  assert.deepEqual(anthropic.body.messages, [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.dataBase64 } }] }]);
});

test('native Ollama can run keyless and sends raw image base64 in a non-streaming JSON request', () => {
  const request = buildTextRequest(config('ollama', { baseUrl: 'http://127.0.0.1:11434', local: true, apiKey: '', visionEnabled: true }), system, input, 700, [image]);
  assert.equal(request.endpoint, 'http://127.0.0.1:11434/api/chat'); assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.body.stream, false); assert.equal(request.body.format, 'json');
  assert.deepEqual(request.body.options, { num_predict: 700, temperature: .75 });
  assert.deepEqual(request.body.messages, [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input), images: [image.dataBase64] }]);
});

test('vision must be enabled explicitly and only the two selected images enter the wire payload', () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'ollama'] as ProviderProtocol[]) {
    const disabled = buildTextRequest(config(protocol), system, input, 100, [image, { ...image, dataBase64: '!invalid!' }]);
    assert.equal(JSON.stringify(disabled.body).includes(image.dataBase64), false, `${protocol}: disabled vision cannot leak pixels`);
    assert.throws(() => buildTextRequest(config(protocol, { visionEnabled: true }), system, input, 100, [{ ...image, dataBase64: '!invalid!' }]), errorCode('VISION_IMAGE_INVALID'));
    const enabled = buildTextRequest(config(protocol, { visionEnabled: true }), system, input, 100, [image, image, { ...image, dataBase64: '!third-not-selected!' }]);
    assert.equal(JSON.stringify(enabled.body).split(image.dataBase64).length - 1, 2);
    assert.equal(JSON.stringify(enabled.body).includes(image.sourceUrl!), false, 'local source URLs are metadata, not fetchable image inputs');
  }
});

test('GPT-5 and reasoning models omit unsupported temperature and use completion token limits', () => {
  for (const model of ['gpt-5', 'gpt-5.4', 'gpt-5-mini', 'o3', 'o4-mini']) {
    const { body } = buildTextRequest(config('openai-chat', { model }), system, input, 900);
    assert.equal(body.max_completion_tokens, 900, model); assert.equal(body.max_tokens, undefined, model); assert.equal(body.temperature, undefined, model);
  }
  for (const model of ['gpt-4.1', 'claude-opus-4-6', 'deepseek-flash']) {
    const { body } = buildTextRequest(config('openai-chat', { model }), system, input, 900);
    assert.equal(body.max_tokens, 900); assert.equal(body.max_completion_tokens, undefined);
  }
});

test('response extraction ignores thinking and reasoning blocks, including JSON-looking decoys', () => {
  const decoy = '{"privateThinking":true}', actual = '{"reply":"visible"}';
  assert.deepEqual(extractTextResult('anthropic', { content: [{ type: 'thinking', thinking: decoy, text: decoy }, { type: 'text', text: actual }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 6 } }), { text: actual, tokens: 10, finishReason: 'end_turn' });
  assert.deepEqual(extractTextResult('openai-responses', { status: 'completed', output: [{ type: 'reasoning', content: [{ type: 'output_text', text: decoy }] }, { type: 'message', content: [{ type: 'refusal', refusal: decoy }, { type: 'output_text', text: actual }] }], usage: { input_tokens: 4, output_tokens: 6 } }), { text: actual, tokens: 10, finishReason: 'completed' });
  assert.equal(extractTextResult('openai-chat', { choices: [{ message: { reasoning_content: decoy, content: [{ type: 'reasoning', text: decoy }, { type: 'text', text: actual }] }, finish_reason: 'stop' }] }).text, actual);
  assert.equal(extractTextResult('ollama', { message: { thinking: decoy, content: actual }, done: true, done_reason: 'stop' }).text, actual);
});

test('truncated Responses output maps to the existing JSON truncation error, while other incomplete states fail explicitly', () => {
  const result = extractTextResult('openai-responses', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: '{"reply":' }] }] });
  assert.equal(result.finishReason, 'max_tokens');
  assert.throws(() => parseModelObject(result.text, result.finishReason), errorCode('PROVIDER_TRUNCATED'));
  for (const value of [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, { status: 'failed' }, { status: 'in_progress' }, { status: 'queued' }]) assert.throws(() => extractTextResult('openai-responses', value), errorCode('PROVIDER_ERROR'));
  assert.throws(() => extractTextResult('ollama', { done: false, message: { content: '{"premature":true}' } }), errorCode('PROVIDER_ERROR'));
});

test('HTTP-200 error envelopes are rejected before extracting any apparent answer', () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'ollama'] as ProviderProtocol[]) {
    assert.throws(() => extractTextResult(protocol, { error: { message: 'provider refused' }, choices: [{ message: { content: '{"fakeSuccess":true}' } }] }), errorCode('PROVIDER_ERROR'));
    assert.throws(() => extractTextResult(protocol, { type: 'error', message: 'provider refused' }), errorCode('PROVIDER_ERROR'));
  }
});

test('response reading enforces byte bounds even without trustworthy content length and cancels an oversized stream', async () => {
  await assert.rejects(readTextResponse(new Response('small', { headers: { 'content-length': '100' } }), 10), errorCode('PROVIDER_FORMAT'));
  let cancelled = false, cursor = 0;
  const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([7])];
  const body = new ReadableStream<Uint8Array>({ pull(controller) { if (cursor < chunks.length) controller.enqueue(chunks[cursor++]); else controller.close(); }, cancel() { cancelled = true; } });
  await assert.rejects(readTextResponse(new Response(body, { headers: { 'content-length': '1' } }), 5), errorCode('PROVIDER_FORMAT'));
  assert.equal(cancelled, true);
  await assert.rejects(readTextResponse(new Response('你好'), 5), errorCode('PROVIDER_FORMAT'));
  assert.equal(await readTextResponse(new Response('你好'), 6), '你好');
  assert.equal(await readTextResponse(new Response(null)), '');
});
