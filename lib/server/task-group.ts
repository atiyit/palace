import { personalMemoryCount } from '../memory-capacity.ts';
import { z } from 'zod';
import type { Agent, AppState, Memory, SocialEvent, Task, TaskArtifact, ToolRun } from '../types.ts';
import { acceptedRelationship } from '../domain.ts';
import { characterTimeFields } from '../character-time.ts';
import { contentValidationPolicy } from '../debug-validation.ts';
import { appointmentContext } from '../appointments.ts';
import { ownContext } from './guardrails.ts';
import { validateOutputFile, type OutputFile } from './code-interpreter.ts';
import { artifactMime, type DeliveryDependencies } from './task-delivery.ts';
import { PalaceError } from './errors.ts';
import { PreviewHalt } from './provider-trace.ts';
import { userProfileContext } from '../user-profile.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const finishSchema = z.object({
  type: z.literal('finish'), kind: z.enum(['propose', 'request', 'accept', 'refuse', 'challenge', 'help', 'submit']),
  content: text(4000), targetId: text(180).nullable().optional(), replyTo: text(180).nullable().optional(),
  memories: z.array(z.object({ kind: z.enum(['preference', 'experience', 'relationship']), content: text(600), source: text(180) }).strict()).max(2).default([]),
  revisedStrategy: text(500).nullable().optional(),
}).strict();
export const groupCommandSchema = z.discriminatedUnion('type', [finishSchema,
  z.object({ type: z.literal('tool'), tool: z.enum(['web.search', 'web.read', 'code.run', 'file.write', 'image.generate']), input: z.object({
    query: text(350).optional(), url: text(2500).optional(), code: text(30_000).optional(), name: text(100).optional(),
    content: z.string().max(250_000).optional(), prompt: text(1200).optional(), referenceAgentId: text(180).optional(),
    baseArtifactIds: z.array(text(180)).max(5).optional(),
  }).strict() }).strict(),
]);
const verdictSchema = z.object({ pass: z.boolean(), reason: z.string().max(800) });
type Finish = z.infer<typeof finishSchema>;
type ToolCommand = Extract<z.infer<typeof groupCommandSchema>, { type: 'tool' }>;
export interface GroupImage { bytes: Uint8Array; contentType: string; }
export interface GroupDependencies extends DeliveryDependencies {
  image?(prompt: string, referenceAgentId?: string): Promise<GroupImage>;
  storeImage?(image: GroupImage, metadata: TaskArtifact): Promise<void>;
}
export const GROUP_TOOL_LIMIT = 4;
export const GROUP_DEADLINE_MS = 210_000;
const presentMembers = (state: AppState, task: Task) => state.agents.filter(agent => agent.hired && !agent.archivedAt && task.participants.includes(agent.id));
const groupHistory = (state: AppState, task: Task) => state.events.filter(event => event.taskId === task.id && event.checked);
const isBinaryImage = (artifact: TaskArtifact) => artifact.kind === 'image' || (!artifact.kind && /^image\/(?:png|jpeg|webp|gif)$/i.test(artifact.mimeType));

/** 主人，本任务中所有通过审校的消息都是公开的，包括当前轮次中的定向消息。 */
/** 主人，为共议任务组装模型上下文，包括成员列表、最近 30 条已审校消息、待处理请求和成果。
 * 如果角色有本任务的服务端摘要记忆，会追加到长期记忆末尾（最多 14 条）。
 * 图片类型的成果标记 visuallyObserved: false；当前群聊仅提供图片元数据，不发送像素。 */
export function taskGroupContext(state: AppState, task: Task, author: Agent, currentSourceId: string) {
  const members = presentMembers(state, task);
  const history = groupHistory(state, task);
  const context = ownContext(author, task.title);
  const summary = author.memories.find(memory => memory.source === `task-group:${task.id}`);
  if (summary && !context.longTermMemories.some(memory => memory.id === summary.id)) context.longTermMemories = [...context.longTermMemories.slice(0, 13), summary];
  return {
    mode: 'task-group', currentSourceId, task: { id: task.id, title: task.title, round: task.round, rounds: task.rounds },
    ...context, userProfile: userProfileContext(state),
    immutableCore: { id: author.id, name: author.name, ...characterTimeFields(author), title: author.title, bio: author.bio,
      appearance: author.appearance, species: author.species, profile: author.profile, traits: author.traits, values: author.values,
      boundaries: author.boundaries, voice: author.voice, approach: author.approach, skills: author.skills },
    members: members.map(member => ({ id: member.id, name: member.name, ...characterTimeFields(member), title: member.title,
      appearance: member.appearance, species: member.species, traits: member.traits, boundaries: member.boundaries, skills: member.skills, appointment: appointmentContext(member) })),
    messages: history.slice(-30).map(event => ({ ...event, sourceId: event.id })),
    pendingRequests: history.filter(event => event.kind === 'request' && event.targetId === author.id && members.some(member => member.id === event.agentId)
      && !history.some(reply => reply.replyTo === event.id && reply.agentId === author.id && ['accept', 'refuse'].includes(reply.kind))).slice(-12),
    artifacts: (task.artifacts || []).map(artifact => ({ ...artifact, sourceId: artifact.id, ...(artifact.kind === 'image' ? { visuallyObserved: false } : {}) })),
    cooperation: state.relationships.filter(relation => relation.taskId === task.id),
    validationPolicy: contentValidationPolicy(state), drama: state.settings.drama,
  };
}

