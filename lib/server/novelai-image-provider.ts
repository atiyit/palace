import { unzipSync } from "fflate";
import { PalaceError } from "./errors.ts";
import { buildCharacterReferenceRequest, characterReferenceEndpoint } from "./novelai-reference.ts";
import type { PortraitReference } from "./portrait-reference.ts";
import type { EffectiveProviderConfig } from "./provider-config-core.ts";
import { classifyProviderError } from "./provider-error.ts";
import { beginProviderTrace, updateProviderTrace } from "./provider-trace.ts";

export const MAX_NATIVE_RESPONSE_BYTES = 32 * 1024 * 1024;
export const MAX_NATIVE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 64;
const REQUEST_TIMEOUT_MS = 150_000;

const invalidImage = () => new PalaceError("参考生图服务返回的图片无效、数量不符或超出大小限制。", 502, "IMAGE_FORMAT");
const invalidProvider = () => new PalaceError("图片服务未正确处理 NovelAI 角色参考请求。请确认服务支持原生 /ai/generate-image 接口后重试。", 502, "IMAGE_REFERENCE_PROVIDER");
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

async function boundedResponse(response: Response): Promise<Uint8Array> {
  const declaredSize = response.headers.get("content-length");
  if (declaredSize !== null && Number(declaredSize) > MAX_NATIVE_RESPONSE_BYTES) {
    try { await response.body?.cancel(); } catch { /* The response is already rejected. */ }
    throw invalidImage();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_NATIVE_RESPONSE_BYTES - size) throw invalidImage();
      size += value.byteLength;
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the bounded-read error. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function imageResult(bytes: Uint8Array): { bytes: Uint8Array; contentType: string } {
  if (!bytes.length || bytes.length > MAX_NATIVE_IMAGE_BYTES) throw invalidImage();
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length >= 8 && png.every((value, index) => bytes[index] === value)) return { bytes, contentType: "image/png" };
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { bytes, contentType: "image/jpeg" };
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return { bytes, contentType: "image/webp" };
  throw invalidImage();
}

function zipImage(bytes: Uint8Array): { bytes: Uint8Array; contentType: string } {
  try {
    let totalSize = 0;
    let entries = 0;
    const images: string[] = [];
    // 在分配任何解压缓冲区之前，我会先逐条核对所有条目的声明大小——箱子没验完不开封呢。
    unzipSync(bytes, { filter(file) {
      if (++entries > MAX_ZIP_ENTRIES || !Number.isSafeInteger(file.originalSize) || file.originalSize < 0
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_NATIVE_RESPONSE_BYTES
        || file.originalSize > MAX_NATIVE_IMAGE_BYTES - totalSize) throw invalidImage();
      totalSize += file.originalSize;
      if (/\.(png|jpe?g|webp)$/i.test(file.name)) {
        if (file.originalSize === 0 || file.size > MAX_NATIVE_IMAGE_BYTES) throw invalidImage();
        images.push(file.name);
        if (images.length > 1) throw invalidImage();
      }
      return false;
    } });
    if (images.length !== 1) throw invalidImage();
    const files = unzipSync(bytes, { filter: file => file.name === images[0] });
    const extracted = Object.values(files);
    if (extracted.length !== 1) throw invalidImage();
    return imageResult(extracted[0]);
  } catch {
    throw invalidImage();
  }
}

function jsonImage(bytes: Uint8Array): { bytes: Uint8Array; contentType: string } {
  let value: Record<string, unknown> | undefined;
  const text = new TextDecoder().decode(bytes);
  try { value = record(JSON.parse(text)); } catch { throw invalidProvider(); }
  if (!value) throw invalidProvider();
  if (value.error !== undefined && value.error !== null) {
    const classified = classifyProviderError(200, text);
    if (classified.code === "PROVIDER_QUOTA") throw classified;
    throw invalidProvider();
  }
  const native = value.images;
  const compatible = value.data;
  const list = Array.isArray(native) ? native : Array.isArray(compatible) ? compatible : undefined;
  if (!list || list.length !== 1) throw invalidImage();
  const item = record(list[0]);
  const encoded = Array.isArray(native) ? item?.image : item?.b64_json;
  if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(MAX_NATIVE_IMAGE_BYTES / 3) * 4) throw invalidImage();
  const base64 = encoded.replace(/[\r\n]/g, "");
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw invalidImage();
  return imageResult(Buffer.from(base64, "base64"));
}

/** 这道关我替主人把牢：只发一次请求，参考图请求失败时绝不允许回退为无参考的纯文本生图。 */
export async function generateReferenceImage(
  config: Pick<EffectiveProviderConfig, "baseUrl" | "model" | "apiKey" | "local">,
  prompt: string,
  reference: PortraitReference,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const request = await buildCharacterReferenceRequest(config.model, prompt, reference);
  const endpoint = characterReferenceEndpoint(config.baseUrl, config.local);
  const trace = beginProviderTrace({ kind: "image", model: request.model, endpoint, prompt, reference: request.reference }, config.apiKey);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    if (!config.apiKey && !config.local) throw new PalaceError("照片生成需要配置图片模型密钥。", 503, "IMAGE_NOT_CONFIGURED");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/zip", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify(request.body),
      redirect: "manual",
      signal: controller.signal,
    });
    const bytes = await boundedResponse(response);
    if (!response.ok) throw classifyProviderError(response.status, new TextDecoder().decode(bytes));
    const result = bytes[0] === 80 && bytes[1] === 75 ? zipImage(bytes) : jsonImage(bytes);
    updateProviderTrace(trace, {
      status: "ok",
      raw: `角色参考图片已返回：${result.bytes.length} bytes，${result.contentType}`,
      parsed: { contentType: result.contentType, bytes: result.bytes.length, reference: request.reference },
    });
    return result;
  } catch (error) {
    const failure = error instanceof PalaceError ? error : controller.signal.aborted
      ? new PalaceError("角色参考生图响应超时，本次操作未完成，请稍后重试。", 504, "PROVIDER_TIMEOUT")
      : invalidProvider();
    updateProviderTrace(trace, { status: "error", error: failure.message });
    throw failure;
  } finally {
    clearTimeout(timer);
    updateProviderTrace(trace, { elapsedMs: Date.now() - started });
  }
}
