import type { AppState, Agent } from "../types.ts";
import type { DebugCatalog, DebugResult, DebugStage } from "../debug-types.ts";
import { combineSystemPrompt, getPromptText, listPrompts, validatePromptOverrides, MAX_PROMPT_CHARS, MAX_TOTAL_PROMPT_CHARS } from "../prompts.ts";
import { appointmentContext } from "../appointments.ts";
import { upgradeAppState } from "../character-profile.ts";
import { characterTimeFields } from "../character-time.ts";
import { ownContext } from "./guardrails.ts";
import { contentValidationOptions, contentValidationPolicy } from "../debug-validation.ts";
import { createRichCandidateSchema, createProfileExpansionSchema } from "./character-schema.ts";
import { recruitmentSchemaIssues, recruitmentNamesToAvoid } from "./recruitment.ts";
import { recruitmentDiversity } from './recruit-diversity.ts';
import { z } from "zod";
import { createInitialState } from '../seeds.ts';
import { dailyContext, dailyActionSchema } from './daily-life.ts';
import { taskGroupContext, groupCommandSchema } from './task-group.ts';
import { renderImagePrompt, type ImagePromptStyle } from '../image-prompts.ts';
import { userProfileContext } from '../user-profile.ts';
import { userProfileDraftSchema } from './user-profile.ts';
import type { ActionOptions, ActionPayload } from "./engine";
import type { PortraitReference } from "./portrait-reference.ts";

import { PreviewHalt, withProviderTrace, redactDebugValue, markLastTraceValidation } from "./provider-trace.ts";

import { PalaceError, publicError } from "./errors.ts";

export interface DebugRequest { stage: DebugStage["id"]; promptId?: string; agentId?: string; taskId?: string; input?: unknown; draftOverrides?: Record<string, string>; maxTokens?: number; }
export interface DebugDependencies {
  performAction: (state: AppState, payload: ActionPayload, userId: string, options?: ActionOptions) => Promise<{ message?: string; taskId?: string }>;
  completeJson: (system: string, input: unknown, maxTokens: number, timeoutMs: number) => Promise<{ value: unknown }>;
  generatePortrait: (prompt: string, reference?: PortraitReference) => Promise<{ bytes: Uint8Array; contentType: string }>;
  loadReference: (agent: Agent, userId: string) => Promise<PortraitReference>;
  getEffectiveProvider: (kind: "text" | "image") => { apiKey: string; promptStyle?: ImagePromptStyle; customPrompt?: string };
  imageReady: () => boolean;
}

