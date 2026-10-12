import { personalMemoryCount } from '../memory-capacity.ts';
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { Agent, AppState, ChatMessage, Memory, SocialEvent, Task, TaskArtifact } from "@/lib/types";
import { acceptedRelationship, applyFeedback, validateSettings } from "@/lib/domain";
import { PalaceError } from "./errors";
import { completeJson, generatePortrait, imageReady, imageModelName, referenceImageModelName, modelName, providerReady, requireProvider } from "./provider";
import { actionSchema, ownContext, taskVisibility, validateTaskAction, validateImageRequest, type GeneratedAction } from "./guardrails";
import { retryableModelFormatError } from "./model-json";
import { combineSystemPrompt, getPromptText } from "@/lib/prompts";
import { appointmentContext, setAppointment, removeAppointment } from "@/lib/appointments";
import { markLastTraceValidation } from "./provider-trace";
import { ALL_SKILLS, upgradeAppState } from "@/lib/character-profile";
import { createProfileExpansionSchema } from "./character-schema";
import { contentValidationOptions, contentValidationPolicy } from "@/lib/debug-validation";
import { startRecruitment, retryRecruitment, skipRecruitmentSlot, recruitmentCorrection, type RecruitmentDependencies } from "./recruitment";
import { characterTimeFields } from "@/lib/character-time";
import { attachChatImage, retryChatImage, chatImageStorageKey, type ChatImageDependencies, type ChatImageSink } from "./chat-image";
import { loadPortraitReference } from "./portrait-reference";
import { getEffectiveProvider } from './provider-settings';
import { renderImagePrompt } from '../image-prompts';
import { dailyStep, dailyContext, reviewRoleProposal } from './daily-life';
import { archiveMember, restoreMember, permanentlyDeleteMember, clearAllData, membershipContext } from '@/lib/member-lifecycle';
import { deliverTask } from './task-delivery';
import { appendGroupUserMessage, runGroupTurn, type GroupDependencies, type GroupImage } from './task-group';
import { runCode } from './code-interpreter';
import { searchWeb, readPublicWeb, plainText } from './web-tools';
import { userProfileContext } from '../user-profile';
import { loadChatVision } from './user-vision';
import type { TextImageInput } from './text-provider-adapter';

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const skillNames = ALL_SKILLS;

const short = (max = 1000) => z.string().trim().min(1).max(max);
const reviewSchema = z.object({ pass: z.boolean(), reason: z.string().max(800), imageRequested: z.boolean().optional() });

function agentById(state: AppState, agentId: string, hired = false): Agent {
  const agent = state.agents.find(item => item.id === agentId);
  if (!agent) throw new PalaceError("找不到这个角色。", 404, "NOT_FOUND");
  if (agent.archivedAt) throw new PalaceError('这位成员已离开庭院，请先从回收站恢复。', 409, 'MEMBER_ARCHIVED');
  if (hired && !agent.hired) throw new PalaceError("请先邀请她加入后宫。", 400);
  return agent;
}

export function hydrateConfig(state: AppState): AppState {
  state.config = { textReady: providerReady(), imageReady: imageReady(), model: modelName(), imageModel: imageModelName(), visionEnabled: getEffectiveProvider('text').visionEnabled === true };
  return state;
}

function core(agent: Agent) {
  return { name: agent.name, ...characterTimeFields(agent), title: agent.title, bio: agent.bio, appearance: agent.appearance, traits: agent.traits, values: agent.values, boundaries: agent.boundaries, voice: agent.voice, approach: agent.approach, species: agent.species, profile: agent.profile, skills: agent.skills, userAdoptedContributionsByPrimarySpecialty: agent.evidence };
}

function configuredImagePrompt(basePrompt: string, variables: Record<string, unknown> = {}): string {
  const config = getEffectiveProvider('image');
  return renderImagePrompt(basePrompt, config.promptStyle, config.customPrompt, variables);
}

function imageIdentity(agent: Agent): Record<string, unknown> {
  return { name: agent.name, age: agent.species.kind === 'synthetic' ? `manufactured on ${agent.species.manufacturedAt || 'unspecified date'}` : `${agent.age} years old`,
    species: `${agent.species.name} (${agent.species.kind})`, form: agent.species.form, appearance: agent.appearance, traits: agent.traits.join(', ') };
}

function saveMemory(agent: Agent, memory: Omit<Memory, "id" | "createdAt">): void {
  if (agent.memories.some(item => item.content === memory.content && item.kind === memory.kind)) return;
  // 主人，100 条普通记忆满后不再追加；已有条目可在界面管理，不会被静默裁剪。
  if (personalMemoryCount(agent) >= 100) return;
  agent.memories.push({ ...memory, id: id(), createdAt: now() });
}

