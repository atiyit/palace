import { PalaceError } from "./errors.ts";
import { IMAGE_PROMPT_PRESETS, MAX_IMAGE_PROMPT_INSTRUCTIONS_CHARS, MAX_IMAGE_POSITIVE_PROMPT_CHARS, MAX_IMAGE_NEGATIVE_PROMPT_CHARS, resolveImagePromptProfiles, type ImagePromptProfiles } from "../image-prompts.ts";

export type ProviderKind = "text" | "image";
export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'ollama';
export interface ProviderConnectionOptions { protocol: ProviderProtocol; local: boolean; visionEnabled?: boolean; }
export type ImagePromptStyle = 'default' | 'novelai' | 'gpt-image' | 'custom';
export interface ImageProviderOptions { referenceModel: string; promptStyle: ImagePromptStyle; customPrompt: string; promptProfiles?: ImagePromptProfiles; }
export interface ProviderConfig extends Partial<ImageProviderOptions>, Partial<ProviderConnectionOptions> { baseUrl: string; model: string; apiKey: string; }
export interface EffectiveProviderConfig extends ProviderConfig { source: "default" | "custom"; }
export interface PublicProviderConfig extends Partial<ImageProviderOptions>, Partial<ProviderConnectionOptions> { baseUrl: string; model: string; keyConfigured: boolean; keyHint: string; source: "default" | "custom"; }
export interface ProviderUpdate extends Partial<ImageProviderOptions>, Partial<ProviderConnectionOptions> { baseUrl?: string; model?: string; apiKey?: string; }
export interface ProviderDefaultEnvironment { LLM_BASE_URL?: string; LLM_MODEL?: string; LLM_API_KEY?: string; IMAGE_BASE_URL?: string; IMAGE_MODEL?: string; IMAGE_API_KEY?: string; }
export const DEFAULT_TEXT_MODEL = "claude-opus-4-6";
export const DEFAULT_PROVIDER_BASE_URL = "https://api.example.com/v1";

function invalid(message: string): never { throw new PalaceError(message, 400, "INVALID_PROVIDER_SETTINGS"); }

function privateIPv4(parts: number[]): boolean {
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19));
}

function privateHostname(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return privateIPv4(host.split(".").map(Number));
  if (host.includes(":")) {
    const segments = host.split("::");
    const left = segments[0] ? segments[0].split(":") : [];
    const right = segments.length === 2 && segments[1] ? segments[1].split(":") : [];
    const words = segments.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right].map(value => parseInt(value, 16)) : left.map(value => parseInt(value, 16));
    if (words.length !== 8 || words.some(value => !Number.isFinite(value))) return true;
    if (words.slice(0, 5).every(value => value === 0) && words[5] === 0xffff) return privateIPv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
    return words.slice(0, 6).every(value => value === 0) || (words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xffc0) === 0xfec0 || (words[0] & 0xff00) === 0xff00;
  }
  // 这道门由我替主人守着：只放行完全限定的公网域名，本地主机别名一律挡在外面。
  return !host.includes(".") || !/^[a-z0-9.-]+$/.test(host) || host.split(".").some(label => !label || label.startsWith("-") || label.endsWith("-"));
}

export function providerConnectionOptions(input: Partial<ProviderConnectionOptions> = {}): ProviderConnectionOptions {
  const protocol = input.protocol ?? 'openai-chat', local = input.local ?? false;
  if (!['openai-chat', 'openai-responses', 'anthropic', 'ollama'].includes(protocol)) invalid('API 协议不受支持。');
  if (typeof local !== 'boolean') invalid('本地服务选项必须为布尔值。');
  if (input.visionEnabled !== undefined && typeof input.visionEnabled !== 'boolean') invalid('视觉能力选项必须为布尔值。');
  return { protocol, local, ...(input.visionEnabled !== undefined ? { visionEnabled: input.visionEnabled } : {}) };
}

