import sharp from 'sharp';
import { PalaceError } from './errors.ts';
import { normalizeBaseUrl, validateModel, type ProviderConfig } from './provider-config-core.ts';
import { MAX_PORTRAIT_REFERENCE_BYTES, type PortraitReference } from './portrait-reference.ts';
import { MAX_REFERENCE_PIXELS } from './novelai-reference.ts';
import { classifyProviderError } from './provider-error.ts';
import { beginProviderTrace, updateProviderTrace } from './provider-trace.ts';

export const MAX_COMPATIBLE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const invalidImage = () => new PalaceError('图片服务未返回一张有效的PNG、JPEG或WebP图片，或内容超出大小限制。', 502, 'IMAGE_FORMAT');
const invalidProvider = () => new PalaceError('图片服务未正确处理参考图请求，请确认配置的参考模型支持 /images/edits 文件上传接口。', 502, 'IMAGE_REFERENCE_PROVIDER');

/** 我会替主人一块一块地增量读取响应体——出错的情况也不例外，而且绝不轻信 Content-Length 声明值呀。 */
export async function readBoundedImageBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_COMPATIBLE_RESPONSE_BYTES) { try { await response.body?.cancel(); } catch {} throw invalidImage(); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_COMPATIBLE_RESPONSE_BYTES - length) throw invalidImage();
      chunks.push(value); length += value.byteLength;
    }
  } catch (error) { try { await reader.cancel(); } catch {} throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
}

/** 主人，这道门我守得很严呢——本函数不会主动去抓取任何 URL，生成的图片字节必须由配置好的服务商直接交到我手里才行。 */
export function decodeCompatibleImage(body: Uint8Array): { bytes: Uint8Array; contentType: string } {
  const text = new TextDecoder().decode(body); let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { throw invalidImage(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidImage();
  if (value.error !== undefined && value.error !== null) {
    const classified = classifyProviderError(200, text);
    if (classified.code === 'PROVIDER_QUOTA') throw classified;
    throw new PalaceError('图片服务返回了错误，未生成可保存的图片。请检查模型名称、权限和接口支持。', 502, 'IMAGE_REFERENCE_PROVIDER');
  }
  if (!Array.isArray(value.data) || value.data.length !== 1) throw invalidImage();
  const encoded = (value.data[0] as { b64_json?: unknown } | undefined)?.b64_json;
  if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw invalidImage();
  const cleaned = encoded.replace(/[\r\n]/g, '');
  if (cleaned.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) throw invalidImage();
  const bytes = new Uint8Array(Buffer.from(cleaned, 'base64'));
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw invalidImage();
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return { bytes, contentType: 'image/png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { bytes, contentType: 'image/jpeg' };
  if (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return { bytes, contentType: 'image/webp' };
  throw invalidImage();
}

export function isGptImageModel(model: string): boolean { return /(?:^|[\s\]\/])gpt-image-|^chatgpt-image-/i.test(model); }

/** 请容我替主人把标准 multipart 图片编辑流程的托盘端好：显式指定的模型名称会原样保留，同时上传实际的本地头像作为参考素材。 */
export async function generateCompatibleReferenceImage(config: Pick<ProviderConfig, 'baseUrl' | 'model' | 'apiKey' | 'local'>, prompt: string, reference: PortraitReference) {
  const model = validateModel(config.model), endpoint = `${normalizeBaseUrl(config.baseUrl, { local: config.local })}/images/edits`;
  let bytes: Uint8Array, width: number, height: number;
  try {
    if (!(reference.bytes instanceof Uint8Array) || !reference.bytes.length || reference.bytes.length > MAX_PORTRAIT_REFERENCE_BYTES) throw new Error('Invalid reference size');
    const input = sharp(reference.bytes, { limitInputPixels: MAX_REFERENCE_PIXELS, failOn: 'warning' });
    const meta = await input.metadata();
    if (!meta.format || !['png', 'jpeg', 'webp'].includes(meta.format) || reference.contentType !== `image/${meta.format}` || (meta.pages !== undefined && meta.pages !== 1)) throw new Error('Invalid reference format');
    width = meta.autoOrient.width; height = meta.autoOrient.height;
    if (!width || !height || width * height > MAX_REFERENCE_PIXELS) throw new Error('Invalid reference dimensions');
    bytes = new Uint8Array(await input.autoOrient().png().toBuffer());
    if (bytes.length > MAX_PORTRAIT_REFERENCE_BYTES) throw new Error('Encoded reference exceeds upload limit');
  } catch { throw new PalaceError('角色头像参考图无效，请重新生成不超过10MiB、2000万像素的PNG、JPEG或WebP头像。', 400, 'IMAGE_REFERENCE_INVALID'); }
  const highFidelity = /^(?:gpt-image-1|gpt-image-1\.5)$/i.test(model);
  const details = { sourceUrl: reference.sourceUrl, mode: 'character' as const, width, height };
  const trace = beginProviderTrace({ kind: 'image', model, endpoint, prompt, reference: details }, config.apiKey);
  const started = Date.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 150_000);
  try {
    if (!config.apiKey && !config.local) throw new PalaceError('照片生成需要配置图片模型密钥。', 503, 'IMAGE_NOT_CONFIGURED');
    const form = new FormData(); form.set('model', model); form.set('prompt', prompt); form.set('n', '1');
    form.set('image', new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }), 'character-reference.png');
    if (isGptImageModel(model)) { form.set('size', '1024x1536'); form.set('output_format', 'png'); if (highFidelity) form.set('input_fidelity', 'high'); }
    else form.set('response_format', 'b64_json');
    const response = await fetch(endpoint, { method: 'POST', headers: { ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}), Accept: 'application/json' }, body: form, redirect: 'manual', signal: controller.signal });
    const body = await readBoundedImageBody(response);
    if (!response.ok) throw classifyProviderError(response.status, new TextDecoder().decode(body));
    const result = decodeCompatibleImage(body);
    updateProviderTrace(trace, { status: 'ok', raw: `角色参考图片已返回：${result.bytes.length} bytes，${result.contentType}`, parsed: { contentType: result.contentType, bytes: result.bytes.length, reference: details } });
    return result;
  } catch (error) {
    const failure = error instanceof PalaceError ? error : controller.signal.aborted ? new PalaceError('角色参考生图响应超时，请稍后重试。', 504, 'PROVIDER_TIMEOUT') : invalidProvider();
    updateProviderTrace(trace, { status: 'error', error: failure.message }); throw failure;
  } finally { clearTimeout(timer); updateProviderTrace(trace, { elapsedMs: Date.now() - started }); }
}
