import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "cloudflare:workers";
import { PalaceError } from "./errors";
import { decryptApiKey, encryptApiKey, maskProviderConfig, normalizeBaseUrl, prepareProviderUpdate, providerDefaults, validateModel, imageProviderOptions, providerConnectionOptions, type EffectiveProviderConfig, type ProviderKind, type ProviderUpdate, type PublicProviderConfig } from "./provider-config-core";
import { providerSettingsRepository } from "./provider-settings-repository";

type ProviderSnapshot = Readonly<Record<ProviderKind, Readonly<EffectiveProviderConfig>>>;
export type PublicProviderSettings = Record<ProviderKind, PublicProviderConfig>;
const providerContext = new AsyncLocalStorage<ProviderSnapshot>();

function repository() {
  if (!env.DB) throw new PalaceError("尚未绑定数据库，无法读取个人 API 配置。", 503, "DATABASE_NOT_READY");
  return providerSettingsRepository(env.DB);
}

async function resolveSnapshot(userId: string): Promise<ProviderSnapshot> {
  const effective = providerDefaults(env);
  const rows = await repository().list(userId);
  for (const row of rows) {
    const connection = providerConnectionOptions(row.connectionOptions);
    if (row.kind === 'image' && (connection.protocol !== 'openai-chat' || connection.visionEnabled !== undefined)) throw new PalaceError('图片渠道仅支持图片兼容协议，不能设置文本视觉开关。', 400, 'INVALID_PROVIDER_SETTINGS');
    effective[row.kind] = { baseUrl: normalizeBaseUrl(row.baseUrl, connection), model: validateModel(row.model), apiKey: await decryptApiKey(row.encryptedApiKey, env.PROVIDER_SETTINGS_SECRET || "", userId, row.kind), source: "custom", ...connection,
      ...(row.kind === 'image' ? imageProviderOptions(row.model, row.imageOptions) : { visionEnabled: connection.visionEnabled ?? false }) };
  }
  return Object.freeze({ text: Object.freeze(effective.text), image: Object.freeze(effective.image) });
}

export async function withProviderSettings<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const snapshot = await resolveSnapshot(userId);
  return providerContext.run(snapshot, operation);
}

export function getEffectiveProvider(kind: ProviderKind): Readonly<EffectiveProviderConfig> {
  return providerContext.getStore()?.[kind] || providerDefaults(env)[kind];
}

function publicSnapshot(snapshot: ProviderSnapshot): PublicProviderSettings {
  return { text: maskProviderConfig(snapshot.text), image: maskProviderConfig(snapshot.image) };
}

export async function readPublicProviderSettings(userId: string): Promise<PublicProviderSettings> {
  return publicSnapshot(await resolveSnapshot(userId));
}

export async function saveProviderSettings(userId: string, kind: ProviderKind, input: ProviderUpdate): Promise<PublicProviderSettings> {
  if (kind === 'text' && (input.referenceModel !== undefined || input.promptStyle !== undefined || input.customPrompt !== undefined || input.promptProfiles !== undefined)) throw new PalaceError('参考模型和图片提示词只适用于图片渠道。', 400, 'INVALID_PROVIDER_SETTINGS');
  const current = await resolveSnapshot(userId);
  const updated = prepareProviderUpdate(current[kind], input);
  if (kind === 'image' && (updated.protocol !== 'openai-chat' || input.visionEnabled !== undefined)) throw new PalaceError('图片渠道仅支持图片兼容协议，不能设置文本视觉开关。', 400, 'INVALID_PROVIDER_SETTINGS');
  // 即使是继承来的密钥，我也会以加密快照的形式替主人妥善保管，绝不把明文写进配置存储。
  const encryptedApiKey = await encryptApiKey(updated.apiKey, env.PROVIDER_SETTINGS_SECRET || "", userId, kind);
  await repository().upsert({ userId, kind, baseUrl: updated.baseUrl, model: updated.model, encryptedApiKey, updatedAt: new Date().toISOString(), connectionOptions: providerConnectionOptions(updated), ...(kind === 'image' ? { imageOptions: imageProviderOptions(updated.model, updated) } : {}) });
  return readPublicProviderSettings(userId);
}

export async function resetProviderSettings(userId: string, kind: ProviderKind): Promise<PublicProviderSettings> {
  await repository().remove(userId, kind);
  return readPublicProviderSettings(userId);
}
