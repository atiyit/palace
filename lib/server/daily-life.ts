import { personalMemoryCount } from '../memory-capacity.ts';
import { userProfileContext } from '../user-profile.ts';
import { z } from 'zod';
import type { Agent, AppState, DailyEvent, Memory, RoleProposal } from '../types.ts';
import { appointmentContext, setAppointment } from '../appointments.ts';
import { characterTimeFields } from '../character-time.ts';
import { contentValidationPolicy } from '../debug-validation.ts';
import { relevantMemories } from './guardrails.ts';
import { PalaceError } from './errors.ts';
import { retryableModelFormatError } from './model-json.ts';

const boundedText = (max: number) => z.string().trim().min(1).max(max);
export const dailyActionSchema = z.object({
  kind: z.enum(['chat', 'support', 'disagree', 'propose-role', 'endorse-role', 'decline-role']),
  targetId: boundedText(180).optional().nullable(), content: boundedText(1800),
  proposal: z.object({ holderId: boundedText(180), title: boundedText(30), duties: boundedText(600), reason: boundedText(600) }).strict().optional().nullable(),
  proposalId: boundedText(180).optional().nullable(),
  memories: z.array(z.object({ kind: z.enum(['preference', 'experience', 'relationship']), content: boundedText(600), source: boundedText(180) }).strict()).max(2).default([]),
  revisedStrategy: boundedText(500).optional().nullable(),
}).strict();
export type DailyAction = z.infer<typeof dailyActionSchema>;
const dailyReviewSchema = z.object({ pass: z.boolean(), reason: z.string().max(800) });

export interface DailyDependencies {
  generate(system: string, input: Record<string, unknown>, maxTokens: number, timeoutMs: number): Promise<unknown>;
  prompt(id: 'daily.system' | 'daily.review'): string;
  id?: () => string;
  now?: () => string;
  onValidationError?: (stage: string, reason: string) => void;
  topic?: string;
}
export interface DailyStepResult { agentId: string; event: DailyEvent; message?: string; }
const isPresent = (agent: Agent) => agent.hired && !agent.archivedAt;
const activeMembers = (state: AppState) => state.agents.filter(isPresent);

/** 主人，只有当前在庭的独立参与者才计入共识；已存储的支持记录不会赋予任何权限。 */
export function privateRoleConsensus(state: AppState, proposal: RoleProposal) {
  const present = new Set(activeMembers(state).map(agent => agent.id));
  const holderActive = present.has(proposal.holderId);
  const supporterIds = [...new Set(proposal.supporterIds)].filter(id => present.has(id));
  const holderAccepted = holderActive && supporterIds.includes(proposal.holderId);
  const otherSupporterIds = supporterIds.filter(id => id !== proposal.holderId);
  const holder = state.agents.find(agent => agent.id === proposal.holderId);
  const isOfficial = holderActive && proposal.status === 'approved' && holder?.appointment?.title === proposal.title && holder.appointment.duties === proposal.duties;
  return { formed: holderAccepted && otherSupporterIds.length > 0, holderActive, holderAccepted, supporterIds, otherSupporterIds, isOfficial };
}

function immutableCore(agent: Agent) {
  return { id: agent.id, name: agent.name, ...characterTimeFields(agent), title: agent.title, bio: agent.bio,
    appearance: agent.appearance, traits: agent.traits, values: agent.values, boundaries: agent.boundaries,
    voice: agent.voice, approach: agent.approach, species: agent.species, profile: agent.profile, skills: agent.skills };
}

/** 主人，在角色上下文中，定向交流仅对双方可见；职位讨论则是公开的。 */
export function dailyContext(state: AppState, agent: Agent, currentSourceId: string) {
  const members = activeMembers(state);
  const publicMembers = members.map(member => ({ id: member.id, name: member.name, title: member.title,
    tagline: member.tagline, species: { name: member.species.name, kind: member.species.kind, form: member.species.form },
    traits: [...member.traits], skills: { ...member.skills }, appointment: appointmentContext(member) }));
  const recentEvents = (state.dailyEvents || []).filter(event => event.checked && (!event.targetId || event.targetId === agent.id || event.agentId === agent.id)).slice(-30);
  const roleProposals = (state.roleProposals || []).slice(-60).map(proposal => ({ ...proposal, consensus: privateRoleConsensus(state, proposal) }));
  return {
    mode: 'daily-life', currentSourceId, immutableCore: immutableCore(agent), strategy: agent.strategy, userProfile: userProfileContext(state),
    longTermMemories: relevantMemories(agent, '日常 相处 合作 竞争 职务 信任 关系'),
    appointment: appointmentContext(agent), members: publicMembers,
    recentEvents: recentEvents.map(event => ({ ...event, sourceId: event.id })), roleProposals,
    membershipEvents: (state.membershipEvents || []).slice(-20).map(event => ({ ...event, sourceId: event.id })),
    attentionSignals: { explicitlyLiked: agent.liked, recommendationWeight: agent.weight, userInitiatedChatBoosts: agent.chatBoost },
    drama: state.settings.drama, tools: [], imageGenerationAvailable: false,
    validationPolicy: contentValidationPolicy(state),
  };
}