function agentCore(agent: Agent) {
  return { name: agent.name, ...characterTimeFields(agent), title: agent.title, bio: agent.bio, appearance: agent.appearance, traits: agent.traits, values: agent.values, boundaries: agent.boundaries, voice: agent.voice, approach: agent.approach, species: agent.species, profile: agent.profile, skills: agent.skills, userAdoptedContributionsByPrimarySpecialty: agent.evidence };
}
function selectedAgent(state: AppState, id?: string): Agent {
  const available = state.agents.filter(item=>!item.archivedAt);
  const agent = id ? available.find(item => item.id === id) : available.find(item => item.hired) || available[0] || createInitialState().agents[0];
  if (!agent) throw new PalaceError("请先选择一个可调试的角色。", 404);
  return agent;
}
function actorSample(agent: Agent, imageGenerationAvailable: boolean) {
  return { mode: "private-chat", immutableCore: agentCore(agent), ...ownContext(agent, "调试"), imageGenerationAvailable, currentSourceId: "debug-response", userMessage: { sourceId: "debug-user", content: "请用你自己的方式，帮我规划今天最重要的三件事。" }, drama: 0.6, correction: "" };
}
export function debugCatalog(state: AppState, agentId?: string, imageGenerationAvailable = false): DebugCatalog {
  upgradeAppState(state);
  const agent = selectedAgent(state, agentId);
  const actor = { ...actorSample(agent, imageGenerationAvailable), userProfile: userProfileContext(state) };
  const imageIdentity = { age: agent.species.kind === "synthetic" ? `manufactured on ${agent.species.manufacturedAt || "unspecified date"}` : `${agent.age} years old`, species: `${agent.species.name} (${agent.species.kind})`, form: agent.species.form, appearance: agent.appearance, traits: agent.traits.join(", ") };
  const stages: DebugStage[] = [
    { id: 'user-profile', title: '自我介绍草稿（不保存）', kind: 'text', defaultInput: { brief: '叫我阿林，喜欢科幻和安静的交流，希望答复直接一些。', currentProfile: userProfileContext(state), mode: 'user-editable-draft' } },
    { id: 'user-portrait', title: '用户头像模板（不保存）', kind: 'image', defaultInput: { name: state.userProfile?.name || '你', description: state.userProfile?.description || '', preferences: state.userProfile?.preferences || '', request: '温暖简洁的二次元头像' } },
    { id: "actor", title: "单次角色生成", kind: "text", defaultInput: actor },
    { id: "reviewer", title: "单次人设审校", kind: "text", defaultInput: { immutableCore: agentCore(agent), context: actor, candidate: { kind: "submit", content: "我会先把优先级整理清楚，再与你确认。", memories: [] } } },
    { id: "recruiter", title: "单批完整招聘（一人）", kind: "text", defaultInput: { brief: "善于规划，同时保留不同性格", preferences: [], existingNamesToAvoid: recruitmentNamesToAvoid(state), batch: { direction: getPromptText("recruiter.batch.analysis", state.promptOverrides), nameHints: ["陆"], batchId: "debug-one", slot: 1, totalSlots: 8, expectedCandidates: 1, exploratory: false }, correction: "" } },
    { id: "profile", title: "档案深描（单次生成）", kind: "text", defaultInput: { immutableCore: agentCore(agent), existingSpecies: agent.species, derivedProfile: agent.profile, correction: "" } },
    { id: "strategy-review", title: "用户策略审校", kind: "text", defaultInput: { immutableCore: agentCore(agent), context: { userEditedStrategy: agent.strategy, appointment: appointmentContext(agent) }, candidate: { revisedStrategy: agent.strategy } } },
    { id: "portrait", title: "肖像模板", kind: "image", defaultInput: imageIdentity },
    { id: "chat-image", title: "私聊图片模板", kind: "image", defaultInput: { ...imageIdentity, request: "Close-up of the character's hands, showing the specified species anatomy and distinctive details.", userMessage: "给我看看你的手，来一张手部特写。" } },
    { id: "chat", title: "完整私聊沙盒（含审校）", kind: "text", defaultInput: { message: "请用你自己的方式，帮我规划今天最重要的三件事。" } },
    { id: "task", title: "完整群聊回合沙盒（工具与审校）", kind: "text", defaultInput: { title: "为独立咖啡馆制定一个小预算开业方案。" } },
    { id: 'group', title: '群聊发言与工具规划（仅生成命令）', kind: 'text', defaultInput: { ...taskGroupContext(state, { id: 'debug-group', mode: 'group', title: '一起写一份三日计划，可提供文件、图片或文字。', status: 'paused', rounds: 1, round: 1, participants: state.agents.filter(item => item.hired && !item.archivedAt).map(item => item.id), order: [agent.id], cursor: 0, createdAt: state.updatedAt }, agent, 'debug-response'), tools: ['web.search', 'web.read', 'code.run', 'file.write', ...(imageGenerationAvailable ? ['image.generate'] : [])], fileContents: [], previousTools: [], maxToolCalls: 4, remainingToolCalls: 4, mustFinish: false, imageAlreadyAttempted: false, imageGenerationAvailable } },
    { id: 'group-review', title: '群聊发言与生图审校', kind: 'text', defaultInput: { context: { immutableCore: agentCore(agent), messages: [], members: [] }, candidate: { type: 'finish', kind: 'propose', content: '我先提出一个安排，大家可以一起完善。', memories: [] }, fileContents: [], artifacts: [], actualToolResults: [] } },
    { id:'daily',title:'日常相处（单次生成）',kind:'text',defaultInput:dailyContext(state,agent,'debug-daily') },
    { id:'daily-review',title:'日常互动审校',kind:'text',defaultInput:{immutableCore:agentCore(agent),context:dailyContext(state,agent,'debug-daily'),candidate:{kind:'chat',content:'今天想和大家聊聊最近的灵感。',memories:[]}} },
    { id:'delivery',title:'事务工具规划（仅生成命令）',kind:'text',defaultInput:{immutableCore:agentCore(agent),task:{title:'制作包含三日计划的CSV文件'},members:[],contributions:[],files:[],previousTools:[],step:1,maxToolCalls:6,tools:['web.search','web.read','code.run','file.write']} },
    { id:'delivery-review',title:'事务交付说明审校',kind:'text',defaultInput:{immutableCore:agentCore(agent),task:{title:'制作三日计划'},candidate:'尚未生成文件。',artifacts:[],actualToolResults:[]} },
  ];
  for (const stage of stages) if (stage.kind === "text") stage.defaultInput = { userProfile: userProfileContext(state), ...(stage.defaultInput as Record<string, unknown>), validationPolicy: contentValidationPolicy(state) };
  return { prompts: listPrompts(state.promptOverrides), stages, validation: contentValidationOptions(state), limits: { maxPromptChars: MAX_PROMPT_CHARS, maxTotalChars: MAX_TOTAL_PROMPT_CHARS } };
}