/** 主人，服务端生成的摘要是保留记忆：每个任务一条，即使 100 条普通槽位已满也不受影响。 */
/** 主人，为任务中所有在庭成员更新或创建共议摘要记忆（每任务一条，source 以 task-group: 开头）。
 * 摘要包含最近 3 条消息、最近 3 个成果文件名和最近 2 条合作关系，截断到 600 字符。
 * 已有摘要会就地更新内容和时间戳，不额外占用普通记忆槽位。 */
function rememberGroup(state: AppState, task: Task, timestamp: string) {
  const name = (id: string) => state.agents.find(agent => agent.id === id)?.name || '已离开的成员';
  const lines = groupHistory(state, task).slice(-3).map(event => {
    const sender = event.actorType === 'user' ? '用户' : event.actorType === 'system' ? '系统' : name(event.agentId);
    return `${sender}${event.targetId ? `对${name(event.targetId)}` : ''}：${event.content.slice(0, 85)}`;
  });
  const files = (task.artifacts || []).slice(-3).map(artifact => `${artifact.name.slice(0, 45)}（${[...new Set([artifact.agentId, ...(artifact.contributorIds || [])])].map(name).join('、').slice(0, 60)}）`);
  const cooperation = state.relationships.filter(relation => relation.taskId === task.id).slice(-2).map(relation => `${name(relation.from)}与${name(relation.to)}已接受合作`);
  const content = [`共议「${task.title.slice(0, 60)}」`, files.length ? `实际成果：${files.join('；')}` : '', ...cooperation, ...lines].filter(Boolean).join('；').slice(0, 600);
  for (const member of presentMembers(state, task)) {
    const source = `task-group:${task.id}`;
    const existing = member.memories.find(memory => memory.source === source);
    if (existing) { existing.kind = 'experience'; existing.content = content; existing.updatedAt = timestamp; }
    else member.memories.push({ id: crypto.randomUUID(), kind: 'experience', source, content, createdAt: timestamp });
  }
}

export function appendGroupUserMessage(state: AppState, task: Task, content: string): SocialEvent {
  const parsed = text(4000).safeParse(content);
  if (!parsed.success) throw new PalaceError('群消息需为1至4000个字符。', 400, 'INVALID_GROUP_MESSAGE');
  const event: SocialEvent = { id: crypto.randomUUID(), taskId: task.id, round: task.round, agentId: 'user', actorType: 'user', kind: 'propose', content: parsed.data, createdAt: new Date().toISOString(), checked: true };
  state.events.push(event); rememberGroup(state, task, event.createdAt); state.updatedAt = event.createdAt;
  return event;
}

async function sharedFiles(task: Task, deps: GroupDependencies) {
  const files: { id: string; name: string; content?: string; error?: string }[] = [];
  let available = 12_000;
  for (const artifact of (task.artifacts || []).filter(item => !isBinaryImage(item)).slice(-5).reverse()) {
    if (available <= 0) break;
    try { const content = (await deps.load(artifact)).slice(0, available); available -= content.length; files.push({ id: artifact.id, name: artifact.name, content }); }
    catch { files.push({ id: artifact.id, name: artifact.name, error: '文件暂时无法读取；不能声称读过文件内容。' }); }
  }
  return files.reverse();
}

