import type { Agent } from "../types.ts";
import { PalaceError } from "./errors.ts";

export interface PortraitReference {
  bytes: Uint8Array;
  contentType: string;
  sourceUrl: string;
}

export const MAX_PORTRAIT_REFERENCE_BYTES = 10 * 1024 * 1024;

const missing = () => new PalaceError("请先为这位角色生成头像，再生成保持角色外观一致的聊天图片。", 409, "IMAGE_REFERENCE_MISSING");
const invalid = () => new PalaceError("角色头像参考图无效，请重新生成头像后重试。支持不超过 10 MiB 的 PNG、JPEG 或 WebP 图片。", 400, "IMAGE_REFERENCE_INVALID");

function matchesSignature(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/png") {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (contentType === "image/webp") {
    return bytes.length >= 12
      && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
      && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80;
  }
  return false;
}

/** 我只会从属于主人的角色头像存储里取指定那份，绝不会去抓取任何外部 URL 呢。 */
export async function loadPortraitReference(
  agent: Pick<Agent, "id" | "portrait">,
  userId: string,
  bucket: Pick<R2Bucket, "get"> | undefined,
): Promise<PortraitReference> {
  if (!agent.portrait || agent.portrait.startsWith("/portraits/")) throw missing();
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(agent.id) || agent.id.startsWith("chat-")) throw invalid();
  const path = /^\/api\/portraits\/([a-zA-Z0-9_-]{1,100})(?:\?v=([a-zA-Z0-9_-]{1,100}))?$/.exec(agent.portrait);
  if (!path || path[1] !== agent.id || !userId || userId === "." || userId === "..") throw invalid();
  if (!bucket) throw new PalaceError("图片存储尚未配置，无法读取角色头像。", 503, "IMAGE_NOT_CONFIGURED");

  let object;
  try {
    object = await bucket.get(`portraits/${encodeURIComponent(userId)}/${agent.id}`);
  } catch {
    throw invalid();
  }
  if (!object) throw missing();
  const storedContentType = object.httpMetadata?.contentType;
  const contentType = typeof storedContentType === "string" ? storedContentType.split(";", 1)[0].trim().toLowerCase() : "";
  if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)
    || (object.size !== undefined && (!Number.isFinite(object.size) || object.size <= 0 || object.size > MAX_PORTRAIT_REFERENCE_BYTES))) {
    try { await object.body.cancel(); } catch { /* The invalid object is already rejected. */ }
    throw invalid();
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = object.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > MAX_PORTRAIT_REFERENCE_BYTES - size) throw invalid();
      size += value.byteLength;
      chunks.push(value.slice());
    }
  } catch {
    try { await reader?.cancel(); } catch { /* Preserve the public validation error. */ }
    throw invalid();
  } finally {
    reader?.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!matchesSignature(bytes, contentType)) throw invalid();
  return { bytes, contentType, sourceUrl: agent.portrait };
}