function inputObject(input: unknown): Record<string, unknown> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PalaceError("调试输入必须是一个 JSON 对象。");
  if (JSON.stringify(input).length > 40_000) throw new PalaceError("调试输入不能超过40000个字符。", 413);
  return input as Record<string, unknown>;
}
function selectedStage(stage: DebugStage["id"], promptId?: string): DebugStage["id"] {
  if (stage === "chat" || stage === "task") {
    if (promptId && !["framework.system", "actor.system", "memory.instructions", "reviewer.system", "user.context", ...(stage === "task" ? ["task.instructions", 'task.group', 'task.group.review'] : ["chat.image.template"])].includes(promptId) && !promptId.startsWith("retry.action.")) throw new PalaceError("所选提示词不属于这个完整流程，请选择对应的单阶段调试。");
    return stage;
  }
  if (!promptId || promptId === "framework.system") return stage;
  if (promptId === 'user.profile') return 'user-profile';
  if (promptId === 'user.portrait.template') return 'user-portrait';
  if (promptId === 'daily.system') return 'daily';
  if (promptId === 'daily.review') return 'daily-review';
  if (promptId === 'task.delivery') return 'delivery';
  if (promptId === 'task.delivery.review') return 'delivery-review';
  if (promptId === 'task.group') return 'group';
  if (promptId === 'task.group.review') return 'group-review';
  if (promptId === "profile.enrich" || promptId.startsWith("retry.profile.")) return "profile";
  if (promptId === "profile.review") return "reviewer";
  if (promptId === "portrait.template") return "portrait";
  if (promptId === "chat.image.template") return "chat-image";
  if (promptId.startsWith("recruiter.") || promptId.startsWith("retry.recruit.")) return "recruiter";
  if (promptId === "reviewer.system") return "reviewer";
  if (promptId === "strategy.review") return "strategy-review";
  return "actor";
}

function compileStage(state: AppState, request: DebugRequest, agent: Agent, imageGenerationAvailable: boolean): { stage: DebugStage["id"]; system?: string; input: Record<string, unknown>; prompt?: string } {
  const stage = selectedStage(request.stage, request.promptId);
  const catalog = debugCatalog(state, agent.id, imageGenerationAvailable);
  const defaults = catalog.stages.find(item => item.id === stage)!.defaultInput as Record<string, unknown>;
  const input = { ...defaults, ...inputObject(request.input) };
  const overrides = state.promptOverrides;
  const selected = request.promptId;
  if (stage === "recruiter") {
    input.nameRequirements = getPromptText("recruiter.names", overrides); input.diversityRequirements = getPromptText('recruiter.diversity', overrides);
    input.diversity ??= recruitmentDiversity(state, { id: 'debug-batch', brief: String(input.brief || ''), count: 1, slots: [], applied: false, createdAt: state.updatedAt, updatedAt: state.updatedAt }, 1);
  }
  if (selected?.startsWith("retry.")) input.correction = getPromptText(selected, overrides, { reason: input.reason || "本轮内容需要符合固定人格和有效JSON协议。", names: input.names ?? input.existingNamesToAvoid ?? [] });
  if (selected === "task.instructions") input.instructions = getPromptText(selected, overrides);
  if (selected?.startsWith("recruiter.batch.")) input.batch = { ...(typeof input.batch === "object" && input.batch ? input.batch : {}), direction: getPromptText(selected, overrides) };
  if (selected?.startsWith("feedback.")) input.longTermMemories = [{ id: "debug-feedback", kind: "experience", source: "debug-user-feedback", content: getPromptText(selected, overrides, { content: input.content || "调试作品片段" }) }];
  if (stage === 'user-portrait') return { stage, input, prompt: getPromptText('user.portrait.template', overrides, input) };
  if (stage === 'user-profile') return { stage, input, system: combineSystemPrompt('user.profile', overrides) };
  if (stage === "portrait" || stage === "chat-image") {
    const values = { ...input, traits: Array.isArray(input.traits) ? input.traits.join(", ") : input.traits };
    return { stage, input, prompt: getPromptText(stage === "chat-image" ? "chat.image.template" : "portrait.template", overrides, values) };
  }
  if (selected === "profile.review") Object.assign(input, { existingSpecies: agent.species, derivedProfile: agent.profile, candidate: { species: agent.species, profile: agent.profile }, ...inputObject(request.input) });
  input.validationPolicy = contentValidationPolicy(state);
  const systemId = stage === 'group' ? 'task.group' : stage === 'group-review' ? 'task.group.review' : stage === 'daily' ? 'daily.system' : stage === 'daily-review' ? 'daily.review' : stage === 'delivery' ? 'task.delivery' : stage === 'delivery-review' ? 'task.delivery.review' : selected === "profile.review" ? "profile.review" : stage === "profile" ? "profile.enrich" : stage === "reviewer" ? "reviewer.system" : stage === "recruiter" ? "recruiter.system" : stage === "strategy-review" ? "strategy.review" : "actor.system";
  return { stage, input, system: combineSystemPrompt(systemId, overrides) };
}