function invalid(message: string): never { throw new PalaceError(message, 502, 'INVALID_DAILY_ACTION'); }

function validateDailyAction(state: AppState, agent: Agent, action: DailyAction, context: ReturnType<typeof dailyContext>): DailyAction {
  const present = new Set(activeMembers(state).map(member => member.id));
  const allowedSources = new Set([context.currentSourceId, ...context.recentEvents.map(event => event.id), ...context.longTermMemories.map(memory => memory.source), ...context.roleProposals.map(proposal => proposal.id), ...context.membershipEvents.map(event => event.id)]);
  if (context.userProfile) allowedSources.add(context.userProfile.source);
  if (action.memories.some(memory => !allowedSources.has(memory.source))) invalid('记忆只能引用当前发言、本人可见的日常记录或已提供的本人记忆来源。');
  if (action.targetId && (!present.has(action.targetId) || action.targetId === agent.id)) invalid('定向交流对象必须是当前在庭的另一位成员。');
  if (action.kind === 'propose-role') {
    if (!action.proposal || action.proposalId) invalid('职位提议需要完整 proposal，不能冒用已有 proposalId。');
    if (!present.has(action.proposal.holderId)) invalid('只能提议当前在庭成员担任职务。');
    if ((state.roleProposals || []).some(item => item.holderId === action.proposal!.holderId && item.title === action.proposal!.title && item.status !== 'rejected')) invalid('同一成员已有同名职位提议，请讨论已有提议，不要重复创建。');
    if ((state.roleProposals || []).length >= 120) invalid('职位提议已达到本地容量上限，请改为普通交流。');
    return { ...action, targetId: null };
  }
  if (action.proposal) invalid('只有 propose-role 可以携带新的职位提议。');
  if (action.kind === 'endorse-role' || action.kind === 'decline-role') {
    const proposal = context.roleProposals.find(item => item.id === action.proposalId);
    if (!proposal || !present.has(proposal.holderId)) invalid('只能表态于可见且持有人仍在庭的有效职位提议。');
    if (proposal.status === 'approved') invalid('已经正式批准的职位不能通过日常表态撤销，意见请用普通交流表达。');
    const endorsed = proposal.supporterIds.includes(agent.id);
    if (action.kind === 'endorse-role' && endorsed) invalid('本人已经支持这个提议，不要重复表态。');
    return { ...action, targetId: null };
  }
  if (action.proposalId) invalid('普通交流不能携带职位操作 proposalId。');
  return action;
}

function appendMemory(agent: Agent, memory: Omit<Memory, 'id' | 'createdAt'>, id: () => string, now: string) {
  if (personalMemoryCount(agent) >= 100 || agent.memories.some(item => item.kind === memory.kind && item.content === memory.content)) return;
  agent.memories.push({ ...memory, id: id(), createdAt: now });
}