export function normalizeBaseUrl(input: string, options: Partial<ProviderConnectionOptions> = {}): string {
  const { protocol, local } = providerConnectionOptions(options);
  const value = input.trim();
  if (!value || value.length > 2048 || /[\r\n\t\\]/.test(value)) invalid("API 地址不能为空，且必须是有效的服务地址。");
  let url: URL;
  const expanded = value.includes('://') ? value : `${local ? 'http' : 'https'}://${value}`;
  try { url = new URL(expanded); } catch { return invalid("API 地址格式无效。"); }
  if (url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) invalid("API 地址不能包含用户名、密码、查询参数或片段。");
  let localPort: string | undefined;
  if (local) {
    if (!['http:', 'https:'].includes(url.protocol)) invalid('本地 API 地址必须使用 HTTP 或 HTTPS。');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())) invalid('本地 API 只支持 localhost、127.0.0.1 或 [::1]，不能指向其他局域网机器。');
    const authority = expanded.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i)?.[1] || '';
    localPort = authority.match(/:(\d+)$/)?.[1];
    if (!localPort || Number(localPort) < 1 || Number(localPort) > 65535) invalid('请为本地 API 填写明确端口，例如1234或11434。');
    localPort = String(Number(localPort));
  } else {
    if (url.protocol !== 'https:') invalid('公网 API 地址必须使用 HTTPS；本机服务请启用本地选项。');
    if (privateHostname(url.hostname)) invalid('公网 API 地址不能指向本机、内网或保留地址。');
  }
  url.hostname = url.hostname.replace(/\.$/, "");
  let path = url.pathname.replace(/\/+$/, '');
  if (protocol === 'ollama') path = path.replace(/\/api\/(?:chat|generate)$/i, '').replace(/\/api$/i, '');
  else {
    const suffix = protocol === 'anthropic' ? /\/messages$/i : protocol === 'openai-responses' ? /\/responses$/i : /\/(?:chat\/completions|images\/(?:generations|edits))$/i;
    path = path.replace(suffix, '');
    if (!path || path === '/') path = '/v1';
  }
  url.pathname = path;
  // URL 序列化会自动去掉 :80/:443，但本地模式下主人显式配的端口要保留，这样归一化操作才能保持幂等呀。
  if (local) return `${url.protocol}//${url.hostname}:${localPort}${url.pathname === '/' ? '' : url.pathname}`.replace(/\/$/, '');
  return url.toString().replace(/\/$/, "");
}

export function validateModel(input: string): string {
  const value = input.trim();
  if (!value || value.length > 200 || /[\r\n\x00-\x1f]/.test(value)) invalid("模型名称需要1至200个字符，不能包含换行。");
  return value;
}

export function validateApiKey(input: string): string {
  if (input.length > 2048 || /[\r\n\x00-\x1f\x7f]/.test(input)) invalid("API 密钥不能超过2048个字符或包含换行、控制字符。");
  return input.trim();
}

/** 请放心，我只迁移缺失的旧版设置；主人已经显式指定的参考模型，我不会偷偷替换掉的。 */
export function defaultReferenceModel(model: string): string {
  if (model === 'nai-diffusion-5-full') return 'nai-diffusion-4-5-full';
  if (model === 'nai-diffusion-5-curated') return 'nai-diffusion-4-5-curated';
  return model;
}
export function imageProviderOptions(model: string, input: Partial<ImageProviderOptions> = {}): ImageProviderOptions {
  const referenceModel = validateModel(input.referenceModel === undefined ? defaultReferenceModel(model) : input.referenceModel);
  const promptStyle = input.promptStyle ?? 'default';
  if (!['default', 'novelai', 'gpt-image', 'custom'].includes(promptStyle)) invalid('图片提示词预设无效。');
  const customPrompt = input.customPrompt ?? '';
  if (typeof customPrompt !== 'string' || customPrompt.length > 6000 || /\x00/.test(customPrompt)) invalid('自定义图片提示词最多6000个字符，不能包含空字符。');
  const promptProfiles = input.promptProfiles === undefined ? resolveImagePromptProfiles(model, referenceModel, { promptStyle, customPrompt }) : validateImagePromptProfiles(input.promptProfiles);
  return { referenceModel, promptStyle, customPrompt, promptProfiles };
}

