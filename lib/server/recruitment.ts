import { z } from "zod";
import type { Agent, AppState, RecruitmentBatch, RecruitmentIssue, RecruitmentSlot } from "../types.ts";
import { normalizeCharacterSkills } from "../character-profile.ts";
import { createRichCandidateSchema, richCandidateSchema } from "./character-schema.ts";
import { contentValidationOptions } from "../debug-validation.ts";
import { getPromptText } from "../prompts.ts";
import { PalaceError } from "./errors.ts";
import { recruitmentDiversity, recruitmentDiversityIssues, recruitmentKnownCharacters, type RecruitmentDiversity } from "./recruit-diversity.ts";

export interface RecruitmentGenerationInput {
  brief: string; slot: number; count: number; knownNames: string[]; timeoutMs: number;
  previousIssues: RecruitmentIssue[]; attempt: number;
  previousErrorCode?: string; diversity: RecruitmentDiversity;
}
export interface RecruitmentDependencies {
  generate: (input: RecruitmentGenerationInput) => Promise<unknown>;
  now?: () => number;
  id?: () => string;
}
export const RECRUITMENT_DEADLINE_MS = 325_000;
const colors = ["#D4A6A1", "#A5BDB6", "#B9AECF", "#D3BA8C", "#C5AAB5", "#94B4C5", "#CFB4A3", "#A9B6A0", "#B9BFA0", "#ADAACD"];

function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s/gu, "").toLowerCase();
}

/** 展示用的原始名称我会原样递给模型，同时用归一化拼写做一致性比较——两边都替主人照顾好呢。 */
export function recruitmentNamesToAvoid(state: AppState, batch = state.recruitment): string[] {
  const names = new Map<string, string>();
  const existing = [...state.agents.map(agent => agent.name), ...(batch?.slots.flatMap(slot => slot.status === "succeeded" && slot.candidate ? [slot.candidate.name] : []) || [])];
  for (const name of existing) if (nameKey(name) && !names.has(nameKey(name))) names.set(nameKey(name), name.trim());
  return [...names.values()];
}

export function recruitmentCorrection(input: Pick<RecruitmentGenerationInput, "previousIssues" | "knownNames" | "previousErrorCode">, overrides: Record<string, string> = {}): string {
  const reason = input.previousIssues.map(issue => `${issue.path}: ${issue.message}`).join("；").slice(0, 700);
  if (!reason) return "";
  const corrections = [getPromptText("retry.recruit.schema", overrides, { reason })];
  if (input.previousIssues.some(issue => issue.path === "candidates.0.name")) corrections.push(getPromptText("retry.recruit.names", overrides, { names: input.knownNames }));
  if (input.previousErrorCode === "RECRUITMENT_SIMILAR") corrections.push(getPromptText("retry.recruit.diversity", overrides, { reason }));
  return corrections.join("\n");
}

function duplicateFailure(name: string): Failure {
  return { code: "RECRUITMENT_DUPLICATE", blocksQueue: false, issues: [{ path: "candidates.0.name", message: `姓名与已有角色「${name}」重复（忽略空白、大小写及全半角差异），请换一个不同的名字后重新生成此项。` }] };
}

export function recruitmentCount(input: unknown = 3): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 10) throw new PalaceError("生成数量需要是1至10之间的整数。");
  return input;
}

/** 只有结构元数据会被整理进诊断信息；模型返回的实际值不会被我复制到错误报告里，请主人放心。 */
export function recruitmentSchemaIssues(error: z.ZodError): RecruitmentIssue[] {
  return error.issues.slice(0, 8).map(issue => {
    let message = "字段不符合要求";
    if (issue.code === "invalid_type") {
      const labels: Record<string, string> = { string: "文本", number: "数值", integer: "整数", array: "数组", object: "对象", boolean: "布尔值" };
      message = issue.received === "undefined" ? "缺少必填字段" : `需要${labels[issue.expected] || "正确的数据类型"}`;
    } else if (issue.code === "too_small") message = issue.exact ? `需要恰好${issue.minimum}项` : `至少需要${issue.minimum}${issue.type === "string" ? "个字符" : issue.type === "array" ? "项" : "的数值"}`;
    else if (issue.code === "too_big") message = issue.exact ? `需要恰好${issue.maximum}项` : `不能超过${issue.maximum}${issue.type === "string" ? "个字符" : issue.type === "array" ? "项" : "的数值"}`;
    else if (issue.code === "invalid_enum_value") message = "值不在允许的选项中";
    else if (issue.code === "invalid_string") message = "文本格式不正确";
    else if (issue.code === "custom") message = issue.message;
    return { path: issue.path.join(".").slice(0, 160) || "$", message: message.slice(0, 240) };
  });
}

