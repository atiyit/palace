import type { Agent, AppState, CleanupJob, Task } from './types.ts';
import { PalaceError } from './server/errors.ts';
import { DEFAULT_TEXT_MODEL } from './server/provider-config-core.ts';

export const DELETED_MEMBER_ID = 'deleted-member';
export const activeMembers = (state: AppState): Agent[] => state.agents.filter(agent => agent.hired && !agent.archivedAt);

function findMember(state: AppState, agentId: string): Agent {
  const agent = state.agents.find(item => item.id === agentId);
  if (!agent) throw new PalaceError('找不到这个角色。', 404, 'NOT_FOUND');
  return agent;
}

/** 主人，要确保下一位未发言者的位置不变；移除靠前的发言者时不能跳过任何人的回合。 */
function repairTask(task: Task, available: Set<string>, now: string): void {
  if (task.status === 'completed') return;
  const played = task.order.slice(0, task.cursor).filter(id => available.has(id));
  task.participants = task.participants.filter(id => available.has(id));
  task.order = task.order.filter(id => available.has(id));
  task.cursor = played.length;
  if (task.participants.length < 2) {
    task.status = 'paused';
    task.lastError = '参与成员不足两位，任务已暂停；其余记录和成果已保留。';
  } else if (task.cursor >= task.order.length) {
    if (task.round >= task.rounds) { task.status = 'completed'; task.completedAt = now; }
    else { task.round++; task.cursor = 0; task.order = [...task.participants]; }
  }
}

export function archiveMember(state: AppState, agentId: string, now = new Date().toISOString()): void {
  const agent = findMember(state, agentId);
  if (agent.archivedAt) return;
  agent.archivedAt = now;
  const available = new Set(activeMembers(state).map(item => item.id));
  state.tasks.forEach(task => repairTask(task, available, now));
  if (agent.hired) state.membershipEvents = [...(state.membershipEvents || []), { id: crypto.randomUUID(), agentId, name: agent.name, kind: 'left' as const, createdAt: now }].slice(-100);
  state.updatedAt = now;
}

export function restoreMember(state: AppState, agentId: string, now = new Date().toISOString()): void {
  const agent = findMember(state, agentId);
  if (!agent.archivedAt) return;
  if (agent.hired && activeMembers(state).length >= 8) throw new PalaceError('庭院已有 8 位在庭成员，请先让一位离开，再恢复她。', 409, 'MEMBER_CAPACITY');
  delete agent.archivedAt;
  if (agent.hired) state.membershipEvents = [...(state.membershipEvents || []), { id: crypto.randomUUID(), agentId, name: agent.name, kind: 'returned' as const, createdAt: now }].slice(-100);
  state.updatedAt = now;
}

/** 主人，成员变动信息会出现在角色上下文中，但不会强制触发悲伤情绪或注意力惩罚。 */
export function membershipContext(state: AppState) {
  return {
    presentMembers: activeMembers(state).map(agent => ({ id: agent.id, name: agent.name })),
    recentChanges: (state.membershipEvents || []).slice(-12),
    guidance: '成员离开或返回是已知的客观事实。可以按关系与人设自然注意到；不必悲伤、恐慌、争论或改变对用户的态度。离开者不参与当前交流，不要冒充她发言。',
  };
}

function ownedImageIds(agent: Agent): string[] {
  return [agent.id, ...agent.chats.filter(chat => chat.image).map(chat => `chat-${chat.id}`), ...agent.chats.flatMap(chat => (chat.attachments || []).map(image => `upload-${image.id}`))];
}

export function referencedImageIds(state: AppState): Set<string> {
  const agents = [...state.agents, ...(state.recruitment?.slots.flatMap(slot => slot.candidate ? [slot.candidate] : []) || [])];
  return new Set([...agents.flatMap(ownedImageIds), ...(state.userProfile?.avatar ? ['user-profile'] : []), ...(state.userUploads || []).map(image => `upload-${image.id}`)]);
}

