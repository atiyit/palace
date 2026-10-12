import { env } from "cloudflare:workers";
import { PalaceError } from "./errors";
import { stateRepository } from "./repository";

function repository() {
  if (!env.DB) throw new PalaceError("尚未绑定数据库，暂时无法保存后宫。", 503, "DATABASE_NOT_READY");
  return stateRepository(env.DB);
}

export async function readState<T>(userId: string, initial: () => T): Promise<T> {
  return repository().readState(userId, initial);
}

export async function mutateState<T>(userId: string, requestId: string, initial: () => T, mutate: (state: T) => Promise<void>): Promise<{ state: T; replayed: boolean }> {
  return repository().mutateState(userId, requestId, initial, mutate);
}