function recordFeedback(state: AppState, agent: Agent, kind: "like" | "hire"): void {
  saveMemory(agent, { kind: "preference", content: getPromptText(kind === "hire" ? "feedback.hire" : agent.liked ? "feedback.like" : "feedback.unlike", state.promptOverrides), source: `用户${kind === "hire" ? "邀请" : "偏好操作"} · ${now()}` });
}

/** 主人，这是带审校的行动生成核心循环：生成 → 结构校验 → 图片权限检查 → 来源验证 → 人设审校。
 * 最多尝试两次（含首次生成）；审校可能误判，首次失败后会尽量携带修正提示重试。
 * 视觉输入同时传递给生成和审校两个模型调用。 */
async function checkedAction(state: AppState, agent: Agent, input: Record<string, unknown>, allowedSources: Set<string>, validate?: (action: GeneratedAction) => GeneratedAction, images: TextImageInput[] = []): Promise<{ action: GeneratedAction | null; reason?: string }> {
  const social = dailyContext(state, agent, String(input.currentSourceId || 'context'));
  const userProfile = userProfileContext(state);
  if (userProfile) {
    allowedSources.add(userProfile.source);
    if (userProfile.avatar && images.some(image => image.sourceUrl === userProfile.avatar!.url)) userProfile.avatar.visuallyObserved = true;
  }
  input = { ...input, userProfile, membership: membershipContext(state), recentDailyExchanges: social.recentEvents, socialRoles: social.roleProposals, validationPolicy: contentValidationPolicy(state) };
  for (const event of social.recentEvents) allowedSources.add(event.id);
  for (const event of state.membershipEvents || []) allowedSources.add(event.id);
  const deadline = Date.now() + 145_000;
  let correction = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
    const generated = await completeJson(combineSystemPrompt("actor.system", state.promptOverrides), { ...input, immutableCore: core(agent), correction }, 2600, Math.min(42_000, deadline - Date.now()), images);
    const parsed = actionSchema.safeParse(generated.value);
    if (!parsed.success) { correction = getPromptText("retry.action.schema", state.promptOverrides); markLastTraceValidation("行动结构检查", parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；")); continue; }
    let action = parsed.data;
    try { validateImageRequest(action, input); } catch (error) {
      if (!(error instanceof PalaceError)) throw error;
      correction = getPromptText("retry.action.validation", state.promptOverrides, { reason: error.message });
      markLastTraceValidation("图片请求权限检查", error.message); continue;
    }
    if (action.memories.some(memory => !allowedSources.has(memory.source))) { correction = getPromptText("retry.action.source", state.promptOverrides); markLastTraceValidation("记忆来源检查", "引用了不存在的来源。"); continue; }
    if (validate) {
      try { action = validate(action); } catch (error) { if (error instanceof PalaceError) { correction = getPromptText("retry.action.validation", state.promptOverrides, { reason: error.message }); markLastTraceValidation("行动权限检查", error.message); continue; } throw error; }
    }
    const reviewed = await completeJson(combineSystemPrompt("reviewer.system", state.promptOverrides), { immutableCore: core(agent), context: input, candidate: action, validationPolicy: contentValidationPolicy(state) }, 500, Math.min(25_000, deadline - Date.now()), images);
    const verdict = reviewSchema.safeParse(reviewed.value);
    if (verdict.success && verdict.data.pass && (!action.imageRequest || verdict.data.imageRequested === true)) return { action };
    if (verdict.success && verdict.data.pass && action.imageRequest && verdict.data.imageRequested !== true) {
      const reason = "当前用户回合没有经独立审校确认的图片请求；不要生成或承诺图片。";
      markLastTraceValidation("图片意图审校", reason);
      correction = getPromptText("retry.action.validation", state.promptOverrides, { reason }); continue;
    }
    markLastTraceValidation("人设审校", verdict.success ? verdict.data.reason : "审校结论格式无效。");
    correction = verdict.success ? getPromptText("retry.action.validation", state.promptOverrides, { reason: verdict.data.reason }) : getPromptText("retry.action.review", state.promptOverrides);
    } catch (error) {
      if (!retryableModelFormatError(error)) throw error;
      correction = error.code === "PROVIDER_TRUNCATED" ? getPromptText("retry.action.truncated", state.promptOverrides) : getPromptText("retry.action.json", state.promptOverrides);
    }
  }
  return { action: null, reason: correction };
}