function validatedFinish(action: Finish, state: AppState, task: Task, author: Agent, context: ReturnType<typeof taskGroupContext>): Finish {
  const invalid = (message: string): never => { throw new PalaceError(message, 502, 'INVALID_GROUP_ACTION'); };
  const result = { ...action };
  const members = new Set(context.members.map(member => member.id));
  if (result.targetId && (!members.has(result.targetId) || result.targetId === author.id)) invalid('交流对象必须是本群当前在庭的另一位成员。');
  if (result.kind === 'accept' || result.kind === 'refuse') {
    const request = context.pendingRequests.find(event => event.id === result.replyTo);
    if (!request || (result.targetId && result.targetId !== request.agentId)) invalid('只能接受或拒绝本人收到的、尚未处理的明确请求，不能替别人接受。');
    result.targetId = request!.agentId;
  } else {
    if (['request', 'help'].includes(result.kind) && !result.targetId) invalid('合作请求或定向帮助需要明确接收者。');
    if (result.replyTo && !context.messages.some(event => event.id === result.replyTo)) invalid('回复只能引用当前可见的真实群消息。');
  }
  const sources = new Set([context.currentSourceId, ...context.messages.map(event => event.id), ...context.pendingRequests.map(event => event.id),
    ...context.longTermMemories.map(memory => memory.source), ...context.shortTermChats.map(chat => chat.sourceId),
    ...(task.artifacts || []).map(artifact => artifact.id), ...(task.toolRuns || []).map(run => run.id)]);
  if (context.userProfile) sources.add(context.userProfile.source);
  if (result.memories.some(memory => !sources.has(memory.source))) invalid('记忆只能引用本人已见消息、已有本人记忆、当前群发言或真实工具及成果来源。');
  return result;
}

function learn(author: Agent, action: Finish, event: SocialEvent) {
  const append = (memory: Omit<Memory, 'id' | 'createdAt'>) => {
    if (personalMemoryCount(author) >= 100 || author.memories.some(existing => existing.kind === memory.kind && existing.content === memory.content)) return;
    author.memories.push({ ...memory, id: crypto.randomUUID(), createdAt: event.createdAt });
  };
  for (const memory of action.memories) append(memory);
  if (action.revisedStrategy && action.revisedStrategy !== author.strategy) {
    author.strategy = action.revisedStrategy; append({ kind: 'strategy', content: action.revisedStrategy, source: event.id });
  }
}

function safeToolError(error: unknown): string {
  // 主人，服务商错误可能包含 URL 或凭证；只有经过验证的本地错误才会原样暴露。
  if (error instanceof PalaceError) return error.message.slice(0, 600);
  return '工具执行失败，本次未确认成功；已保留此前真实完成的成果，可继续尝试。';
}
function invalidTool(message: string): never { throw new PalaceError(message, 400, 'INVALID_GROUP_TOOL'); }