/** 主人，每回合只为一位成员生成内容，然后独立审校，通过后才更新记忆或职位提案。 */
export async function dailyStep(state: AppState, deps: DailyDependencies): Promise<DailyStepResult> {
  const members = activeMembers(state);
  if (!members.length) throw new PalaceError('请先邀请至少一位成员加入庭院。', 400, 'DAILY_REQUIRES_MEMBER');
  const turn = Number.isSafeInteger(state.dailyTurn) && state.dailyTurn! >= 0 ? state.dailyTurn! : 0;
  const agent = members[turn % members.length];
  const newId = deps.id || (() => crypto.randomUUID());
  const timestamp = deps.now || (() => new Date().toISOString());
  const eventId = newId();
  if (deps.topic !== undefined && (typeof deps.topic !== 'string' || deps.topic.length > 1000)) throw new PalaceError('日常话题最多 1000 个字符。', 400, 'INVALID_DAILY_TOPIC');
  const context = { ...dailyContext(state, agent, eventId), topic: deps.topic?.trim() || '按你的人格与最近相处经历，自主选择交流话题；不必每轮争夺职位。' };
  const deadline = Date.now() + 145_000;
  let correction = '';
  let accepted: DailyAction | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const value = await deps.generate(deps.prompt('daily.system'), { ...context, correction }, 2200, Math.max(1000, Math.min(42_000, deadline - Date.now())));
      const parsed = dailyActionSchema.safeParse(value);
      if (!parsed.success) {
        correction = `日常行动 JSON 不合格：${parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join('.') || '根对象'}: ${issue.message}`).join('；')}`;
        deps.onValidationError?.('日常行动结构检查', correction); continue;
      }
      let action: DailyAction;
      try { action = validateDailyAction(state, agent, parsed.data, context); }
      catch (error) {
        if (!(error instanceof PalaceError)) throw error;
        correction = error.message; deps.onValidationError?.('日常行动权限检查', correction); continue;
      }
      const reviewed = await deps.generate(deps.prompt('daily.review'), {
        immutableCore: context.immutableCore, context, candidate: action, validationPolicy: contentValidationPolicy(state),
      }, 550, Math.max(1000, Math.min(25_000, deadline - Date.now())));
      const verdict = dailyReviewSchema.safeParse(reviewed);
      if (verdict.success && verdict.data.pass) { accepted = action; break; }
      correction = verdict.success ? verdict.data.reason || '日常发言未通过人设与事实审校。' : '审校结论必须包含 pass 布尔值和 reason 字符串。';
      deps.onValidationError?.('日常人物与事实审校', correction);
    } catch (error) {
      if (!retryableModelFormatError(error)) throw error;
      correction = '模型 JSON 未能解析或被截断，请缩短内容并返回单个完整 JSON 对象。';
      deps.onValidationError?.('日常模型 JSON 检查', correction);
    }
  }
  const createdAt = timestamp();
  const event: DailyEvent = { id: eventId, agentId: agent.id, kind: accepted?.kind || 'chat',
    content: accepted?.content || '【系统提示】本轮日常发言在两次尝试后仍未通过结构或人设审校，已暂缓发布。',
    createdAt, checked: !!accepted };
  if (accepted) {
    if (accepted.targetId) event.targetId = accepted.targetId;
    if (accepted.kind === 'propose-role' && accepted.proposal) {
      const proposal: RoleProposal = { ...accepted.proposal, id: newId(), proposerId: agent.id, createdAt, supporterIds: [agent.id], status: 'pending' };
      (state.roleProposals ||= []).push(proposal); event.proposalId = proposal.id;
    } else if ((accepted.kind === 'endorse-role' || accepted.kind === 'decline-role') && accepted.proposalId) {
      const proposal = state.roleProposals!.find(item => item.id === accepted.proposalId)!;
      proposal.supporterIds = accepted.kind === 'endorse-role' ? [...new Set([...proposal.supporterIds, agent.id])] : proposal.supporterIds.filter(id => id !== agent.id);
      event.proposalId = proposal.id;
    }
    for (const memory of accepted.memories) appendMemory(agent, memory, newId, createdAt);
    if (accepted.revisedStrategy && accepted.revisedStrategy !== agent.strategy) {
      agent.strategy = accepted.revisedStrategy;
      appendMemory(agent, { kind: 'strategy', content: accepted.revisedStrategy, source: eventId }, newId, createdAt);
    }
  }
  state.dailyEvents = [...(state.dailyEvents || []), event].slice(-200);
  state.dailyTurn = turn >= Number.MAX_SAFE_INTEGER - 1 ? (turn + 1) % members.length : turn + 1;
  state.updatedAt = createdAt;
  return { agentId: agent.id, event, ...(!accepted ? { message: `${agent.name}这次日常发言未通过检查；已跳过并保留原有人设与记忆。` } : {}) };
}

/** 主人，只有您的审阅才能将自发共识转为正式任命，这是唯一的途径哦。 */
export function reviewRoleProposal(state: AppState, proposalId: string, decision: 'approve' | 'private' | 'reject', metadata?: { id: string; now: string; note?: string }): RoleProposal {
  if (!['approve', 'private', 'reject'].includes(decision)) throw new PalaceError('未知的职位审阅操作。', 400, 'INVALID_ROLE_REVIEW');
  const proposal = (state.roleProposals || []).find(item => item.id === proposalId);
  if (!proposal) throw new PalaceError('找不到这条职位提议。', 404, 'ROLE_PROPOSAL_NOT_FOUND');
  if (proposal.status === 'approved') {
    if (decision === 'approve') return proposal;
    throw new PalaceError('正式职务请在成员档案中调整或撤销。', 409, 'ROLE_ALREADY_APPROVED');
  }
  const consensus = privateRoleConsensus(state, proposal);
  if (decision !== 'reject' && !consensus.formed) throw new PalaceError('需要持有人本人同意，且至少另一位当前在庭成员支持，才能确认这项共识。', 409, 'ROLE_CONSENSUS_REQUIRED');
  const now = metadata?.now || new Date().toISOString();
  if (decision === 'approve') {
    const holder = activeMembers(state).find(agent => agent.id === proposal.holderId)!;
    setAppointment(holder, { title: proposal.title, duties: proposal.duties }, { id: metadata?.id || crypto.randomUUID(), now });
  }
  proposal.status = decision === 'approve' ? 'approved' : decision === 'private' ? 'private' : 'rejected';
  proposal.reviewedAt = now;
  if (metadata?.note) proposal.reviewNote = metadata.note.slice(0, 600);
  state.updatedAt = now;
  return proposal;
}
