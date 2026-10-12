import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rename, unlink, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptApiKey, encryptApiKey, normalizeBaseUrl, validateApiKey, validateModel, DEFAULT_TEXT_MODEL, DEFAULT_PROVIDER_BASE_URL, type ProviderConfig, type ProviderKind } from "../lib/server/provider-config-core.ts";

export const LOCAL_OWNER_ID = "local-owner";
export const PROJECT_DIRECTORY = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DATA_DIRECTORY = resolve(process.env.PALACE_DATA_DIR || join(PROJECT_DIRECTORY, ".palace-data"));

interface StoredDefault { baseUrl: string; model: string; encryptedApiKey: string; }
interface DefaultFile { version: 1; text: StoredDefault; image: StoredDefault; }
export interface BootstrapInput { action?: "initialize" | "replace"; apiKey?: string; text?: Partial<ProviderConfig>; image?: Partial<ProviderConfig>; }

function privateDirectory(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }

export function localVaultSecret(): string {
  privateDirectory(DATA_DIRECTORY);
  const path = join(DATA_DIRECTORY, "vault.key");
  if (!existsSync(path)) {
    try { writeFileSync(path, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const value = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, "base64").length !== 32) throw new Error("本地 vault.key 无效，请恢复原密钥文件；不要覆盖仍用于加密存档的密钥。");
  return value;
}

const defaultProvider = (kind: ProviderKind): ProviderConfig => ({ baseUrl: DEFAULT_PROVIDER_BASE_URL, model: kind === "text" ? DEFAULT_TEXT_MODEL : "nai-diffusion-5-full", apiKey: "" });

export async function readLocalDefaults(secret: string): Promise<Record<ProviderKind, ProviderConfig>> {
  const path = join(DATA_DIRECTORY, "default-providers.json");
  if (!existsSync(path)) return { text: defaultProvider("text"), image: defaultProvider("image") };
  const stored = JSON.parse(readFileSync(path, "utf8")) as DefaultFile;
  if (stored.version !== 1 || !stored.text || !stored.image) throw new Error("本地默认 API 配置格式无效。");
  const result = {} as Record<ProviderKind, ProviderConfig>;
  for (const kind of ["text", "image"] as const) {
    const value = stored[kind];
    result[kind] = { baseUrl: normalizeBaseUrl(value.baseUrl), model: validateModel(value.model), apiKey: await decryptApiKey(value.encryptedApiKey, secret, LOCAL_OWNER_ID, kind) };
  }
  return result;
}

/** 主人，请把密钥的事交给我吧——只有初始化引导流程从 stdin 读取密钥；明文密钥不会被写入磁盘的。 */
export async function bootstrapLocalDefaults(input: BootstrapInput): Promise<void> {
  const path = join(DATA_DIRECTORY, "default-providers.json");
  if (existsSync(path) && input.action !== "replace") throw new Error("本地默认配置已存在，未覆盖。需要替换时显式传入 action: replace。");
  if (input.action && input.action !== "initialize" && input.action !== "replace") throw new Error("不支持的初始化操作。");
  const secret = localVaultSecret();
  const previous = await readLocalDefaults(secret);
  const stored: DefaultFile = { version: 1, text: {} as StoredDefault, image: {} as StoredDefault };
  for (const kind of ["text", "image"] as const) {
    const supplied = input[kind] || {};
    const baseUrl = normalizeBaseUrl(supplied.baseUrl ?? previous[kind].baseUrl);
    const model = validateModel(supplied.model ?? previous[kind].model);
    const explicitKey = supplied.apiKey ?? input.apiKey;
    const apiKey = explicitKey === undefined ? previous[kind].apiKey : validateApiKey(explicitKey);
    if (!apiKey) throw new Error("初始化需要提供文本和图片服务的密钥，或一个共享的 apiKey。");
    if (new URL(baseUrl).origin !== new URL(previous[kind].baseUrl).origin && !explicitKey) throw new Error("变更默认 API 服务地址时必须显式提供新的密钥。");
    stored[kind] = { baseUrl, model, encryptedApiKey: await encryptApiKey(apiKey, secret, LOCAL_OWNER_ID, kind) };
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

type BindValue = string | number | null | Uint8Array;

/** 请容我用这个最小的 D1 适配器替主人搭好应用仓库 API 的架子，底层由真实 SQLite 驱动呢。 */
export function localDatabase(databasePath: string, migrationsDirectory = join(PROJECT_DIRECTORY, "drizzle")): D1Database {
  privateDirectory(dirname(databasePath));
  const sqlite = new DatabaseSync(databasePath);
  sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)");
  for (const name of readdirSync(migrationsDirectory).filter(value => /^\d+.*\.sql$/.test(value)).sort()) {
    if (sqlite.prepare("SELECT name FROM _local_migrations WHERE name=?").get(name)) continue;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(readFileSync(join(migrationsDirectory, name), "utf8"));
      sqlite.prepare("INSERT INTO _local_migrations (name,applied_at) VALUES (?,?)").run(name, new Date().toISOString());
      sqlite.exec("COMMIT");
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }
  const prepared = (sql: string, values: BindValue[] = []) => ({
    bind(...next: BindValue[]) { return prepared(sql, next); },
    async first(column?: string) {
      const row = sqlite.prepare(sql).get(...values);
      return row ? column ? row[column] ?? null : row : null;
    },
    async all() { return { success: true, results: sqlite.prepare(sql).all(...values), meta: { changes: 0 } }; },
    async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
  });
  return { prepare: (sql: string) => prepared(sql), exec: async (sql: string) => { sqlite.exec(sql); return { count: 0, duration: 0 }; } } as unknown as D1Database;
}

/** 主人，我用本地 JSON 文件替您模拟了 R2 Bucket 接口，默认存储在 DATA_DIRECTORY/portraits 下。
 * 所有路径都经过越界检查和符号链接检测，不允许递归删除哦。
 * list 操作会遍历目录树并返回按字典序排列的分页结果。 */
export function localBucket(root = join(DATA_DIRECTORY, "portraits")): R2Bucket {
  privateDirectory(root);
  const canonicalRoot = realpathSync(root);
  const bounded = (path: string): string => {
    const resolved = resolve(path);
    if (!resolved.startsWith(canonicalRoot + sep)) throw new Error("图片存储路径越界。");
    let current = canonicalRoot;
    for (const part of relative(canonicalRoot, resolved).split(sep)) {
      current = join(current, part);
      try { if (lstatSync(current).isSymbolicLink()) throw new Error("图片存储路径不能包含符号链接。"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return resolved;
  };
  const objectPath = (key: string): string => {
    if (!/^[a-zA-Z0-9_%/-]{1,300}$/.test(key) || key.split("/").some(part => !part || part === "." || part === "..")) throw new Error("图片存储路径无效。");
    return bounded(`${resolve(canonicalRoot, key)}.json`);
  };
  return {
    async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
      const path = objectPath(key);
      privateDirectory(dirname(path));
      const temporary = `${path}.${randomUUID()}.tmp`;
      const body = { contentType: options?.httpMetadata?.contentType || "image/png", base64: Buffer.from(value).toString("base64") };
      await writeFile(temporary, JSON.stringify(body), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      return { key };
    },
    async get(key: string) {
      try {
        const value = JSON.parse(await readFile(objectPath(key), "utf8")) as { contentType: string; base64: string };
        const bytes = new Uint8Array(Buffer.from(value.base64, "base64"));
        return { key, body: new Response(bytes).body!, httpMetadata: { contentType: value.contentType } };
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    async delete(keys: string | string[]) {
      // 删东西之前我会先把整批路径都验证一遍，请主人放心——绝不执行递归文件系统删除。
      const paths = (Array.isArray(keys) ? keys : [keys]).map(objectPath);
      for (const path of paths) {
        try { await unlink(bounded(path)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    },
    async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const prefix = options.prefix || '';
      if (prefix && (!/^[a-zA-Z0-9_%/-]{1,300}$/.test(prefix) || prefix.startsWith('/') || prefix.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('图片存储前缀无效。');
      const found: { key: string; uploaded: Date; size: number }[] = [];
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = bounded(join(directory, entry.name));
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && entry.name.endsWith('.json')) {
            const key = relative(canonicalRoot, path).split(sep).join('/').slice(0, -5);
            if (key.startsWith(prefix) && (!options.cursor || key > options.cursor)) {
              const info = await stat(path);
              found.push({ key, uploaded: info.mtime, size: info.size });
            }
          }
        }
      };
      await walk(canonicalRoot);
      found.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      const limit = Math.max(1, Math.min(1000, Math.floor(options.limit || 1000)));
      const objects = found.slice(0, limit);
      return { objects, truncated: found.length > limit, ...(found.length > limit ? { cursor: objects[objects.length - 1].key } : {}), delimitedPrefixes: [] };
    },
  } as unknown as R2Bucket;
}

export async function clearLocalDefaults(bindings: Cloudflare.Env): Promise<void> {
  const text = defaultProvider('text');
  const image = defaultProvider('image');
  // 主人，这里清除的是运行时 Symbol 缓存中持有的同一对象，而非脱离引用的快照副本呢。
  Object.assign(bindings, { LLM_API_KEY: '', IMAGE_API_KEY: '', LLM_BASE_URL: text.baseUrl, IMAGE_BASE_URL: image.baseUrl, LLM_MODEL: text.model, IMAGE_MODEL: image.model });
  const root = resolve(DATA_DIRECTORY);
  const path = resolve(root, 'default-providers.json');
  if (dirname(path) !== root) throw new Error('默认 API 配置清理路径越界。');
  try { await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export async function createRuntimeBindings(): Promise<Cloudflare.Env & { CLEAR_LOCAL_DEFAULTS: () => Promise<void> }> {
  const secret = localVaultSecret();
  const defaults = await readLocalDefaults(secret);
  const bindings: Cloudflare.Env & { CLEAR_LOCAL_DEFAULTS: () => Promise<void> } = {
    DB: localDatabase(join(DATA_DIRECTORY, "palace.sqlite")), BUCKET: localBucket(), PROVIDER_SETTINGS_SECRET: secret,
    LLM_BASE_URL: defaults.text.baseUrl, LLM_MODEL: defaults.text.model, LLM_API_KEY: defaults.text.apiKey,
    IMAGE_BASE_URL: defaults.image.baseUrl, IMAGE_MODEL: defaults.image.model, IMAGE_API_KEY: defaults.image.apiKey,
    CLEAR_LOCAL_DEFAULTS: async () => clearLocalDefaults(bindings),
  };
  return bindings;
}