interface Failure { code: string; issues: RecruitmentIssue[]; blocksQueue: boolean; }
export function recruitmentFailure(error: unknown): Failure {
  const code = error instanceof PalaceError ? error.code : "PROVIDER_ERROR";
  const fixed: Record<string, string> = {
    PROVIDER_QUOTA: "模型服务余额不足，请充值或在庭院设置更换 API Key。",
    MODEL_NOT_CONFIGURED: "尚未配置模型密钥，请在庭院设置中填写 API Key。",
    PROVIDER_TIMEOUT: "模型服务响应超时，请点击重新生成后重试。",
    RECRUITMENT_BUDGET: "本次生成达到时间预算，此项可以单独重新生成。",
    PROVIDER_ERROR: "模型服务连接、权限或限流异常，请检查 API 配置后重试。",
  };
  if (code === "PROVIDER_TRUNCATED") return { code, blocksQueue: false, issues: [{ path: "$", message: "JSON输出达到Token上限而被截断，请点击重新生成。" }] };
  if (code === "PROVIDER_FORMAT") {
    const detail = error instanceof PalaceError ? error.message : "";
    let message = detail.includes("多个JSON对象") ? "返回了多个JSON对象，需要单个对象。" : detail.includes("数组包裹") ? "JSON对象外存在数组包裹或多余结构字符。" : detail.includes("未闭合") ? "JSON对象或字符串未闭合。" : "JSON格式无效，需要一个完整的JSON对象。";
    const position = /JSON对象内字符位置\s*(\d+)/.exec(detail);
    const line = /第\s*(\d+)\s*行，第\s*(\d+)\s*列/.exec(detail);
    if (position) message += ` JSON对象内字符位置 ${position[1]}。`;
    if (line) message += ` 第${line[1]}行，第${line[2]}列。`;
    return { code, blocksQueue: false, issues: [{ path: "$", message }] };
  }
  return { code: fixed[code] ? code : "PROVIDER_ERROR", blocksQueue: true, issues: [{ path: "$", message: fixed[code] || fixed.PROVIDER_ERROR }] };
}

function failSlot(slot: RecruitmentSlot, failure: Failure, notStarted = false): void {
  slot.status = "failed";
  delete slot.candidate;
  slot.errorCode = failure.code;
  slot.issues = failure.issues.map(issue => ({ ...issue, message: notStarted ? `此项尚未调用模型。${issue.message}` : issue.message }));
}

function candidateAgent(person: z.infer<typeof richCandidateSchema>, slot: number, now: string, id: () => string, contentRulesEnabled: boolean): Agent {
  return { ...person, skills: contentRulesEnabled ? normalizeCharacterSkills(person.skills) : { ...person.skills }, skillPolicy: contentRulesEnabled ? "balanced" : "unrestricted", profileVersion: 2, profileSource: "generated", id: id(), evidence: {}, portrait: "", color: colors[(slot - 1) % colors.length], hired: false, liked: false, weight: 1, chatBoost: 0, createdAt: now, strategy: person.approach, memories: [], chats: [] };
}

/** 请把寻访的事情交给我吧——我会派出最多两位女仆同时去接待（并发工作者），每个招募槽位各见一次模型。
 * 每份回信我都单独核对名册，有重名的立刻退回；主人启用内容规则时，我还会做多维相似度检查，不让近似的副本同时蒙混过关。
 * 模型那边出了差错，我会如实记在槽位档案里，不擅自替主人重试；遇到阻塞性错误则后续槽位一律暂停呢。 */