/** 主人，将通过审校的行动中的记忆和修订策略提交到角色的持久状态。
 * 重复内容（相同 kind + content）不会重复存储。
 * 策略只在实际发生变化时才保存一条 strategy 类型记忆。 */
function commitLearning(agent: Agent, action: GeneratedAction, sourceId: string): void {
  for (const memory of action.memories) saveMemory(agent, memory);
  if (action.revisedStrategy && action.revisedStrategy !== agent.strategy) {
    agent.strategy = action.revisedStrategy;
    saveMemory(agent, { kind: "strategy", content: action.revisedStrategy, source: sourceId });
  }
}

function chatImageDependencies(state: AppState, userId: string, options: ActionOptions): ChatImageDependencies {
  return {
    generate: async (prompt, reference) => {
      if (!options.chatImageSink && !env.BUCKET) throw new PalaceError("图片存储尚未配置。", 503, "IMAGE_NOT_CONFIGURED");
      return generatePortrait(prompt, reference);
    },
    store: options.chatImageSink || (async (generated, messageId) => {
      await env.BUCKET!.put(chatImageStorageKey(userId, messageId), generated.bytes, { httpMetadata: { contentType: generated.contentType } });
      return `/api/portraits/chat-${messageId}`;
    }),
    model: referenceImageModelName,
    reference: agent => loadPortraitReference(agent, userId, env.BUCKET),
    prompt: (agent, request, userMessage) => {
      const variables = { ...imageIdentity(agent), request, userMessage };
      return configuredImagePrompt(getPromptText('chat.image.template', state.promptOverrides, variables), variables);
    },
  };
}

async function chat(state: AppState, agent: Agent, message: string, userId: string, options: ActionOptions, imageId?: string): Promise<string | undefined> {
  requireProvider();
  const attachment = imageId ? state.userUploads?.find(image => image.id === imageId) : undefined;
  if (imageId && !attachment) throw new PalaceError('待发图片不存在或已经发送，请重新选择或上传。', 400, 'CHAT_IMAGE_NOT_FOUND');
  applyFeedback(agent, "chat");
  const sourceId = id();
  agent.chats.push({ id: sourceId, role: "user", content: message, createdAt: now(), ...(attachment ? { attachments: [attachment] } : {}) });
  if (attachment) state.userUploads = (state.userUploads || []).filter(image => image.id !== attachment.id);
  const responseId = id();
  const vision = await loadChatVision(state, agent, userId, env.BUCKET, getEffectiveProvider('text').visionEnabled === true);
  const input = { mode: "private-chat", ...ownContext(agent, message), currentSourceId: responseId, userMessage: { sourceId, content: message, ...(attachment ? { attachments: [{ id: attachment.id, name: attachment.name, contentType: attachment.contentType }] } : {}) }, drama: state.settings.drama, imageGenerationAvailable: imageReady(), vision: vision.context };
  const allowed = new Set([responseId, ...agent.chats.map(item => item.id), ...agent.memories.map(item => item.source)]);
  const result = await checkedAction(state, agent, input, allowed, undefined, vision.images);
  let imageFailed = false;
  if (result.action) {
    const response: ChatMessage = { id: responseId, role: "assistant", content: result.action.content, createdAt: now(), checked: true };
    agent.chats.push(response);
    commitLearning(agent, result.action, responseId);
    if (result.action.imageRequest) imageFailed = await attachChatImage(agent, response, result.action.imageRequest, message, chatImageDependencies(state, userId, options)) === "failed";
  } else {
    agent.chats.push({ id: responseId, role: "assistant", content: "【系统提示】这次回答在两次生成后仍未通过内容格式或人物一致性检查，已暂缓发布。可以换一种问法继续交流。", createdAt: now(), checked: false });
  }
  agent.chats = agent.chats.slice(-40);
  return result.action ? imageFailed ? "文字回复已保存，图片生成失败；可以单独重试这张图片。" : attachment && !vision.context.enabled ? '图片已保存。当前未启用图片识别，角色只能读取文字；可在 API 设置中为支持视觉的模型开启。' : undefined : "这次回答未通过格式或人设检查，未发布角色台词。";
}

function shuffle(values: string[]): string[] {
  const array = [...values];
  for (let index = array.length - 1; index > 0; index--) {
    const random = crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
    const chosen = Math.floor(random * (index + 1));
    [array[index], array[chosen]] = [array[chosen], array[index]];
  }
  return array;
}