function dataUrl(bytes: Uint8Array, contentType: string): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return `data:${contentType};base64,${btoa(binary)}`;
}

export async function runDebugCore(state: AppState, request: DebugRequest, mode: "preview" | "run", userId: string, dependencies: DebugDependencies): Promise<DebugResult> {
  const { performAction, completeJson, generatePortrait, getEffectiveProvider } = dependencies;
  const started = Date.now();
  const clone = upgradeAppState(structuredClone(state));
  clone.agents = clone.agents.filter(agent=>!agent.archivedAt);
  if (!clone.agents.length) clone.agents = createInitialState().agents.slice(0,2);
  try { clone.promptOverrides = validatePromptOverrides({ ...state.promptOverrides, ...request.draftOverrides }); }
  catch (error) { throw new PalaceError(error instanceof Error ? error.message : "提示词无效。"); }
  const agent = selectedAgent(clone, request.agentId);
  let compiled: ReturnType<typeof compileStage>;
  try {
    if (request.promptId && !listPrompts(clone.promptOverrides).some(item => item.id === request.promptId)) throw new Error("未知的提示词配置项。");
    // 主人，沙盒会移除已归档角色并可能添加示例；排除列表必须反映真实存档的状态。
    const recruitmentRequest = selectedStage(request.stage, request.promptId) === "recruiter"
      ? { ...request, input: { existingNamesToAvoid: recruitmentNamesToAvoid(state), diversity: recruitmentDiversity(state, { id: 'debug-batch', brief: String(inputObject(request.input).brief || ''), count: 1, slots: [], applied: false, createdAt: state.updatedAt, updatedAt: state.updatedAt }, 1), ...inputObject(request.input) } }
      : request;
    compiled = compileStage(clone, recruitmentRequest, agent, dependencies.imageReady());
  } catch (error) { if (error instanceof PalaceError) throw error; throw new PalaceError(error instanceof Error ? error.message : "提示词编译失败。"); }
  let imageDataUrl: string | undefined;
  const outcome = await withProviderTrace(mode === "preview", async () => {
    if (compiled.stage === "portrait" || compiled.stage === "chat-image" || compiled.stage === 'user-portrait') {
      const reference = compiled.stage === "chat-image" ? await dependencies.loadReference(agent, userId) : undefined;
      const config = getEffectiveProvider('image');
      const prompt = renderImagePrompt(compiled.prompt!, config.promptStyle, config.customPrompt, { name: agent.name, ...compiled.input });
      const generated = await generatePortrait(prompt, reference);
      imageDataUrl = dataUrl(generated.bytes, generated.contentType);
      return { contentType: generated.contentType, bytes: generated.bytes.length };
    }
    if (compiled.stage === "chat") {
      agent.hired = true;
      const message = typeof compiled.input.message === "string" ? compiled.input.message : "请用你自己的方式帮我规划今天。";
      const detail = await performAction(clone, { action: "chat", agentId: agent.id, message, ...(typeof compiled.input.imageId === 'string' ? { imageId: compiled.input.imageId } : {}) }, userId, {
        chatImageSink: async image => {
          imageDataUrl = dataUrl(image.bytes, image.contentType);
          return imageDataUrl;
        },
      });
      return { ...detail, reply: agent.chats[agent.chats.length - 1], strategy: agent.strategy, proposedMemories: agent.memories.filter(memory => !state.agents.find(item => item.id === agent.id)?.memories.some(old => old.id === memory.id)) };
    }
    if (compiled.stage === "task") {
      let task = request.taskId ? clone.tasks.find(item => item.id === request.taskId) : undefined;
      if (request.taskId && !task) throw new PalaceError("找不到用于调试的任务。", 404);
      if (!task) {
        const others = clone.agents.filter(item => item.id !== agent.id);
        if (!others.length) throw new PalaceError("共议沙盒需要至少两个角色。");
        agent.hired = true; others[0].hired = true;
        clone.tasks.forEach(item => { if (item.status === "running") item.status = "paused"; });
        const created = await performAction(clone, { action: "task.create", title: String(compiled.input.title || "为独立咖啡馆制定小预算开业方案。"), rounds: 2 }, userId);
        task = clone.tasks.find(item => item.id === created.taskId)!;
        if (!task.participants.includes(agent.id)) { task.participants[0] = agent.id; task.order = [...task.participants]; }
        task.order = [agent.id, ...task.order.filter(participant => participant !== agent.id)];
      }
      if (task.status === "completed") throw new PalaceError("已完成的任务不能继续调试，请选择其他任务或清空任务选择。");
      task.status = "running";
      const before = clone.events.length;
      const sandboxFiles = new Map<string, string>();
      const detail = await performAction(clone, { action: "task.step", taskId: task.id }, userId, {
        taskArtifactSink: async (output, metadata) => {
          if (metadata.kind === 'image') imageDataUrl = dataUrl(output.bytes, output.contentType);
          else sandboxFiles.set(metadata.id, new TextDecoder().decode(output.bytes));
        },
        taskArtifactLoad: async artifact => sandboxFiles.get(artifact.id),
      });
      return { ...detail, events: clone.events.slice(before), task, files: Object.fromEntries(sandboxFiles), proposedMemories: agent.memories.filter(memory => !state.agents.find(item => item.id === agent.id)?.memories.some(old => old.id === memory.id)) };
    }
    const result = await completeJson(compiled.system!, compiled.input, request.maxTokens || (compiled.stage === "recruiter" || compiled.stage === "profile" ? 4500 : compiled.stage.includes("review") ? 700 : 2600), compiled.stage === "recruiter" || compiled.stage === "profile" ? 160_000 : 55_000);
    const enabled = contentValidationOptions(clone).contentRulesEnabled;
    const validationSchema = compiled.stage === 'user-profile' ? userProfileDraftSchema : compiled.stage === 'group' ? groupCommandSchema : compiled.stage === 'daily' ? dailyActionSchema : compiled.stage === "recruiter" ? z.object({ candidates: z.array(createRichCandidateSchema(enabled)).length(1) }) : compiled.stage === "profile" ? createProfileExpansionSchema(enabled) : undefined;
    if (validationSchema) {
      const parsed = validationSchema.safeParse(result.value);
      if (!parsed.success) {
        const reason = recruitmentSchemaIssues(parsed.error).map(issue => `${issue.path}: ${issue.message}`).join("；");
        markLastTraceValidation("人物字段检查", reason);
        throw new PalaceError(`人物字段检查未通过：${reason}`, 422, "CHARACTER_VALIDATION");
      }
    }
    return result.value;
  });
  const preview = outcome.error instanceof PreviewHalt;
  let error = outcome.error && !preview ? publicError(outcome.error).message : undefined;
  const value = outcome.value as { reply?: { checked?: boolean; image?: { status: string; error?: string } }; events?: { checked: boolean }[]; message?: string } | undefined;
  if (!error && (value?.reply?.checked === false || value?.events?.some(event => !event.checked))) error = value.message || "本轮内容未通过格式或人设审查。";
  if (!error && compiled.stage === 'task' && value?.message) error = value.message;
  if (!error && value?.reply?.image?.status === "failed") error = value.reply.image.error || value.message || "本次聊天图片生成失败，文字回复已保留。";
  const pipeline = compiled.stage === "chat" || compiled.stage === "task";
  const output = pipeline && preview ? { note: "完整流程预览仅展示首个真实请求；审校、重试及聊天生图提示词只在运行并实际触发对应步骤时使用。要直接预览图片提示词，请选择私聊图片模板阶段。" } : outcome.value;
  const result: DebugResult = { mode, status: preview ? "preview" : error ? "error" : "ok", trace: outcome.trace, output, imageDataUrl, error, elapsedMs: Date.now() - started, persisted: false };
  return redactDebugValue(result, [getEffectiveProvider("text").apiKey, getEffectiveProvider("image").apiKey]);
}