export function permanentlyDeleteMember(state: AppState, agentId: string, confirmation: unknown, now = new Date().toISOString()): void {
  if (confirmation !== '永久删除') throw new PalaceError('请输入「永久删除」确认，此操作无法恢复。', 400, 'CONFIRMATION_REQUIRED');
  const agent = findMember(state, agentId);
  if (!agent.archivedAt) throw new PalaceError('请先让她离开庭院，移入回收站后再永久删除。', 409, 'MEMBER_NOT_ARCHIVED');
  const privateSources = new Set(agent.chats.map(chat => chat.id));
  const removedProposalIds = new Set((state.roleProposals || []).filter(item => item.proposerId === agentId || item.holderId === agentId).map(item => item.id));
  state.agents = state.agents.filter(item => item.id !== agentId);
  state.agents.forEach(item => { item.memories = item.memories.filter(memory => !privateSources.has(memory.source)); });
  state.relationships = state.relationships.filter(item => item.from !== agentId && item.to !== agentId);
  state.roleProposals = (state.roleProposals || []).filter(item => !removedProposalIds.has(item.id)).map(item => ({ ...item, supporterIds: item.supporterIds.filter(id => id !== agentId) }));
  state.membershipEvents = (state.membershipEvents || []).filter(item => item.agentId !== agentId);
  for (const event of state.events) {
    if (event.agentId === agentId) { event.agentId = DELETED_MEMBER_ID; event.content = '【已离开成员的发言已永久删除】'; event.checked = false; delete event.adoptedAt; }
    if (event.targetId === agentId) delete event.targetId;
  }
  for (const event of state.dailyEvents || []) {
    if (event.agentId === agentId) { event.agentId = DELETED_MEMBER_ID; event.content = '【已离开成员的发言已永久删除】'; event.checked = false; }
    if (event.targetId === agentId) event.targetId = DELETED_MEMBER_ID;
    if (event.proposalId && removedProposalIds.has(event.proposalId)) delete event.proposalId;
  }
  const available = new Set(activeMembers(state).map(item => item.id));
  for (const task of state.tasks) {
    repairTask(task, available, now);
    task.participants = task.participants.filter(id => id !== agentId);
    task.order = task.order.filter(id => id !== agentId);
    for (const artifact of task.artifacts || []) {
      if (artifact.agentId === agentId) artifact.agentId = DELETED_MEMBER_ID;
      if (artifact.contributorIds) artifact.contributorIds = [...new Set(artifact.contributorIds.map(id => id === agentId ? DELETED_MEMBER_ID : id))];
    }
    for (const run of task.toolRuns || []) if (run.agentId === agentId) run.agentId = DELETED_MEMBER_ID;
  }
  // 主人，成功生成的候选人是档案的完整副本，删除成员时需要一并清理招募中的同 ID 候选。
  if (state.recruitment?.slots.some(slot => slot.candidate?.id === agentId)) delete state.recruitment;
  state.pendingCleanup = [...(state.pendingCleanup || []), { id: crypto.randomUUID(), kind: 'member', agentId, imageIds: ownedImageIds(agent), createdAt: now }];
  state.updatedAt = now;
}

export function clearAllData(state: AppState, confirmation: unknown, now = new Date().toISOString()): void {
  if (confirmation !== '清除所有数据') throw new PalaceError('请输入「清除所有数据」确认，包括角色、聊天、图片、成果和 API 配置。', 400, 'CONFIRMATION_REQUIRED');
  const job: CleanupJob = { id: crypto.randomUUID(), kind: 'all', imageIds: [], createdAt: now };
  // 主人，可选字段和未来扩展字段也要一并清除；空庭院不等于初始种子名册哦。
  for (const key of Object.keys(state)) delete (state as unknown as Record<string, unknown>)[key];
  Object.assign(state, {
    agents: [], tasks: [], events: [], relationships: [], dailyEvents: [], roleProposals: [], membershipEvents: [], dailyTurn: 0,
    settings: { exploration: .2, drama: .6 }, config: { textReady: false, imageReady: false, model: DEFAULT_TEXT_MODEL, imageModel: 'nai-diffusion-5-full' },
    pendingCleanup: [job], updatedAt: now,
  } satisfies AppState);
}
