import type { Agent } from './types.ts';

/** 共议任务的摘要有专属的保留槽位呢，我不会让它们占用角色个人的学习记忆容量哦。 */
export function personalMemoryCount(agent: Pick<Agent, 'memories'>): number {
  const reserved = new Set<string>();
  return agent.memories.filter(memory => {
    if (memory.source.startsWith('task-group:') && !reserved.has(memory.source)) { reserved.add(memory.source); return false; }
    return true;
  }).length;
}
