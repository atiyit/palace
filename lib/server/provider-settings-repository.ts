import type { ProviderKind, ImageProviderOptions, ProviderConnectionOptions } from "./provider-config-core.ts";

export interface StoredProviderSettings { userId: string; kind: ProviderKind; baseUrl: string; model: string; encryptedApiKey: string; updatedAt: string; imageOptions?: ImageProviderOptions; connectionOptions?: ProviderConnectionOptions; }
type DbProviderRow = { user_id: string; kind: ProviderKind; base_url: string; model: string; encrypted_api_key: string; updated_at: string; image_options: string | null; connection_options: string | null };
const decode = (row: DbProviderRow): StoredProviderSettings => ({ userId: row.user_id, kind: row.kind, baseUrl: row.base_url, model: row.model, encryptedApiKey: row.encrypted_api_key, updatedAt: row.updated_at, ...(row.kind === 'image' && row.image_options ? { imageOptions: JSON.parse(row.image_options) as ImageProviderOptions } : {}), ...(row.connection_options ? { connectionOptions: JSON.parse(row.connection_options) as ProviderConnectionOptions } : {}) });

export function providerSettingsRepository(db: D1Database) {
  return {
    async get(userId: string, kind: ProviderKind): Promise<StoredProviderSettings | null> {
      const row = await db.prepare("SELECT user_id,kind,base_url,model,encrypted_api_key,updated_at,image_options,connection_options FROM provider_settings WHERE user_id=? AND kind=?").bind(userId, kind).first<DbProviderRow>();
      return row ? decode(row) : null;
    },
    async list(userId: string): Promise<StoredProviderSettings[]> {
      const result = await db.prepare("SELECT user_id,kind,base_url,model,encrypted_api_key,updated_at,image_options,connection_options FROM provider_settings WHERE user_id=?").bind(userId).all<DbProviderRow>();
      return result.results.map(decode);
    },
    async upsert(row: StoredProviderSettings): Promise<void> {
      await db.prepare("INSERT INTO provider_settings (user_id,kind,base_url,model,encrypted_api_key,updated_at,image_options,connection_options) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET base_url=excluded.base_url,model=excluded.model,encrypted_api_key=excluded.encrypted_api_key,updated_at=excluded.updated_at,image_options=excluded.image_options,connection_options=excluded.connection_options")
        .bind(row.userId, row.kind, row.baseUrl, row.model, row.encryptedApiKey, row.updatedAt, row.kind === 'image' && row.imageOptions ? JSON.stringify(row.imageOptions) : null, row.connectionOptions ? JSON.stringify(row.connectionOptions) : null).run();
    },
    async remove(userId: string, kind: ProviderKind): Promise<void> {
      await db.prepare("DELETE FROM provider_settings WHERE user_id=? AND kind=?").bind(userId, kind).run();
    },
  };
}