function groupDependencies(state: AppState, task: Task, userId: string, options: ActionOptions): GroupDependencies {
  const sandboxFiles = options.taskArtifactSink;
  return {
    generate: async (...args) => (await completeJson(...args)).value,
    prompt: stage => combineSystemPrompt(stage, state.promptOverrides), search: searchWeb,
    read: async url => { const page = await readPublicWeb(url); return { ...page, text: plainText(page.text).slice(0, 12000) }; },
    code: runCode,
    store: async (file, metadata) => {
      const bytes = new TextEncoder().encode(file.content);
      if (sandboxFiles) return sandboxFiles({ bytes, contentType: metadata.mimeType }, metadata);
      if (!env.BUCKET) throw new PalaceError('文件存储尚未配置。', 503);
      await env.BUCKET.put(`artifacts/${encodeURIComponent(userId)}/${metadata.id}`, bytes, { httpMetadata: { contentType: metadata.mimeType } });
    },
    load: async artifact => {
      if (options.taskArtifactLoad) { const value = await options.taskArtifactLoad(artifact); if (value !== undefined) return value; }
      const object = await env.BUCKET?.get(`artifacts/${encodeURIComponent(userId)}/${artifact.id}`);
      return object ? new Response(object.body).text() : '';
    },
    ...(imageReady() ? {
      image: async (prompt: string, referenceAgentId?: string) => {
        if (!referenceAgentId) return generatePortrait(configuredImagePrompt(prompt, { request: prompt, userMessage: task.title }));
        const person = agentById(state, referenceAgentId, true);
        if (!task.participants.includes(person.id)) throw new PalaceError('只能引用本群参与成员的头像。');
        const reference = await loadPortraitReference(person, userId, env.BUCKET);
        const variables = { ...imageIdentity(person), request: prompt,
          userMessage: state.events.filter(event => event.taskId === task.id && event.actorType === 'user').at(-1)?.content || task.title,
        };
        return generatePortrait(configuredImagePrompt(getPromptText('chat.image.template', state.promptOverrides, variables), variables), reference);
      },
      storeImage: async (image: GroupImage, metadata: TaskArtifact) => {
        if (sandboxFiles) return sandboxFiles(image, metadata);
        if (!env.BUCKET) throw new PalaceError('图片存储尚未配置。', 503);
        await env.BUCKET.put(`artifacts/${encodeURIComponent(userId)}/${metadata.id}`, image.bytes, { httpMetadata: { contentType: image.contentType } });
      },
    } : {}),
  };
}

async function taskStep(state: AppState, task: Task, userId: string, options: ActionOptions): Promise<string | undefined> {
  if (task.status !== "running") throw new PalaceError(task.status === "completed" ? "这个任务已经完成。" : "任务已暂停，请先继续。", 409);
  requireProvider();
  const agent = agentById(state, task.order[task.cursor], true);
  if (task.mode === 'group') {
    const message = await runGroupTurn(state, task, agent, groupDependencies(state, task, userId, options));
    advanceTask(task);
    return message;
  }
  const history = state.events.filter(event => event.taskId === task.id);
  const eventId = id();
  const input = {
    mode: "task-turn", ...ownContext(agent, task.title),
    task: { id: task.id, title: task.title, round: task.round, totalRounds: task.rounds, finalRound: task.round === task.rounds },
    participants: task.participants.map(participantId => { const person = agentById(state, participantId); return { id: person.id, name: person.name, title: person.title, species: person.species, skills: person.skills, appointment: appointmentContext(person) }; }),
    ...taskVisibility(agent, task, history),
    currentSourceId: eventId, drama: state.settings.drama, imageGenerationAvailable: false,
    instructions: getPromptText("task.instructions", state.promptOverrides),
  };
  const allowed = new Set([eventId, ...agent.chats.map(item => item.id), ...agent.memories.map(item => item.source), ...history.filter(event => event.round < task.round || event.targetId === agent.id || event.agentId === agent.id).map(item => item.id)]);
  const result = await checkedAction(state, agent, input, allowed, action => validateTaskAction(action, agent, task, history));
  let message: string | undefined;
  if (!result.action) {
    state.events.push({ id: eventId, taskId: task.id, round: task.round, agentId: agent.id, kind: "refuse", content: "【系统提示】本轮内容经两次生成仍未通过格式或人设检查，已暂缓发布。这不是角色自己的拒绝或成果。", createdAt: now(), checked: false });
    message = `${agent.name}本轮内容未通过格式或人设检查，已暂缓发布。`;
  } else {
    const action = result.action;
    const event: SocialEvent = { id: eventId, taskId: task.id, round: task.round, agentId: agent.id, kind: action.kind, targetId: action.targetId || undefined, replyTo: action.replyTo || undefined, content: action.content, createdAt: now(), checked: true };
    const relation = acceptedRelationship(event, state.events);
    if (relation && !state.relationships.some(item => item.taskId === relation.taskId && item.from === relation.from && item.to === relation.to)) state.relationships.push(relation);
    state.events.push(event);
    commitLearning(agent, action, eventId);
  }
  advanceTask(task);
  return message;
}

