import type { ProviderConfig } from './provider-config-core.ts';
import { PalaceError } from './errors.ts';

export interface TextImageInput { dataBase64: string; contentType: 'image/png' | 'image/jpeg' | 'image/webp'; label?: string; sourceUrl?: string; }
export interface TextRequest { endpoint: string; headers: Record<string, string>; body: Record<string, unknown>; }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;

/** 主人，只有显式启用视觉功能时，图片输入才会作为含像素的内容发送给服务商。 */
/** 主人，根据协议类型（OpenAI Chat/Responses、Anthropic、Ollama）构建文本请求。
 * 视觉图片仅在 visionEnabled 时附加（最多 2 张），并验证格式和大小。
 * 仅在 Chat Completions 分支中，匹配 o 系列或 GPT-5 及后续编号的模型使用 max_completion_tokens，且不设 temperature。 */
export function buildTextRequest(config: ProviderConfig, system: string, input: unknown, maxTokens: number, images: TextImageInput[] = []): TextRequest {
  const protocol = config.protocol || 'openai-chat';
  const selected = config.visionEnabled ? images.slice(0, 2) : [];
  for (const image of selected) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.contentType) || !image.dataBase64.length || image.dataBase64.length > 14_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64)) throw new PalaceError('提供给模型的图片格式无效。', 400, 'VISION_IMAGE_INVALID');
  }
  const userText = JSON.stringify(input);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const dataUrl = (image: TextImageInput) => `data:${image.contentType};base64,${image.dataBase64}`;
  if (protocol === 'anthropic') {
    headers['anthropic-version'] = '2023-06-01';
    if (config.apiKey) headers['x-api-key'] = config.apiKey;
    return { endpoint: `${config.baseUrl}/messages`, headers, body: {
      model: config.model, system, max_tokens: maxTokens, stream: false,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }, ...selected.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.contentType, data: image.dataBase64 } }))] }],
    } };
  }
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (protocol === 'openai-responses') return { endpoint: `${config.baseUrl}/responses`, headers, body: {
    model: config.model, instructions: system, max_output_tokens: maxTokens, stream: false, store: false,
    input: [{ role: 'user', content: [{ type: 'input_text', text: userText }, ...selected.map(image => ({ type: 'input_image', image_url: dataUrl(image) }))] }],
  } };
  if (protocol === 'ollama') return { endpoint: `${config.baseUrl}/api/chat`, headers, body: {
    model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: userText, ...(selected.length ? { images: selected.map(image => image.dataBase64) } : {}) }],
    stream: false, format: 'json', options: { num_predict: maxTokens, temperature: .75 },
  } };
  const reasoning = /^(?:o[1-9](?:-|$)|gpt-(?:[5-9]|\d{2,})(?:[.-]|$))/i.test(config.model);
  return { endpoint: `${config.baseUrl}/chat/completions`, headers, body: {
    model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: selected.length ? [{ type: 'text', text: userText }, ...selected.map(image => ({ type: 'image_url', image_url: { url: dataUrl(image) } }))] : userText }],
    ...(reasoning ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens, temperature: .75 }), stream: false,
  } };
}

/** 主人，思维链/推理区块绝不会被当作角色的正式回复来解析。 */
export function extractTextResult(protocol: ProviderConfig['protocol'], value: unknown): { text: string; tokens: number; finishReason?: string } {
  const result = record(value);
  if (result.error || result.type === 'error') throw new PalaceError('模型服务返回了错误；请检查模型名称、协议和图片识别支持情况。', 502, 'PROVIDER_ERROR');
  const usage = record(result.usage);
  if (protocol === 'anthropic') return {
    text: array(result.content).map(record).filter(block => block.type === 'text').map(block => typeof block.text === 'string' ? block.text : '').join(''),
    tokens: count(usage.input_tokens) + count(usage.output_tokens), finishReason: typeof result.stop_reason === 'string' ? result.stop_reason : undefined,
  };
  if (protocol === 'openai-responses') {
    if (result.status && !['completed', 'incomplete'].includes(String(result.status))) throw new PalaceError('模型尚未返回完成的回复。', 502, 'PROVIDER_ERROR');
    const outputText = array(result.output).map(record).filter(item => item.type === 'message').flatMap(item => array(item.content)).map(record).filter(item => item.type === 'output_text').map(item => typeof item.text === 'string' ? item.text : '').join('');
    const incomplete = record(result.incomplete_details);
    if (result.status === 'incomplete' && incomplete.reason !== 'max_output_tokens') throw new PalaceError('模型未完成回复，请检查服务返回限制。', 502, 'PROVIDER_ERROR');
    return { text: outputText, tokens: count(usage.total_tokens) || count(usage.input_tokens) + count(usage.output_tokens), finishReason: result.status === 'incomplete' ? 'max_tokens' : typeof result.status === 'string' ? result.status : undefined };
  }
  if (protocol === 'ollama') {
    if (result.done === false) throw new PalaceError('本地模型尚未完成回复。', 502, 'PROVIDER_ERROR');
    const message = record(result.message);
    return { text: typeof message.content === 'string' ? message.content : '', tokens: count(result.prompt_eval_count) + count(result.eval_count), finishReason: typeof result.done_reason === 'string' ? result.done_reason : undefined };
  }
  const choice = record(array(result.choices)[0]); const message = record(choice.message);
  return { text: typeof message.content === 'string' ? message.content : array(message.content).map(record).filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join(''), tokens: count(usage.total_tokens), finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : undefined };
}

export async function readTextResponse(response: Response, maxBytes = 2_000_000): Promise<string> {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new PalaceError('模型返回内容过大。', 502, 'PROVIDER_FORMAT');
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new PalaceError('模型返回内容过大。', 502, 'PROVIDER_FORMAT'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
