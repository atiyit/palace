import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { createInitialState } from '@/lib/seeds';
import { upgradeAppState } from '@/lib/character-profile';
import type { AppState } from '@/lib/types';
import { mutateState, readState } from '@/lib/server/store';
import { performAction } from '@/lib/server/engine';
import { withProviderSettings } from '@/lib/server/provider-settings';
import { requireProvider } from '@/lib/server/provider';
import { PalaceError, publicError } from '@/lib/server/errors';
import { activityRunner, type ActivityRequest } from '@/lib/server/activity-runner';

export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } });
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start'), kind: z.enum(['task','daily']), taskId: z.string().trim().min(1).max(100).optional(), topic: z.string().max(1000).optional(), steps: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict(),
  z.object({ action: z.enum(['pause','stop']), id: z.string().uuid() }).strict(),
]);
export async function GET() {
  try {
    const user = await getChatGPTUser();
    if (!user) throw new PalaceError('请先登录。', 401, 'UNAUTHORIZED');
    const activity = activityRunner.snapshot(user.userId);
    if (activity?.kind === 'task') {
      const state = await readState<AppState>(user.userId, createInitialState);
      if (!state.tasks.some(task => task.id === activity.taskId)) { activityRunner.discard(user.userId); return json({ activity: null }); }
    }
    return json({ activity });
  } catch (error) { const safe=publicError(error); return json({ error:safe.message,code:safe.code },safe.status); }
}
export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) throw new PalaceError('请先登录。',401,'UNAUTHORIZED');
    if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new PalaceError('请求来源不匹配。',403,'ORIGIN_MISMATCH');
    if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new PalaceError('请求需要JSON格式。',415);
    if (Number(request.headers.get('content-length') || 0) > 8000) throw new PalaceError('请求过长。',413);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 8000) throw new PalaceError('请求过长。',413);
    let body: unknown; try { body=JSON.parse(raw); } catch { throw new PalaceError('JSON格式无效。'); }
    const parsed=schema.safeParse(body); if (!parsed.success) throw new PalaceError('后台交流参数无效。');
    const payload=parsed.data, owner=user.userId;
    if (payload.action !== 'start') {
      try { return json({ activity:activityRunner.pause(owner,payload.id,payload.action==='stop') }); }
      catch { throw new PalaceError('后台交流已变化，请刷新后重试。',409); }
    }
    if (activityRunner.active(owner)) throw new PalaceError('已有后台交流在运行，请先暂停。',409,'BUSY');
    const current=upgradeAppState(await readState<AppState>(owner,createInitialState));
    if (current.pendingCleanup?.length) throw new PalaceError('请先完成存档清理。',409);
    await withProviderSettings(owner,async()=>requireProvider());
    if (payload.kind==='task' && !current.tasks.some(t=>t.id===payload.taskId && t.status!=='completed')) throw new PalaceError('请先创建共议或增加新的交流轮次。',409);
    if (payload.kind==='daily' && !current.agents.some(a=>a.hired&&!a.archivedAt)) throw new PalaceError('请先邀请至少一位成员。',409);
    let initialStep = true;
    const mutate = async (job: ActivityRequest, pause=false, finish=false) => {
      let continuing=false, completedStep=false, stepError='', stopped: 'paused' | undefined;
      await mutateState<AppState>(owner,crypto.randomUUID(),createInitialState,async state=> {
        upgradeAppState(state);
        if (state.pendingCleanup?.length) throw new PalaceError('请先完成存档清理。',409,'CLEANUP_PENDING');
        await withProviderSettings(owner,async()=> {
          if (pause) {
            if (job.kind==='task' && state.tasks.some(t=>t.id===job.taskId)) await performAction(state,{action:finish?'task.finish':'task.pause',taskId:job.taskId},owner);
            return;
          }
          if (job.kind==='task') {
            const task=state.tasks.find(t=>t.id===job.taskId);
            if (!task || task.status==='completed') return;
            if (task.status==='paused') {
              if (!initialStep) { stopped = 'paused'; return; }
              await performAction(state,{action:'task.resume',taskId:job.taskId},owner);
            }
            const result=await performAction(state,{action:'task.step',taskId:job.taskId},owner);
            stepError=result.message || task.lastError || '';
            continuing=task.status==='running'; completedStep=!task.groupTurn && !stepError;
          } else {
            const result=await performAction(state,{action:'daily.step',message:job.topic||''},owner);
            stepError=result.message || '';
            continuing=!stepError; completedStep=!stepError;
          }
        });
      });
      if (!pause) initialStep = false;
      // 我先存妥真实成果与失败说明，再暂停调度；把异常抛在事务外，才不会弄丢主人的记录呀。
      if (stepError) throw new PalaceError(stepError,502,'ACTIVITY_STEP_FAILED');
      return { continuing,completedStep, ...(stopped ? { stopped } : {}) };
    };
    if (activityRunner.active(owner)) throw new PalaceError('已有后台交流在运行，请先暂停。',409,'BUSY');
    const jobRequest: ActivityRequest = { kind: payload.kind, steps: payload.steps, ...(payload.taskId ? { taskId: payload.taskId } : {}), ...(payload.topic !== undefined ? { topic: payload.topic } : {}) };
    return json({ activity:activityRunner.start(owner,jobRequest,{
      step:job=>mutate(job), pause:async(job,finish)=>{await mutate(job,true,finish);}, error:error=>publicError(error).message,
      retryable:error=>error instanceof PalaceError && error.code==='BUSY',
    }) });
  } catch (error) { const safe=publicError(error); return json({error:safe.message,code:safe.code},safe.status); }
}