function advanceTask(task: Task): void {
  delete task.lastError;
  task.cursor++;
  if (task.cursor >= task.order.length) {
    if (task.round >= task.rounds) { task.status = "completed"; task.completedAt = now(); }
    else { task.round++; task.cursor = 0; task.order = shuffle(task.participants); }
  }
}

function recruitmentDependencies(state: AppState): RecruitmentDependencies {
  const preferences = state.agents.filter(agent => !agent.archivedAt && (agent.liked || agent.hired)).sort((a, b) => b.weight - a.weight).slice(0, 5).map(agent => ({ traits: agent.traits, voice: agent.voice, title: agent.title, species: agent.species, profile: { desire: agent.profile.desire, socialStyle: agent.profile.socialStyle, rivalryStyle: agent.profile.rivalryStyle }, attention: agent.weight }));
  const system = combineSystemPrompt("recruiter.system", state.promptOverrides);
  const nameHints = ["陆", "沈", "叶", "顾", "温", "苏", "许", "宁", "林", "江"];
  return {
    generate: async input => {
      const correction = recruitmentCorrection(input, state.promptOverrides);
      const batch = {
        direction: getPromptText(input.slot <= Math.ceil(input.count / 2) ? "recruiter.batch.analysis" : "recruiter.batch.practice", state.promptOverrides),
        nameHints: [nameHints[input.slot - 1]], batchId: `candidate-${input.slot}`, slot: input.slot,
        totalSlots: input.count, expectedCandidates: 1, exploratory: input.slot % 2 === 0,
      };
      const result = await completeJson(system, { brief: input.brief, preferences, userProfile: userProfileContext(state), existingNamesToAvoid: input.knownNames, nameRequirements: getPromptText("recruiter.names", state.promptOverrides), diversity: input.diversity, diversityRequirements: getPromptText('recruiter.diversity', state.promptOverrides), batch, correction, validationPolicy: contentValidationPolicy(state) }, 4500, input.timeoutMs);
      return result.value;
    },
  };
}

async function enrichProfile(state: AppState, agent: Agent): Promise<void> {
  if (agent.profileSource !== "derived") throw new PalaceError("这位角色已经有完整档案，无需再次深描。");
  requireProvider();
  const deadline = Date.now() + 325_000;
  const input = { immutableCore: core(agent), existingSpecies: agent.species, derivedProfile: agent.profile, validationPolicy: contentValidationPolicy(state) };
  const profileExpansionSchema = createProfileExpansionSchema(contentValidationOptions(state).contentRulesEnabled);
  let correction = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await completeJson(combineSystemPrompt("profile.enrich", state.promptOverrides), { ...input, correction }, 4500, Math.min(150_000, deadline - Date.now()));
      const parsed = profileExpansionSchema.safeParse(result.value);
      if (!parsed.success) {
        const reason = parsed.error.issues.slice(0, 3).map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；");
        markLastTraceValidation("档案结构检查", reason);
        correction = getPromptText("retry.profile.correct", state.promptOverrides, { reason });
        continue;
      }
      const speciesUnchanged = (Object.keys(agent.species) as (keyof Agent["species"])[]).every(key => JSON.stringify(agent.species[key]) === JSON.stringify(parsed.data.species[key]));
      if (!speciesUnchanged) {
        markLastTraceValidation("物种检查", "深描不能修改既有species字段。");
        correction = getPromptText("retry.profile.correct", state.promptOverrides, { reason: "species字段与existingSpecies不一致。" });
        continue;
      }
      const reviewed = await completeJson(combineSystemPrompt("profile.review", state.promptOverrides), { ...input, candidate: parsed.data }, 700, Math.min(25_000, deadline - Date.now()));
      const verdict = reviewSchema.safeParse(reviewed.value);
      if (!verdict.success || !verdict.data.pass) {
        const reason = verdict.success ? verdict.data.reason : "档案审校器未返回有效结论。";
        markLastTraceValidation("档案一致性检查", reason);
        correction = getPromptText("retry.profile.correct", state.promptOverrides, { reason });
        continue;
      }
      agent.profile = parsed.data.profile;
      agent.profileVersion = 2;
      agent.profileSource = "expanded";
      return;
    } catch (error) {
      if (!retryableModelFormatError(error)) throw error;
      correction = getPromptText("retry.profile.correct", state.promptOverrides, { reason: error.message });
    }
  }
  throw new PalaceError("档案深描未通过完整性或人物一致性审查，原档案保持不变。", 502, "PROFILE_ENRICH_FAILED");
}