async function generateSlots(state: AppState, batch: RecruitmentBatch, targets: RecruitmentSlot[], dependencies: RecruitmentDependencies): Promise<string> {
  const { contentRulesEnabled } = contentValidationOptions(state);
  const candidateResponse = z.object({ candidates: z.array(createRichCandidateSchema(contentRulesEnabled)).length(1) });
  const now = dependencies.now || Date.now;
  const id = dependencies.id || (() => crypto.randomUUID());
  const deadline = now() + RECRUITMENT_DEADLINE_MS;
  const names = new Map(recruitmentNamesToAvoid(state, batch).map(name => [nameKey(name), name]));
  let cursor = 0;
  let blocked: Failure | undefined;
  // 我安排了两位并发工作者，每个选中的槽位只叩门一次模型。若模型回话有误，就老实记进档案，不会自作主张地重试哦。
  await Promise.all(Array.from({ length: Math.min(2, targets.length) }, async () => {
    while (!blocked && cursor < targets.length) {
      const remaining = deadline - now();
      if (remaining < 10_000) { blocked = recruitmentFailure(new PalaceError("", 504, "RECRUITMENT_BUDGET")); break; }
      const slot = targets[cursor++];
      const previousIssues = slot.issues.map(issue => ({ ...issue }));
      const previousErrorCode = slot.errorCode;
      slot.status = "pending"; slot.attempts++; slot.issues = []; delete slot.errorCode; delete slot.candidate;
      try {
        const raw = await dependencies.generate({ brief: batch.brief, slot: slot.slot, count: batch.count, knownNames: [...names.values()], timeoutMs: Math.min(150_000, remaining), previousIssues, previousErrorCode, attempt: slot.attempts, diversity: recruitmentDiversity(state, batch, slot.slot) });
        const parsed = candidateResponse.safeParse(raw);
        if (!parsed.success) {
          failSlot(slot, { code: "RECRUITMENT_SCHEMA", blocksQueue: false, issues: recruitmentSchemaIssues(parsed.error) });
          continue;
        }
        const person = parsed.data.candidates[0];
        const duplicate = names.get(nameKey(person.name));
        if (duplicate !== undefined) { failSlot(slot, duplicateFailure(duplicate)); continue; }
        // 启用内容规则时，每收到一封回信我都会立刻比对相似度——这份检查我会逐一做完，尽量避免并发生成的近似副本同时通过呀。
        const similar = contentRulesEnabled ? recruitmentDiversityIssues(person, recruitmentKnownCharacters(state, batch), batch.brief) : [];
        if (similar.length) { failSlot(slot, { code: "RECRUITMENT_SIMILAR", blocksQueue: false, issues: similar }); continue; }
        names.set(nameKey(person.name), person.name);
        slot.candidate = candidateAgent(person, slot.slot, new Date(now()).toISOString(), id, contentRulesEnabled);
        slot.status = "succeeded";
      } catch (error) {
        const failure = recruitmentFailure(error);
        failSlot(slot, failure);
        if (failure.blocksQueue) blocked ??= failure;
      }
    }
  }));
  if (blocked) for (const slot of targets.slice(cursor)) failSlot(slot, blocked, true);
  batch.updatedAt = new Date(now()).toISOString();
  return applyCompletedRecruitment(state, batch);
}

/** 等所有槽位都有了着落（成功或已跳过），我就替主人把成功的候选人送进候选池。
 * 不过主人若在重试间隙邀请了新成员导致重名，我会将冲突项标记失败，绝不擅自替换已入府的成员。
 * 最后我会呈上一份面向主人的中文结果摘要，成功的候选人会被妥善保留呢。 */
