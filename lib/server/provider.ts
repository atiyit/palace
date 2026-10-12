import { env } from "cloudflare:workers";
import { PalaceError } from "./errors";
import { parseModelObject } from "./model-json";
import { getEffectiveProvider } from "./provider-settings";
import { DEFAULT_TEXT_MODEL, defaultReferenceModel, type ProviderKind } from "./provider-config-core";
import { beginProviderTrace, updateProviderTrace, isProviderPreview } from "./provider-trace";
import type { DebugTrace } from "@/lib/debug-types";
import { classifyProviderError } from "./provider-error";
import type { PortraitReference } from "./portrait-reference";
import { generateReferenceImage } from "./novelai-image-provider";
import { generateCompatibleReferenceImage, isGptImageModel } from './compatible-image-provider';
import { buildTextRequest, extractTextResult, readTextResponse, type TextImageInput } from './text-provider-adapter';

export const DEFAULT_MODEL = DEFAULT_TEXT_MODEL;
export const modelName = () => getEffectiveProvider("text").model;
export const imageModelName = () => getEffectiveProvider("image").model;
export const referenceImageModelName = () => { const config = getEffectiveProvider('image'); return config.referenceModel ?? defaultReferenceModel(config.model); };
export const providerReady = () => { const config = getEffectiveProvider('text'); return Boolean((config.apiKey || config.local) && config.model && config.baseUrl); };
export const imageReady = () => { const config = getEffectiveProvider('image'); return Boolean((config.apiKey || config.local) && config.model && config.baseUrl && env.BUCKET); };

export function requireProvider(): void {
  if (!providerReady() && !isProviderPreview()) throw new PalaceError("尚未配置服务端模型密钥，暂时不能招募或运行 Agent。", 503, "MODEL_NOT_CONFIGURED");
}

async function providerRequest(kind: ProviderKind, path: string, body: unknown, timeoutMs = 45_000, trace?: DebugTrace): Promise<Record<string, unknown>> {
  const config = getEffectiveProvider(kind);
  if (!config.apiKey && !config.local) throw new PalaceError(kind === "text" ? "尚未配置文本模型密钥，请在庭院设置中填写。" : "尚未配置图片模型密钥，请在庭院设置中填写。", 503, "MODEL_NOT_CONFIGURED");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(180_000, timeoutMs)));
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
    if (!response.ok) {
      const errorText = await response.text();
      updateProviderTrace(trace, { raw: errorText.slice(0, 100_000) });
      throw classifyProviderError(response.status, errorText);
    }
    const text = await response.text();
    if (text.length > 32_000_000) throw new PalaceError("模型返回内容过大。", 502, "PROVIDER_FORMAT");
    if (kind === "text") updateProviderTrace(trace, { raw: text });
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PalaceError) throw error;
    console.error('Model transport failed', error instanceof Error ? { name: error.name } : { name: 'UnknownError' });
    if (controller.signal.aborted) throw new PalaceError("模型响应超时，本次操作未完成。请稍后重试。", 504, "PROVIDER_TIMEOUT");
    throw new PalaceError("无法连接模型服务，或服务返回了无法解析的内容。", 502, "PROVIDER_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

export async function completeJson(system: string, input: unknown, maxTokens = 1400, timeoutMs = 45_000, images: TextImageInput[] = []): Promise<{ value: unknown; tokens: number }> {
  const config = getEffectiveProvider("text");
  const messages = [{ role: "system", content: system }, { role: "user", content: JSON.stringify(input) }];
  const request = buildTextRequest(config, system, input, maxTokens, images);
  const trace = beginProviderTrace({ kind: "text", model: config.model, endpoint: request.endpoint, messages, protocol: config.protocol || 'openai-chat',
    ...(config.visionEnabled && images.length ? { inputImages: images.slice(0, 2).map(image => ({ label: image.label, sourceUrl: image.sourceUrl, contentType: image.contentType, bytes: Math.floor(image.dataBase64.length * .75) })) } : {}),
  }, config.apiKey);
  requireProvider();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(180_000, timeoutMs)));
  const started = Date.now();
  try {
    const response = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal, redirect: 'manual' });
    const raw = await readTextResponse(response);
    if (!response.ok) { updateProviderTrace(trace, { raw }); throw classifyProviderError(response.status, raw); }
    const { text, tokens, finishReason } = extractTextResult(config.protocol, JSON.parse(raw));
    updateProviderTrace(trace, { raw: text, tokens, finishReason });
    const value = parseModelObject(text, finishReason);
    updateProviderTrace(trace, { parsed: value, status: "ok" });
    return { value, tokens };
  } catch (error) {
    const failure = error instanceof PalaceError ? error : controller.signal.aborted
      ? new PalaceError('模型响应超时，本次操作未完成。请稍后重试。', 504, 'PROVIDER_TIMEOUT')
      : new PalaceError('无法连接模型服务，或服务返回了无法解析的内容。请检查接口协议和模型名称。', 502, 'PROVIDER_ERROR');
    updateProviderTrace(trace, { status: "error", error: failure.message });
    throw failure;
  } finally { clearTimeout(timer); updateProviderTrace(trace, { elapsedMs: Date.now() - started }); }
}

export async function generatePortrait(prompt: string, reference?: PortraitReference): Promise<{ bytes: Uint8Array; contentType: string }> {
  const config = getEffectiveProvider("image");
  if (!config.apiKey && !config.local && !isProviderPreview()) throw new PalaceError("照片生成需要配置图片模型密钥。", 503, "IMAGE_NOT_CONFIGURED");
  if (reference) {
    const referenceConfig = { ...config, model: referenceImageModelName() };
    return /^nai-diffusion-4-5-(?:full|curated)$/.test(referenceConfig.model)
      ? generateReferenceImage(referenceConfig, prompt, reference)
      : generateCompatibleReferenceImage(referenceConfig, prompt, reference);
  }
  const trace = beginProviderTrace({ kind: "image", model: config.model, endpoint: `${config.baseUrl}/images/generations`, prompt }, config.apiKey);
  const started = Date.now();
  try {
  const result = await providerRequest("image", "/images/generations", {
    model: imageModelName(),
    prompt,
    n: 1,
    size: isGptImageModel(config.model) ? '1024x1536' : '832x1216',
    ...(isGptImageModel(config.model) ? { output_format: 'png' } : { response_format: 'b64_json' }),
  }, 55_000, trace);
  const data = result.data as { b64_json?: string }[] | undefined;
  const encoded = data?.[0]?.b64_json;
  if (!encoded || encoded.length > 28_000_000) throw new PalaceError("图片服务没有返回可保存的图片，请确认该模型支持 b64_json 格式。", 502, "IMAGE_FORMAT");
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0)); } catch { throw new PalaceError("图片数据格式无效。", 502, "IMAGE_FORMAT"); }
  const isPng = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const isWebp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!isPng && !isJpeg && !isWebp) throw new PalaceError("图片服务返回了不支持的图片类型。", 502, "IMAGE_FORMAT");
  const contentType = isPng ? "image/png" : isJpeg ? "image/jpeg" : "image/webp";
  updateProviderTrace(trace, { status: "ok", raw: `图片已返回：${bytes.length} bytes，${contentType}`, parsed: { contentType, bytes: bytes.length } });
  return { bytes, contentType };
  } catch (error) {
    updateProviderTrace(trace, { status: "error", error: error instanceof PalaceError ? error.message : "图片调用失败。" });
    throw error;
  } finally { updateProviderTrace(trace, { elapsedMs: Date.now() - started }); }
}
