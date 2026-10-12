import { z } from 'zod';
import type { Agent, AppState, Task, TaskArtifact, ToolRun } from '../types.ts';
import { characterTimeFields } from '../character-time.ts';
import { contentValidationPolicy } from '../debug-validation.ts';
import { appointmentContext } from '../appointments.ts';
import { validateOutputFile, type OutputFile } from './code-interpreter.ts';
import { PalaceError } from './errors.ts';
import { configuredLimit } from '../memory-capacity.ts';
import { rememberGroup } from './task-group.ts';
import { artifactMime } from './artifact-mime.ts';
export { artifactMime } from './artifact-mime.ts';

const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('finish'), summary: z.string().trim().min(1).max(2400) }),
  z.object({ type: z.literal('tool'), tool: z.enum(['web.search','web.read','code.run','file.write']), input: z.object({ query: z.string().max(350).optional(), url: z.string().max(2500).optional(), code: z.string().max(30_000).optional(), name: z.string().max(100).optional(), content: z.string().max(250_000).optional() }).strict() }),
]);
export interface DeliveryDependencies {
  generate(system: string, input: unknown, maxTokens: number, timeoutMs: number): Promise<unknown>;
  prompt(id: string): string;
  search(query: string): Promise<unknown>;
  read(url: string): Promise<{ url: string; text: string }>;
  code(code: string, files: Record<string,string>): Promise<{ output: string; files: OutputFile[] }>;
  store(file: OutputFile, metadata: TaskArtifact): Promise<void>;
  load(artifact: TaskArtifact): Promise<string>;
}
export const DELIVERY_REQUEST_TOOL_LIMIT = 4;
export async function deliverTask(state: AppState, task: Task, deps: DeliveryDependencies, request = ''): Promise<string> {
  const members = state.agents.filter(agent => agent.hired && !agent.archivedAt && task.participants.includes(agent.id));
  if (!members.length) throw new PalaceError('任务没有在庭成员，无法生成交付物。', 400);
  if (task.groupTurn) throw new PalaceError('共议发言仍在进行，请先继续或结束该回合。', 409, 'GROUP_TURN_IN_PROGRESS');
  task.artifacts ??= []; task.toolRuns ??= [];
  const toolLimit = configuredLimit(state.settings.groupToolLimit), artifactLimit = configuredLimit(state.settings.groupArtifactLimit);
  const turn = Number.isSafeInteger(task.deliveryTurn) && task.deliveryTurn! >= 0 ? task.deliveryTurn! : 0;
  if (task.deliveryProgress && !members.some(member => member.id === task.deliveryProgress!.agentId)) delete task.deliveryProgress;
  if (!task.deliveryProgress) {
    task.deliveryProgress = { agentId: members[turn % members.length].id, eventId: crypto.randomUUID(), toolCalls: 0, correction: '', startedAt: new Date().toISOString() };
    task.deliveryTurn = turn + 1;
  }
  const progress = task.deliveryProgress;
  const author = members.find(member => member.id === progress.agentId)!;
  const immutableCore = { name: author.name, ...characterTimeFields(author), title: author.title, species: author.species, profile: author.profile, traits: author.traits, values: author.values, boundaries: author.boundaries, voice: author.voice, skills: author.skills };
  const context = {
    task: { id:task.id, title:task.title, request },
    members: members.map(agent => ({ id:agent.id, name:agent.name, skills:agent.skills, appointment:appointmentContext(agent) })),
    contributions: state.events.filter(event => event.taskId === task.id && event.checked && (event.round < task.round || !event.targetId || event.agentId === author.id || event.targetId === author.id)).slice(-20),
    immutableCore, strategy:author.strategy, validationPolicy:contentValidationPolicy(state),
  };
  const deadline = Date.now() + 270_000;
  const before = task.artifacts.length;
  let summary = '', requestTools = 0;
  for (let step = 0; step < 7 && Date.now() < deadline - 8000; step++) {
    if (requestTools >= DELIVERY_REQUEST_TOOL_LIMIT && (toolLimit === 0 || progress.toolCalls < toolLimit)) break;
    let command: z.infer<typeof commandSchema>;
    try {
      const raw = await deps.generate(deps.prompt('task.delivery'), { ...context, step:step + 1, maxToolCalls:toolLimit, remainingToolCalls: toolLimit === 0 ? null : Math.max(0, toolLimit - progress.toolCalls), maxArtifactVersions: artifactLimit, mustFinish:toolLimit > 0 && progress.toolCalls >= toolLimit, tools: ['web.search','web.read','code.run','file.write'], previousTools:task.toolRuns.slice(-12), files:task.artifacts.slice(-30), correction: progress.correction }, 5000, Math.min(45000, deadline - Date.now()));
      const parsed = commandSchema.safeParse(raw);
      if (!parsed.success) { progress.correction = '返回{type:"tool",tool,input}或{type:"finish",summary}，参数类型与工具名称必须符合协议。'; continue; }
      command = parsed.data;
    } catch { return `本次模型调用未完成，已保留${task.artifacts.length - before}个新文件及真实工具记录，可继续生成。`; }
    if (command.type === 'finish') {
      if (!task.artifacts.length && step < 6) { progress.correction = '还没有生成可下载的实际文件。请先调用file.write或code.run中的emitFile完成交付，不要只给承诺。'; continue; }
      if (!task.artifacts.length) { delete task.deliveryProgress; return '尚未产出文件，可继续生成；请在任务中明确所需文件及内容。'; }
      try {
        const verdict = await deps.generate(deps.prompt('task.delivery.review'), { ...context, candidate:command.summary, artifacts:task.artifacts.slice(-30), actualToolResults:task.toolRuns.slice(-12) }, 600, Math.min(20000, deadline-Date.now()));
        const parsed = z.object({ pass:z.boolean(),reason:z.string().max(800) }).safeParse(verdict);
        if (!parsed.success || !parsed.data.pass) { progress.correction = parsed.success ? parsed.data.reason : '交付说明审校格式无效。'; continue; }
        summary = command.summary; break;
      } catch { return '实际文件和工具记录已保存，交付说明审校未完成，可继续生成。'; }
    }
    if (toolLimit > 0 && progress.toolCalls >= toolLimit) { delete task.deliveryProgress; break; }
    if (requestTools >= DELIVERY_REQUEST_TOOL_LIMIT) break;
    progress.toolCalls++; requestTools++;
    const run: ToolRun = { id:crypto.randomUUID(),agentId:author.id,tool:command.tool,inputSummary:JSON.stringify(command.input).slice(0,12_000),status:'ok',createdAt:new Date().toISOString() };
    try {
      const input = command.input;
      let files: OutputFile[] = [];
      if (command.tool === 'web.search') run.output = JSON.stringify(await deps.search(input.query || '')).slice(0,10000);
      else if (command.tool === 'web.read') run.output = JSON.stringify(await deps.read(input.url || '')).slice(0,12000);
      else if (command.tool === 'file.write') { files = [validateOutputFile({ name:input.name || '',content:input.content ?? '' })]; run.output = '文件写入完成。'; }
      else {
        const inputs: Record<string,string> = {};
        for (const artifact of task.artifacts.slice(-5)) inputs[artifact.name] = await deps.load(artifact);
        const result = await deps.code(input.code || '',inputs); files = result.files; run.output = result.output.slice(0,12000);
      }
      run.artifactIds = [];
      for (const file of files) {
        validateOutputFile(file);
        if (artifactLimit > 0 && task.artifacts.length >= artifactLimit) throw new PalaceError(`此事务已达到主人设置的${artifactLimit}个成果版本上限。`);
        const id = crypto.randomUUID();
        const metadata: TaskArtifact = { id,name:file.name,mimeType:artifactMime(file.name),size:new TextEncoder().encode(file.content).length,url:`/api/artifacts/${id}`,createdAt:new Date().toISOString(),agentId:author.id,eventId:progress.eventId };
        await deps.store(file,metadata);
        task.artifacts.push(metadata); run.artifactIds.push(id);
      }
    } catch (error) { run.status = 'error'; run.error = (error instanceof Error ? error.message : '工具执行失败。').slice(0,600); }
    task.toolRuns.push(run); progress.correction = ''; rememberGroup(state, task, new Date().toISOString());
  }
  if (summary) {
    state.events.push({ id:progress.eventId,taskId:task.id,round:task.round,agentId:author.id,kind:'submit',content:summary,createdAt:new Date().toISOString(),checked:true,
      artifactIds: task.artifacts.filter(artifact => artifact.eventId === progress.eventId).map(artifact => artifact.id) });
    delete task.deliveryProgress;
    rememberGroup(state, task, new Date().toISOString());
  }
  return task.artifacts.length > before ? `已生成${task.artifacts.length-before}个可下载文件。${summary ? '交付说明已通过审校。' : '本次分步执行已保存，可继续生成。'}` : summary ? '已根据现有文件完成交付说明。' : '本次执行记录已保存，尚未新增文件，可以继续生成。';
}
