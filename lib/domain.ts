import type { Agent, Relationship, Settings, SocialEvent } from './types';

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
/** 主人，这里将按权重分配的概率与均匀探索概率混合，计算每位角色的推荐概率。
 * exploration 参数控制随机探索比例（5%–50%），权重越高被选中的基础概率越大。
 * 非空候选池的返回概率之和为 1，空池返回空映射；这里没有训练排序模型。 */
export function recommendationProbabilities(agents: Agent[], exploration = .2): Record<string, number> {
  if (!agents.length) return {};
  const epsilon = clamp(exploration, .05, .5);
  const total = agents.reduce((s, a) => s + Math.max(.1, a.weight), 0);
  return Object.fromEntries(agents.map(a => [a.id, (1 - epsilon) * Math.max(.1, a.weight) / total + epsilon / agents.length]));
}
/** 主人，按推荐概率从候选池中无放回地抽样，每抽一位就重新计算剩余池的概率。
 * rng 参数允许注入确定性随机源以便测试。
 * 当池中不足 count 位时返回实际可用数量，不会出错。 */
export function weightedSample(agents: Agent[], count: number, exploration = .2, rng = Math.random): Agent[] {
  const pool = [...agents], picked: Agent[] = [];
  while (pool.length && picked.length < count) {
    const p = recommendationProbabilities(pool, exploration);
    let ticket = rng(), index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) { ticket -= p[pool[i].id]; if (ticket <= 0) { index = i; break; } }
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}
/** 主人，根据用户的点赞、邀请或聊天事件更新角色的偏好权重。
 * like 是切换操作（再次点击取消）；hire 只生效一次并附加权重 +5。
 * chat 加成受 UTC+8 每日三次上限约束，且只统计用户消息。 */
export function applyFeedback(agent: Agent, event: 'like' | 'hire' | 'chat'): void {
  if (event === 'like') { agent.liked = !agent.liked; agent.weight = Math.max(1, agent.weight + (agent.liked ? 3 : -3)); }
  if (event === 'hire' && !agent.hired) { agent.hired = true; agent.hiredAt = new Date().toISOString(); agent.weight += 5; }
  // 主人，每个 UTC+8 日最多三次注意力加成；助手的输出不计入次数。
  if (event === 'chat') {
    const day = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10);
    const today = day(new Date().toISOString());
    const userTurns = agent.chats.filter(m => m.role === 'user' && day(m.createdAt) === today).length;
    if (userTurns < 3) { agent.weight += 1; agent.chatBoost += 1; }
  }
}
export function validateSettings(input: Partial<Settings>, current: Settings): Settings {
  return { exploration: typeof input.exploration === 'number' && Number.isFinite(input.exploration) ? clamp(input.exploration, .05, .5) : current.exploration, drama: typeof input.drama === 'number' && Number.isFinite(input.drama) ? clamp(input.drama, 0, 1) : current.drama };
}
export function acceptedRelationship(event: SocialEvent, history: SocialEvent[]): Relationship | null {
  if (event.kind !== 'accept' || !event.replyTo) return null;
  const request = history.find(e => e.id === event.replyTo && e.kind === 'request' && e.taskId === event.taskId && e.targetId === event.agentId);
  if (!request || request.agentId === event.agentId) return null;
  return { id: event.id, from: request.agentId, to: event.agentId, kind: 'delegation', taskId: event.taskId, eventId: event.id, createdAt: event.createdAt };
}