/** 主人，即使图片服务不接受显式超时参数也会被限时；超时后的结果不会被存储。 */
async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PalaceError('本轮执行时间已用完，未完成的工具结果不会作为成果发布。', 504)), Math.max(1, deadline - Date.now())); })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function executeTool(state: AppState, task: Task, author: Agent, command: ToolCommand, deps: GroupDependencies, context: ReturnType<typeof taskGroupContext>, eventId: string, deadline: number, imageAllowed: boolean) {
  const run: ToolRun = { id: crypto.randomUUID(), agentId: author.id, tool: command.tool, inputSummary: JSON.stringify(command.input).slice(0, 12_000), status: 'ok', createdAt: new Date().toISOString(), artifactIds: [] };
  try {
    const input = command.input;
    const bases = [...new Set(input.baseArtifactIds || [])].map(id => {
      const artifact = task.artifacts!.find(item => item.id === id);
      if (!artifact) invalidTool('baseArtifactIds 只能引用本事务已有成果，不能引用其他事务或虚构文件。');
      return artifact;
    });
    const contributors = [...new Set([author.id, ...bases.flatMap(artifact => [artifact.agentId, ...(artifact.contributorIds || [])])])];
    const metadata = (name: string, mimeType: string, size: number, kind: 'file' | 'image'): TaskArtifact => {
      if (task.artifacts!.length >= 30) invalidTool('此事务已达到30个成果版本，请新建事务继续。');
      const id = crypto.randomUUID();
      return { id, name, mimeType, size, kind, url: `/api/artifacts/${id}`, createdAt: new Date().toISOString(), agentId: author.id, contributorIds: contributors, derivedFromIds: bases.map(base => base.id), eventId };
    };
    let files: OutputFile[] = [];
    if (command.tool === 'web.search') {
      if (!input.query) invalidTool('web.search 需要 query。');
      run.output = JSON.stringify(await beforeDeadline(deps.search(input.query), deadline)).slice(0, 10_000);
    } else if (command.tool === 'web.read') {
      if (!input.url) invalidTool('web.read 需要 url。');
      run.output = JSON.stringify(await beforeDeadline(deps.read(input.url), deadline)).slice(0, 12_000);
    } else if (command.tool === 'file.write') {
      if (!input.name || input.content === undefined) invalidTool('file.write 需要 name 和 content。');
      try { files = [validateOutputFile({ name: input.name, content: input.content })]; }
      catch { invalidTool('文件名或内容不合格；请使用支持的纯文本扩展名、单个文件名，内容不超过250KB。'); }
      run.output = '已保存新的文件版本；旧版本保留。';
    } else if (command.tool === 'code.run') {
      if (!input.code) invalidTool('code.run 需要 code。');
      const inputs: Record<string, string> = {};
      for (const artifact of bases) {
        if (isBinaryImage(artifact)) invalidTool('代码解释器只能读取文本成果。');
        if (Object.hasOwn(inputs, artifact.name)) invalidTool('引用的文件名称重复，请只选择该文件的一个版本。');
        inputs[artifact.name] = await beforeDeadline(deps.load(artifact), deadline);
      }
      const result = await beforeDeadline(deps.code(input.code, inputs), deadline);
      if (result.files.length > 5) invalidTool('一次代码运行最多生成5个文件。');
      files = result.files; run.output = result.output.slice(0, 12_000);
    } else {
      if (!imageAllowed) invalidTool('每位成员每回合最多尝试生成一张图片。');
      if (!deps.image || !deps.storeImage) invalidTool('本地生图服务尚未配置，本轮可以继续提供文字或文件。');
      if (!input.prompt) invalidTool('image.generate 需要 prompt。');
      if (input.referenceAgentId && !context.members.some(member => member.id === input.referenceAgentId)) invalidTool('参考角色只能是本群当前在庭成员。');
      const verdict = verdictSchema.safeParse(await deps.generate(deps.prompt('task.group.review'), {
        context, candidate: command, purpose: '在付费生图前核验图片指令是否符合任务、角色人设及参考对象；不能改变参考角色的物种与身份，不能声称已经看过未提供的图片像素，不替任何其他成员表态。',
        validationPolicy: contentValidationPolicy(state),
      }, 650, Math.max(1, Math.min(20_000, deadline - Date.now()))));
      if (!verdict.success || !verdict.data.pass) invalidTool(verdict.success ? `图片指令未通过审校：${verdict.data.reason}` : '图片审校格式无效，未调用生图服务。');
      if (Date.now() >= deadline - 1000) invalidTool('本轮剩余时间不足以执行生图。');
      const result = await beforeDeadline(deps.image(input.prompt, input.referenceAgentId), deadline);
      const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[result.contentType];
      if (!extension || !(result.bytes instanceof Uint8Array) || !result.bytes.length || result.bytes.length > 15_000_000) invalidTool('图片服务未返回有效的 PNG、JPEG 或 WebP 图片。');
      const artifact = metadata(`image-${crypto.randomUUID().slice(0, 8)}.${extension}`, result.contentType, result.bytes.length, 'image');
      await deps.storeImage(result, artifact); task.artifacts!.push(artifact); run.artifactIds!.push(artifact.id);
      run.output = '图片已实际生成并保存，可在群聊中查看。';
    }
    for (const file of files) {
      validateOutputFile(file);
      const artifact = metadata(file.name, artifactMime(file.name), new TextEncoder().encode(file.content).length, 'file');
      await deps.store(file, artifact); task.artifacts!.push(artifact); run.artifactIds!.push(artifact.id);
    }
  } catch (error) { if (error instanceof PreviewHalt) throw error; run.status = 'error'; run.error = safeToolError(error); delete run.output; }
  task.toolRuns!.push(run); task.toolRuns = task.toolRuns!.slice(-60);
}