function applyCompletedRecruitment(state: AppState, batch: RecruitmentBatch): string {
  const successful = batch.slots.filter(slot => slot.status === "succeeded" && slot.candidate);
  const skipped = batch.slots.filter(slot => slot.status === "skipped").length;
  if (successful.length + skipped === batch.count && !batch.applied) {
    if (!successful.length) {
      batch.applied = true;
      return "本批次未通过的简历均已移除，寻访已结束；原有候选列表保留，没有再次调用模型。";
    }
    const hired = state.agents.filter(agent => agent.hired || agent.archivedAt);
    const hiredNames = new Map(hired.map(agent => [nameKey(agent.name), agent.name]));
    const conflicts = successful.filter(slot => hiredNames.has(nameKey(slot.candidate!.name)));
    if (conflicts.length) {
      // 主人有可能在重试间隙已经邀请了旧候选人入府，这道门由我替主人守着——已加入的成员绝不能被替换。
      for (const conflict of conflicts) failSlot(conflict, duplicateFailure(hiredNames.get(nameKey(conflict.candidate!.name))!));
      return `已保留${successful.length - conflicts.length}/${batch.count}份成功档案；${conflicts.length}项与新邀请成员重名，可单独重新生成。`;
    }
    state.agents = [...hired, ...successful.map(slot => slot.candidate!)];
    batch.applied = true;
  }
  if (batch.applied && !successful.length) return "本批次已结束，原有候选列表保留。";
  return batch.applied ? `${successful.length}份档案已通过检查并加入候选列表${skipped ? `，已移除${skipped}份失败简历` : ""}。` : `已保留${successful.length}/${batch.count}份成功档案${skipped ? `，已移除${skipped}份失败简历` : ""}；其余问题可单独重新生成，也可删除失败项后应用成功档案。`;
}

export async function startRecruitment(state: AppState, brief: string, count: unknown, dependencies: RecruitmentDependencies): Promise<string> {
  const amount = recruitmentCount(count);
  if (!brief.trim() || brief.length > 1800) throw new PalaceError("招募要求不能为空，且最多1800个字符。");
  const now = new Date((dependencies.now || Date.now)()).toISOString();
  const batch: RecruitmentBatch = { id: (dependencies.id || (() => crypto.randomUUID()))(), brief: brief.trim(), count: amount, createdAt: now, updatedAt: now, applied: false, slots: Array.from({ length: amount }, (_, index) => ({ slot: index + 1, status: "pending", attempts: 0, issues: [] })) };
  state.recruitment = batch;
  return generateSlots(state, batch, batch.slots, dependencies);
}

export async function retryRecruitment(state: AppState, batchId: string, slot: unknown, dependencies: RecruitmentDependencies): Promise<string> {
  const batch = state.recruitment;
  if (!batch || batch.id !== batchId) throw new PalaceError("这批招募已经过期，请刷新后选择当前批次。", 409, "RECRUITMENT_EXPIRED");
  if (slot !== undefined && (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > batch.count)) throw new PalaceError("重试序号不在本次招聘范围内。");
  const targets = batch.slots.filter(item => (item.status === "failed" || item.status === "pending") && (slot === undefined || item.slot === slot));
  if (!targets.length) return "所选档案已完成或已移除，没有再次调用模型。";
  return generateSlots(state, batch, targets, dependencies);
}

/** 请容我只收走未通过的简历；槽位编号和原始请求数量我会原样保留，好让批次的来龙去脉完完整整呢。 */
export function skipRecruitmentSlot(state: AppState, batchId: string, slot: unknown): string {
  const batch = state.recruitment;
  if (!batch || batch.id !== batchId) throw new PalaceError("这批招募已经过期，请刷新后选择当前批次。", 409, "RECRUITMENT_EXPIRED");
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > batch.count) throw new PalaceError("删除序号不在本次招聘范围内。");
  const item = batch.slots.find(candidate => candidate.slot === slot);
  if (!item) throw new PalaceError("找不到这份招聘简历。", 404, "RECRUITMENT_SLOT_MISSING");
  if (item.status === "skipped") return applyCompletedRecruitment(state, batch);
  if (item.status !== "failed") throw new PalaceError("只能删除未通过的简历；成功档案会继续保留。", 409, "RECRUITMENT_SLOT_NOT_FAILED");
  item.status = "skipped";
  delete item.candidate;
  delete item.errorCode;
  item.issues = [];
  batch.updatedAt = new Date().toISOString();
  return applyCompletedRecruitment(state, batch);
}
