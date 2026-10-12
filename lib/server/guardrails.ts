import { z } from "zod";
import type { Agent, Memory, Skill, SocialEvent, Task } from "../types.ts";
import { normalizeCharacterSkills } from "../character-profile.ts";
import { PalaceError } from "./errors.ts";
import { appointmentContext } from "../appointments.ts";

const text = (max: number) => z.string().trim().min(1).max(max);
export const actionSchema = z.object({
  kind: z.enum(["propose", "request", "accept", "refuse", "challenge", "help", "submit"]),
  targetId: z.string().optional().nullable(), replyTo: z.string().optional().nullable(), content: text(2400),
  memories: z.array(z.object({ kind: z.enum(["preference", "experience", "relationship"]), content: text(600), source: text(180) })).max(2).default([]),
  revisedStrategy: text(500).optional().nullable(),
  imageRequest: text(1200).optional().nullable(),
});
export type GeneratedAction = z.infer<typeof actionSchema>;

/** 主人，通过关键词命中和时间顺序对记忆做简单相关性打分，取前 14 条。
 * 中文按 2–4 字分词、英文按 3 字母以上单词匹配，越靠后的记忆有微小时序加分。
 * 这不是语义搜索，只是轻量关键词召回哦。 */
export function relevantMemories(agent: Agent, context: string): Memory[] {
  const words = context.toLowerCase().match(/[a-z]{3,}|[\u4e00-\u9fff]{2,4}/g) || [];
  return agent.memories.map((memory, index) => ({ memory, score: words.reduce((sum, word) => sum + (memory.content.toLowerCase().includes(word) ? 4 : 0), 0) + index / Math.max(1, agent.memories.length) }))
    .sort((a, b) => b.score - a.score).slice(0, 14).map(({ memory }) => memory);
}

/** 主人，组装当前角色的私有上下文：策略、相关记忆、任命、近 12 条聊天和注意力信号。
 * 聊天附件和图片只传递元数据标识，不传递像素数据。
 * tools 默认为空数组，由调用方按场景注入可用工具。 */
export function ownContext(agent: Agent, context: string) {
  return {
    strategy: agent.strategy, longTermMemories: relevantMemories(agent, context),
    appointment: appointmentContext(agent),
    shortTermChats: agent.chats.slice(-12).map(chat => ({ sourceId: chat.id, role: chat.role, content: chat.content, ...(chat.image ? { image: { status: chat.image.status, request: chat.image.request, visuallyObserved: false } } : {}), ...(chat.attachments?.length ? { attachments: chat.attachments.map(image => ({ id: image.id, name: image.name, contentType: image.contentType, visuallyObserved: false })) } : {}) })),
    attentionSignals: { explicitlyLiked: agent.liked, recommendationWeight: agent.weight, userInitiatedChatBoosts: agent.chatBoost },
    tools: [],
  };
}

export function taskVisibility(agent: Agent, task: Task, events: SocialEvent[]) {
  const history = events.filter(event => event.taskId === task.id);
  const received = history.filter(event => event.targetId === agent.id);
  const pendingRequests = received.filter(event => task.participants.includes(event.agentId) && event.kind === "request" && event.checked && !history.some(reply => reply.replyTo === event.id && reply.agentId === agent.id && reply.checked && ["accept", "refuse"].includes(reply.kind)));
  return {
    publicPreviousRounds: history.filter(event => event.round < task.round && event.checked).slice(-20).map(event => ({ ...event, sourceId: event.id })),
    inbox: received.filter(event => event.checked).slice(-12).map(event => ({ ...event, sourceId: event.id })),
    pendingRequests,
    ownEarlierActions: history.filter(event => event.agentId === agent.id && event.checked).slice(-6),
  };
}

export function validateTaskAction(action: GeneratedAction, agent: Agent, task: Task, history: SocialEvent[]): GeneratedAction {
  const result = { ...action };
  if (result.imageRequest) throw new PalaceError("共议任务不能生成图片；图片仅限用户当前回合主动提出的私聊请求。", 502, "INVALID_AGENT_ACTION");
  if (["accept", "refuse"].includes(result.kind)) {
    const request = taskVisibility(agent, task, history).pendingRequests.find(event => event.id === result.replyTo);
    if (!request) throw new PalaceError("只能接受或拒绝收件箱中尚未处理的明确请求。", 502, "INVALID_AGENT_ACTION");
    result.targetId = request.agentId;
  } else {
    result.replyTo = null;
    if (result.targetId && (!task.participants.includes(result.targetId) || result.targetId === agent.id)) throw new PalaceError("交流对象必须是本任务中的另一位参与者。", 502, "INVALID_AGENT_ACTION");
    if (["request", "help"].includes(result.kind) && !result.targetId) throw new PalaceError("协作请求必须有明确接收者。", 502, "INVALID_AGENT_ACTION");
  }
  return result;
}

export function validateImageRequest(action: GeneratedAction, context: Record<string, unknown>): void {
  if (!action.imageRequest) return;
  const userMessage = context.userMessage as { content?: unknown } | undefined;
  if (context.mode !== "private-chat" || typeof userMessage?.content !== "string" || !userMessage.content.trim()) throw new PalaceError("图片只能响应用户当前回合的私聊请求。", 502, "INVALID_AGENT_ACTION");
  if (context.imageGenerationAvailable !== true) throw new PalaceError("当前图片服务不可用，不能承诺生成图片。", 502, "INVALID_AGENT_ACTION");
}

export function normalizeSkills(skills: Partial<Record<Skill, number>>): Record<Skill, number> {
  return normalizeCharacterSkills(skills);
}