export interface ActionPayload { action: string; requestId?: string; agentId?: string; eventId?: string; message?: string; messageId?: string; imageId?: string; brief?: string; count?: number; batchId?: string; slot?: number; title?: string; duties?: string; rounds?: number; taskId?: string; memoryId?: string; content?: string; exploration?: number; drama?: number; proposalId?: string; decision?: 'approve'|'private'|'reject'; confirmation?: string; }
export interface ActionOptions {
  chatImageSink?: ChatImageSink;
  taskArtifactSink?: (image: GroupImage, metadata: TaskArtifact) => Promise<void>;
  taskArtifactLoad?: (artifact: TaskArtifact) => Promise<string | undefined>;
}

export async function performAction(state: AppState, payload: ActionPayload, userId: string, options: ActionOptions = {}): Promise<{ message?: string; taskId?: string }> {
  upgradeAppState(state);
  if (state.pendingCleanup?.length && !['cleanup.retry','data.clear'].includes(payload.action)) throw new PalaceError('请先在数据管理中完成待处理清理，再进行其他操作。',409,'CLEANUP_PENDING');
  let message: string | undefined;
  let taskId: string | undefined;
  const required = (value: unknown, label: string, max: number): string => {
    const parsed = short(max).safeParse(value);
    if (!parsed.success) throw new PalaceError(`${label}不能为空，且最多${max}个字符。`);
    return parsed.data;
  };
  switch (payload.action) {
    case 'daily.step': {
      requireProvider();
      const result = await dailyStep(state, { generate: async (...args) => (await completeJson(...args)).value, prompt: stage => combineSystemPrompt(stage,state.promptOverrides), topic:payload.message, onValidationError:markLastTraceValidation });
      message = result.message; break;
    }
    case 'role.review': {
      if (!payload.decision) throw new PalaceError('请选择职位审阅结果。');
      reviewRoleProposal(state,required(payload.proposalId,'职位提议ID',100),payload.decision);
      message = payload.decision === 'approve' ? '已正式任命，当前职位已更新。' : payload.decision === 'private' ? '保留成员间的私下职位共识。' : '已不予正式任命，成员可以保留自己的看法。'; break;
    }
    case 'member.trash': archiveMember(state,required(payload.agentId,'角色ID',100)); message='她已离开庭院，完整记录保存在回收站。'; break;
    case 'member.restore': restoreMember(state,required(payload.agentId,'角色ID',100)); message='她已返回庭院，原有档案、记忆和聊天已恢复。'; break;
    case 'member.delete': permanentlyDeleteMember(state,required(payload.agentId,'角色ID',100),payload.confirmation); message='角色记录已永久删除。'; break;
    case 'data.clear': clearAllData(state,payload.confirmation); message='庭院记录已清空。'; break;
    case 'cleanup.retry': break;
    case 'task.deliver': {
      requireProvider();
      const task = state.tasks.find(item=>item.id===payload.taskId);
      if (!task) throw new PalaceError('找不到这个事务。',404);
      if (!env.BUCKET) throw new PalaceError('文件存储尚未配置。',503);
      taskId = task.id;
      message = await deliverTask(state,task,{
        generate:async (...args)=>(await completeJson(...args)).value,
        prompt:stage=>combineSystemPrompt(stage,state.promptOverrides), search:searchWeb,
        read:async url=>{const page=await readPublicWeb(url);return {...page,text:plainText(page.text).slice(0,12000)};},code:runCode,
        store:async (file,metadata)=>{await env.BUCKET!.put(`artifacts/${encodeURIComponent(userId)}/${metadata.id}`,new TextEncoder().encode(file.content),{httpMetadata:{contentType:metadata.mimeType}});},
        load:async artifact=>{const object=await env.BUCKET!.get(`artifacts/${encodeURIComponent(userId)}/${artifact.id}`);return object ? new Response(object.body).text() : '';},
      },payload.message); break;
    }
    case "profile.enrich": await enrichProfile(state, agentById(state, required(payload.agentId, "角色ID", 100))); break;
    case "recruit": message = await startRecruitment(state, required(payload.brief, "招募要求", 1800), payload.count, recruitmentDependencies(state)); break;
    case "recruit.retry": message = await retryRecruitment(state, required(payload.batchId, "招聘批次", 100), payload.slot, recruitmentDependencies(state)); break;
    case 'recruit.skip': message = skipRecruitmentSlot(state, required(payload.batchId, '招聘批次', 100), payload.slot!); break;
    case "hire": {
      const agent = agentById(state, required(payload.agentId, "角色ID", 100));
      if (!agent.hired && state.agents.filter(person => person.hired && !person.archivedAt).length >= 8) throw new PalaceError("最多同时容纳8位在庭角色，任务每次由最多5人参加。");
      if (!agent.hired) { applyFeedback(agent, "hire"); recordFeedback(state, agent, "hire"); }
      break;
    }
    case "like": { const agent = agentById(state, required(payload.agentId, "角色ID", 100)); applyFeedback(agent, "like"); recordFeedback(state, agent, "like"); break; }
    case "adopt": {
      const event = state.events.find(item => item.id === payload.eventId && item.checked && (!item.actorType || item.actorType === 'agent'));
      if (!event) throw new PalaceError("只能采纳本存档中已通过检查的真实角色发言。", 404);
      if (!event.adoptedAt) {
        const agent = agentById(state, event.agentId, true);
        event.adoptedAt = now(); agent.weight += 3;
        const strongest = [...skillNames].sort((a, b) => agent.skills[b] - agent.skills[a])[0];
        agent.evidence[strongest] = (agent.evidence[strongest] || 0) + 1;
        saveMemory(agent, { kind: "experience", content: getPromptText("feedback.adopt", state.promptOverrides, { content: event.content.slice(0, 400) }), source: event.id });
      }
      break;
    }
    case "chat": message = await chat(state, agentById(state, required(payload.agentId, "角色ID", 100), true), required(payload.message?.trim() || (payload.imageId ? '请看看这张图片。' : ''), "消息", 4000), userId, options, payload.imageId === undefined ? undefined : required(payload.imageId, '图片ID', 100)); break;
    case "chat.image.retry": {
      const agent = agentById(state, required(payload.agentId, "角色ID", 100), true);
      const outcome = await retryChatImage(agent, required(payload.messageId, "消息ID", 95), chatImageDependencies(state, userId, options));
      message = outcome === "failed" ? "图片仍未生成成功，文字和记录已保留。" : outcome === "unchanged" ? "这张图片已经生成成功，没有重复调用。" : "图片已生成，已添加到原回复。";
      break;
    }
    case "task.create": {
      requireProvider();
      if (state.tasks.some(task => task.status === "running")) throw new PalaceError("请先完成或暂停当前任务。", 409);
      const participants = shuffle(state.agents.filter(agent => agent.hired && !agent.archivedAt).map(agent => agent.id)).slice(0, 5);
      if (participants.length < 2) throw new PalaceError("请先邀请至少两位角色，再开始协作任务。");
      const rounds = typeof payload.rounds === "number" && Number.isInteger(payload.rounds) ? Math.max(1, Math.min(3, payload.rounds)) : 2;
      const task: Task = { id: id(), mode: 'group', title: required(payload.title, "任务", 2500), status: "running", rounds, round: 1, participants, order: shuffle(participants), cursor: 0, createdAt: now() };
      state.tasks.push(task); appendGroupUserMessage(state, task, task.title); taskId = task.id; break;
    }
    case 'task.message': case 'task.continue': {
      const task = state.tasks.find(item => item.id === payload.taskId);
      if (!task) throw new PalaceError('找不到这个事务。', 404);
      const content = payload.action === 'task.message' ? required(payload.message, '群聊消息', 4000) : undefined;
      if (state.tasks.some(item => item.id !== task.id && item.status === 'running')) throw new PalaceError('请先暂停正在运行的另一项事务。', 409);
      const participants = task.participants.filter(id => state.agents.some(agent => agent.id === id && agent.hired && !agent.archivedAt));
      if (participants.length < 2) throw new PalaceError('这个事务剩余成员不足两位，请新建事务。', 409);
      task.mode = 'group';
      task.participants = participants;
      if (task.status === 'completed') {
        const rounds = typeof payload.rounds === 'number' && Number.isInteger(payload.rounds) ? Math.max(1, Math.min(3, payload.rounds)) : 1;
        task.round = task.rounds + 1; task.rounds += rounds; task.order = shuffle(participants); task.cursor = 0;
        delete task.completedAt;
      }
      if (content) appendGroupUserMessage(state, task, content);
      task.status = 'paused'; taskId = task.id;
      message = content ? '消息已发到群中，成员将接着交流。' : '已准备继续交流。';
      break;
    }
    case "task.step": case "task.pause": case "task.resume": {
      const task = state.tasks.find(item => item.id === payload.taskId);
      if (!task) throw new PalaceError("找不到这个任务。", 404, "NOT_FOUND");
      taskId = task.id;
      if (payload.action === "task.step") { task.mode = 'group'; message = await taskStep(state, task, userId, options); }
      else if (payload.action === "task.pause" && task.status === "running") task.status = "paused";
      else if (payload.action === "task.resume" && task.status === "paused") {
        if (task.participants.filter(id=>state.agents.some(agent=>agent.id===id&&agent.hired&&!agent.archivedAt)).length<2) throw new PalaceError('这个事务剩余成员不足两位，请新建事务。',409);
        if (state.tasks.some(item => item.id !== task.id && item.status === "running")) throw new PalaceError("请先暂停正在运行的另一项任务。", 409);
        task.status = "running";
      }
      break;
    }
    case "memory.delete": case "memory.update": {
      const agent = agentById(state, required(payload.agentId, "角色ID", 100));
      const memory = agent.memories.find(item => item.id === payload.memoryId);
      if (!memory) throw new PalaceError("找不到这条记忆。", 404, "NOT_FOUND");
      if (payload.action === "memory.delete") {
        agent.memories = agent.memories.filter(item => item.id !== memory.id);
        if (memory.kind === "strategy" && memory.content === agent.strategy) agent.strategy = [...agent.memories].reverse().find(item => item.kind === "strategy")?.content || agent.approach;
      } else {
        const content = required(payload.content, "记忆", 600);
        if (memory.kind === "strategy") {
          const review = await completeJson(combineSystemPrompt("strategy.review", state.promptOverrides), { immutableCore: core(agent), context: { userEditedStrategy: content }, candidate: { revisedStrategy: content }, validationPolicy: contentValidationPolicy(state) }, 500, 25_000);
          const parsed = reviewSchema.safeParse(review.value);
          if (!parsed.success || !parsed.data.pass) throw new PalaceError("这项策略修改与固定人设不一致，请保持她原有的价值观和边界。", 400, "PERSONA_CONFLICT");
          agent.strategy = content;
        }
        memory.content = content; memory.updatedAt = now(); memory.source = `用户编辑 · ${now()}`;
      }
      break;
    }
    case "appointment.set": {
      const agent = agentById(state, required(payload.agentId, "角色ID", 100), true);
      setAppointment(agent, { title: required(payload.title, "职位", 30), duties: payload.duties }, { id: id(), now: now() });
      break;
    }
    case "appointment.remove": {
      const agent = agentById(state, required(payload.agentId, "角色ID", 100), true);
      removeAppointment(agent, { id: id(), now: now() });
      break;
    }
    case "settings": state.settings = validateSettings(payload, state.settings); break;
    case "portrait": {
      if (!env.BUCKET) throw new PalaceError("图片存储尚未配置。", 503, "IMAGE_NOT_CONFIGURED");
      const agent = agentById(state, required(payload.agentId, "角色ID", 100));
      const variables = imageIdentity(agent);
      const prompt = configuredImagePrompt(getPromptText('portrait.template', state.promptOverrides, variables), variables);
      const generated = await generatePortrait(prompt);
      const key = `portraits/${encodeURIComponent(userId)}/${agent.id}`;
      await env.BUCKET!.put(key, generated.bytes, { httpMetadata: { contentType: generated.contentType } });
      agent.portrait = `/api/portraits/${agent.id}?v=${Date.now()}`;
      agent.portraitPrompt = prompt;
      agent.portraitGeneratedAt = now();
      break;
    }
    default: throw new PalaceError("不支持的操作。", 400);
  }
  state.updatedAt = now();
  // 主人，近期任务历史有上限；长期记忆另行存储，不受此裁剪影响。
  if (state.tasks.length > 30) {
    const keep = new Set(state.tasks.filter(task => task.status !== "completed" || task.artifacts?.length).map(task => task.id));
    state.tasks.slice(-20).forEach(task => keep.add(task.id));
    state.tasks = state.tasks.filter(task => keep.has(task.id));
    state.events = state.events.filter(event => keep.has(event.taskId));
    state.relationships = state.relationships.filter(edge => keep.has(edge.taskId));
  }
  hydrateConfig(state);
  const serializedState = JSON.stringify(state, (key, value) => options.chatImageSink && key === "url" && typeof value === "string" && value.startsWith("data:image/") ? "[sandbox image]" : value);
  if (new TextEncoder().encode(serializedState).length > 1_800_000) throw new PalaceError("存档接近容量上限，请先清理一些长期记忆。此次操作未保存。", 413, "STATE_CAPACITY");
  return { message, taskId };
}