/** 每个抽屉都单独验收，未知字段或半份配置不会悄悄覆盖主人的另一套提示词。 */
export function validateImagePromptProfiles(input: unknown): ImagePromptProfiles {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('图片提示词配置必须包含文生图与参考图两套配置。');
  const profiles = input as Record<string, unknown>;
  if (Object.keys(profiles).some(key => !['generation', 'reference'].includes(key))) invalid('图片提示词配置包含未知用途。');
  const result = {} as ImagePromptProfiles;
  for (const slot of ['generation', 'reference'] as const) {
    const raw = profiles[slot];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('文生图与参考图提示词配置均需完整提供。');
    const profile = raw as Record<string, unknown>;
    if (Object.keys(profile).some(key => !['preset', 'llmEnabled', 'instructions', 'positivePrompt', 'negativePrompt'].includes(key))) invalid('图片提示词配置包含未知字段。');
    if (!IMAGE_PROMPT_PRESETS.some(preset => preset.value === profile.preset)) invalid('图片提示词预设无效。');
    if (typeof profile.llmEnabled !== 'boolean') invalid('提示词优化开关必须为布尔值。');
    for (const [field, limit] of [['instructions', MAX_IMAGE_PROMPT_INSTRUCTIONS_CHARS], ['positivePrompt', MAX_IMAGE_POSITIVE_PROMPT_CHARS], ['negativePrompt', MAX_IMAGE_NEGATIVE_PROMPT_CHARS]] as const) {
      if (typeof profile[field] !== 'string' || profile[field].length > limit || /\x00/.test(profile[field])) invalid(`图片提示词 ${field} 最多${limit}个字符，不能包含空字符。`);
    }
    result[slot] = { preset: profile.preset, llmEnabled: profile.llmEnabled, instructions: profile.instructions, positivePrompt: profile.positivePrompt, negativePrompt: profile.negativePrompt } as ImagePromptProfiles[typeof slot];
  }
  return result;
}

/** 我先替主人把服务商更新整理好：地址归一化、模型验证、密钥安全策略一并检查。
 * 更换公网域名时必须提供新密钥，防止旧密钥被误发到新服务。
 * 本地模式下在同源未变时可以沿用现有密钥。 */
export function prepareProviderUpdate(current: EffectiveProviderConfig, input: ProviderUpdate): ProviderConfig {
  const connection = providerConnectionOptions({ protocol: input.protocol ?? current.protocol, local: input.local ?? current.local, visionEnabled: input.visionEnabled ?? current.visionEnabled });
  const baseUrl = normalizeBaseUrl(input.baseUrl === undefined ? current.baseUrl : input.baseUrl, connection);
  const model = validateModel(input.model === undefined ? current.model : input.model);
  const newKey = input.apiKey === undefined ? "" : validateApiKey(input.apiKey);
  const changedOrigin = new URL(baseUrl).origin !== new URL(current.baseUrl).origin;
  if (!connection.local && changedOrigin && !newKey) invalid("更换公网 API 域名或端口时必须填写新的密钥，不能沿用原服务密钥。");
  const apiKey = connection.local
    ? newKey || (current.local === true && !changedOrigin ? current.apiKey : '')
    : newKey || current.apiKey;
  const legacyPromptUpdate = input.promptStyle !== undefined || input.customPrompt !== undefined;
  const imageOptions = current.referenceModel !== undefined || input.referenceModel !== undefined || input.promptStyle !== undefined || input.customPrompt !== undefined || input.promptProfiles !== undefined
    ? imageProviderOptions(model, { referenceModel: input.referenceModel ?? current.referenceModel, promptStyle: input.promptStyle ?? current.promptStyle, customPrompt: input.customPrompt ?? current.customPrompt, promptProfiles: input.promptProfiles ?? (legacyPromptUpdate ? undefined : current.promptProfiles) }) : {};
  return { baseUrl, model, apiKey, ...connection, ...imageOptions };
}