/** 主人，每次只有一位成员可以发言、使用有限的工具或协作。调度由调用方负责。 */
export async function runGroupTurn(state: AppState, task: Task, author: Agent, deps: GroupDependencies): Promise<string | undefined> {
  if (!presentMembers(state, task).some(member => member.id === author.id)) throw new PalaceError('发言成员必须是本群当前在庭成员。', 400, 'GROUP_REQUIRES_MEMBER');
  task.artifacts ??= []; task.toolRuns ??= [];
  const eventId = crypto.randomUUID(), deadline = Date.now() + GROUP_DEADLINE_MS;
  const before = new Set(task.artifacts.map(artifact => artifact.id));
  let correction = '', corrected = false, tools = 0, imageAttempted = false, accepted: Finish | undefined;
  let failure = '本轮已达到工具或时间上限，尚未发布成员发言。';
  for (let attempt = 0; attempt < GROUP_TOOL_LIMIT + 2 && Date.now() < deadline - 1000; attempt++) {
    const context = taskGroupContext(state, task, author, eventId);
    try {
      const fileContents = await beforeDeadline(sharedFiles(task, deps), deadline);
      const input = { ...context, fileContents, tools: ['web.search', 'web.read', 'code.run', 'file.write', ...(deps.image && deps.storeImage ? ['image.generate'] : [])],
        imageGenerationAvailable: !!(deps.image && deps.storeImage), maxToolCalls: GROUP_TOOL_LIMIT, remainingToolCalls: GROUP_TOOL_LIMIT - tools,
        mustFinish: tools >= GROUP_TOOL_LIMIT, imageAlreadyAttempted: imageAttempted,
        imagePolicy: imageAttempted ? '本回合已经尝试过生图，禁止再次调用 image.generate；请继续文字、文件或直接 finish。' : '最多尝试一张图片，prompt 最多1200字符，人物图片应指定 referenceAgentId。',
        previousTools: task.toolRuns.slice(-12), correction };
      const parsed = groupCommandSchema.safeParse(await deps.generate(deps.prompt('task.group'), input, 5500, Math.max(1, Math.min(42_000, deadline - Date.now()))));
      if (!parsed.success) {
        if (corrected) { failure = '本轮发言两次未通过结构检查，已暂缓发布。'; break; }
        corrected = true; correction = `JSON结构不合格：${parsed.error.issues.slice(0, 4).map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；')}`; continue;
      }
      const command = parsed.data;
      if (command.type === 'tool') {
        if (tools >= GROUP_TOOL_LIMIT) { failure = '本轮工具预算已用完，未执行额外工具或发布未经审校的发言。'; break; }
        tools++;
        const imageAllowed = !imageAttempted;
        if (command.tool === 'image.generate') imageAttempted = true;
        await executeTool(state, task, author, command, deps, context, eventId, deadline, imageAllowed);
        correction = ''; continue;
      }
      let candidate: Finish;
      try { candidate = validatedFinish(command, state, task, author, context); }
      catch (error) {
        if (corrected) { failure = '本轮发言仍未通过权限或记忆来源检查，已暂缓发布。'; break; }
        corrected = true; correction = error instanceof PalaceError ? error.message : '发言协议不合格。'; continue;
      }
      const verdict = verdictSchema.safeParse(await deps.generate(deps.prompt('task.group.review'), {
        context, fileContents, candidate, actualToolResults: task.toolRuns.slice(-12), artifacts: task.artifacts,
        purpose: '核验群发言、记忆及策略与人设、群聊事实及实际成果相符；文字回复也可以完整完成任务。', validationPolicy: contentValidationPolicy(state),
      }, 700, Math.max(1, Math.min(24_000, deadline - Date.now()))));
      if (verdict.success && verdict.data.pass) { accepted = candidate; break; }
      failure = '本轮发言未通过独立审校，已暂缓发布。';
      if (corrected) break;
      corrected = true; correction = verdict.success ? verdict.data.reason : '审校结论需要 pass 布尔值和 reason 字符串。';
    } catch (error) { if (error instanceof PreviewHalt) throw error; failure = '本轮模型或审校调用未完成，已保留真实工具记录和已生成成果。'; break; }
  }
  const artifactIds = task.artifacts.filter(artifact => !before.has(artifact.id)).map(artifact => artifact.id);
  const createdAt = new Date().toISOString();
  if (accepted) {
    const event: SocialEvent = { id: eventId, taskId: task.id, round: task.round, agentId: author.id, actorType: 'agent', kind: accepted.kind,
      ...(accepted.targetId ? { targetId: accepted.targetId } : {}), ...(accepted.replyTo ? { replyTo: accepted.replyTo } : {}), content: accepted.content, checked: true, createdAt, artifactIds };
    state.events.push(event);
    const relationship = acceptedRelationship(event, state.events);
    if (relationship && !state.relationships.some(existing => existing.taskId === task.id && existing.from === relationship.from && existing.to === relationship.to && existing.kind === 'cooperation')) state.relationships.push({ ...relationship, kind: 'cooperation' });
    learn(author, accepted, event); rememberGroup(state, task, createdAt); state.updatedAt = createdAt;
    return undefined;
  }
  state.events.push({ id: eventId, taskId: task.id, round: task.round, agentId: 'system', actorType: 'system', kind: 'submit', checked: true, createdAt, artifactIds,
    content: `${artifactIds.length ? `系统已保存${author.name}本轮实际生成的${artifactIds.length}项成果。` : `${author.name}本轮未发布新发言，也未新增成果。`}${failure}此消息仅报告执行状态，未代替成员发言。` });
  rememberGroup(state, task, createdAt);
  state.updatedAt = createdAt;
  return failure;
}
