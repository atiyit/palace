import { PalaceError } from "./errors.ts";

interface StateRow { state_json: string; version: number; request_ids_json: string; }
export const STATE_LEASE_MS = 360_000;

/** 这里我特意不依赖特定的数据库绑定实现，这样租约和幂等行为用 SQLite 也能替主人跑测试哦。 */
export function stateRepository(db: D1Database) {
  async function ensureState<T>(userId: string, initial: () => T): Promise<void> {
    await db.prepare("INSERT OR IGNORE INTO palace_states (user_id,state_json,version,lease_until,request_ids_json,updated_at) VALUES (?,?,0,0,'[]',?)")
      .bind(userId, JSON.stringify(initial()), new Date().toISOString()).run();
  }
  async function readState<T>(userId: string, initial: () => T): Promise<T> {
    await ensureState(userId, initial);
    const row = await db.prepare("SELECT state_json,version,request_ids_json FROM palace_states WHERE user_id=?").bind(userId).first<StateRow>();
    if (!row) throw new PalaceError("未能读取你的后宫，请重试。", 503);
    return JSON.parse(row.state_json) as T;
  }
  async function mutateState<T>(userId: string, requestId: string, initial: () => T, mutate: (state: T) => Promise<void>): Promise<{ state: T; replayed: boolean }> {
    await ensureState(userId, initial);
    const token = crypto.randomUUID();
    const now = Date.now();
    const lock = await db.prepare("UPDATE palace_states SET lease_token=?,lease_until=? WHERE user_id=? AND (lease_token IS NULL OR lease_until<?)")
      .bind(token, now + STATE_LEASE_MS, userId, now).run();
    if (lock.meta.changes !== 1) throw new PalaceError("她们正在处理上一个请求，请稍候再试。", 409, "BUSY");
    try {
      const row = await db.prepare("SELECT state_json,version,request_ids_json FROM palace_states WHERE user_id=? AND lease_token=?")
        .bind(userId, token).first<StateRow>();
      if (!row) throw new PalaceError("会话状态已变化，请刷新后重试。", 409, "CONFLICT");
      const ids = JSON.parse(row.request_ids_json) as string[];
      const state = JSON.parse(row.state_json) as T;
      if (ids.includes(requestId)) return { state, replayed: true };
      await mutate(state);
      const result = await db.prepare("UPDATE palace_states SET state_json=?,version=version+1,request_ids_json=?,updated_at=?,lease_token=NULL,lease_until=0 WHERE user_id=? AND version=? AND lease_token=? AND lease_until>?")
        .bind(JSON.stringify(state), JSON.stringify([...ids.slice(-199), requestId]), new Date().toISOString(), userId, row.version, token, Date.now()).run();
      if (result.meta.changes !== 1) throw new PalaceError("这次操作超时或状态已更新，请刷新后查看再重试。", 409, "CONFLICT");
      return { state, replayed: false };
    } finally {
      await db.prepare("UPDATE palace_states SET lease_token=NULL,lease_until=0 WHERE user_id=? AND lease_token=?").bind(userId, token).run();
    }
  }
  return { readState, mutateState };
}
