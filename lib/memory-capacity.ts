import type { Agent } from './types.ts';

/** 主人未设上限时我按不限处理；每次请求的执行与上下文大小仍由各自的边界照看哦。 */
export function configuredLimit(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** 普通记忆默认持续保存；主人主动设定容量后，写满只停止追加，不会悄悄删掉旧记忆呢。 */
export function hasPersonalMemoryCapacity(agent: Pick<Agent, 'memories'>, limit?: number): boolean {
  const capacity = configuredLimit(limit);
  return capacity === 0 || personalMemoryCount(agent) < capacity;
}

/** 共议任务的摘要有专属的保留槽位呢，我不会让它们占用角色个人的学习记忆容量哦。 */
export function personalMemoryCount(agent: Pick<Agent, 'memories'>): number {
  const reserved = new Set<string>();
  return agent.memories.filter(memory => {
    if (memory.source.startsWith('task-group:') && !reserved.has(memory.source)) { reserved.add(memory.source); return false; }
    return true;
  }).length;
}