export function providerDefaults(environment: ProviderDefaultEnvironment): { text: EffectiveProviderConfig; image: EffectiveProviderConfig } {
  const text: EffectiveProviderConfig = { baseUrl: normalizeBaseUrl(environment.LLM_BASE_URL || DEFAULT_PROVIDER_BASE_URL), model: environment.LLM_MODEL || DEFAULT_TEXT_MODEL, apiKey: environment.LLM_API_KEY || "", source: "default", ...providerConnectionOptions(), visionEnabled: false };
  // 图片渠道的默认配置只回退到服务端环境变量哦，不会拿主人的文本渠道覆盖值来顶替。
  const imageModel = environment.IMAGE_MODEL || 'nai-diffusion-5-full';
  const image: EffectiveProviderConfig = { baseUrl: normalizeBaseUrl(environment.IMAGE_BASE_URL || environment.LLM_BASE_URL || DEFAULT_PROVIDER_BASE_URL), model: imageModel, apiKey: environment.IMAGE_API_KEY || environment.LLM_API_KEY || "", source: "default", ...imageProviderOptions(imageModel), ...providerConnectionOptions() };
  return { text, image };
}

export function maskProviderConfig(config: EffectiveProviderConfig): PublicProviderConfig {
  return { baseUrl: config.baseUrl, model: config.model, keyConfigured: Boolean(config.apiKey), keyHint: config.apiKey ? config.apiKey.length > 8 ? `••••••••${config.apiKey.slice(-4)}` : "••••••••" : "", source: config.source, ...providerConnectionOptions(config), ...(config.referenceModel !== undefined ? imageProviderOptions(config.model, config) : {}) };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid base64");
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  try {
    const decoded = decodeBase64(secret);
    if (decoded.length !== 32) throw new Error("Invalid key length");
    return await crypto.subtle.importKey("raw", decoded, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } catch { throw new PalaceError("个人 API 配置的加密服务尚未正确配置。", 503, "PROVIDER_SETTINGS_SECRET_INVALID"); }
}

const associatedData = (userId: string, kind: ProviderKind) => new TextEncoder().encode(JSON.stringify(["palace-provider-key-v1", userId, kind]));

/** 主人的 API 密钥就由我用 AES-256-GCM 锁进保险箱吧——IV 随机生成，附加数据绑定用户 ID 和渠道类型。
 * 密文格式为 v1.{base64IV}.{base64密文}，方便版本化和解密路由。
 * 万一解密失败会提示主人重新保存，绝不泄露原始密钥内容。 */
export async function encryptApiKey(apiKey: string, secret: string, userId: string, kind: ProviderKind): Promise<string> {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: associatedData(userId, kind), tagLength: 128 }, key, new TextEncoder().encode(apiKey));
  return `v1.${encodeBase64(iv)}.${encodeBase64(new Uint8Array(encrypted))}`;
}

export async function decryptApiKey(ciphertext: string, secret: string, userId: string, kind: ProviderKind): Promise<string> {
  const key = await encryptionKey(secret);
  try {
    const parts = ciphertext.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unknown ciphertext version");
    const iv = decodeBase64(parts[1]);
    if (iv.length !== 12) throw new Error("Invalid IV");
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: associatedData(userId, kind), tagLength: 128 }, key, decodeBase64(parts[2]));
    return new TextDecoder().decode(plaintext);
  } catch { throw new PalaceError("无法解密已保存的个人 API 密钥，请重新保存该渠道的配置。", 503, "PROVIDER_SETTINGS_DECRYPT_FAILED"); }
}
