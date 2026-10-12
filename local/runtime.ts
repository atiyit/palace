import { clearLocalDefaults, createRuntimeBindings, localBucket } from "./storage.ts";

// Vite 在编辑时可能重新求值 SSR 模块，所以我替主人看好，每个进程只保留一个 SQLite 连接呢。
const runtimeKey = Symbol.for("palace.local.runtime");
const host = globalThis as unknown as Record<symbol, Promise<Cloudflare.Env> | undefined>;
export const env = await (host[runtimeKey] ??= createRuntimeBindings());
// 已运行的开发服务器可能缓存了此功能上线前的旧绑定，请容我替主人刷新一下。
(env as Cloudflare.Env & { CLEAR_LOCAL_DEFAULTS: () => Promise<void> }).CLEAR_LOCAL_DEFAULTS = async () => clearLocalDefaults(env);
if (env.BUCKET && (typeof env.BUCKET.delete !== 'function' || typeof env.BUCKET.list !== 'function')) env.BUCKET = localBucket();
