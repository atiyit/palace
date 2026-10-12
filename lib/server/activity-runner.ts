export interface ActivityRequest { kind: 'task' | 'daily'; taskId?: string; topic?: string; steps: number; }
export interface ActivityStatus extends ActivityRequest {
  id: string; status: 'running' | 'pausing' | 'paused' | 'completed' | 'failed';
  done: number; startedAt: string; updatedAt: string; error?: string;
}
export interface ActivityDependencies {
  step: (request: ActivityRequest) => Promise<{ continuing: boolean; completedStep: boolean; stopped?: 'paused' }>;
  pause: (request: ActivityRequest, finish: boolean) => Promise<void>;
  error: (error: unknown) => string;
  delay?: (milliseconds: number) => Promise<void>;
  retryable?: (error: unknown) => boolean;
}

/** 主人点下开始后由本机服务值守；每步先保存，暂停只收住下一步，不把后台工作系在浏览器标签上呢。 */
export function createActivityRunner() {
  type Job = { value: ActivityStatus; stop: boolean; finish: boolean; completion: Promise<void>; deps: ActivityDependencies; request: ActivityRequest };
  const jobs = new Map<string, Job>();
  const delay = (deps: ActivityDependencies, milliseconds: number) => deps.delay?.(milliseconds) ?? new Promise<void>(resolve => setTimeout(resolve, milliseconds));
  const retryDelay = (attempt: number) => Math.min(500 * 2 ** Math.min(attempt - 1, 2), 2000);
  async function savePause(job: Job, finish: boolean) {
    for (let attempt = 0; ; attempt++) {
      try { await job.deps.pause(job.request, finish); return; }
      catch (error) {
        if (!job.deps.retryable?.(error) || attempt >= 30) throw error;
        await delay(job.deps, retryDelay(attempt + 1));
      }
    }
  }
  const snapshot = (owner: string): ActivityStatus | null => {
    const value = jobs.get(owner)?.value;
    return value ? { ...value } : null;
  };
  const active = (owner: string) => ['running', 'pausing'].includes(jobs.get(owner)?.value.status || '');
  function start(owner: string, request: ActivityRequest, deps: ActivityDependencies): ActivityStatus {
    if (active(owner)) throw new Error('已有后台交流在运行，请先暂停它。');
    const now = new Date().toISOString();
    request = { ...request };
    const value: ActivityStatus = { ...request, id: crypto.randomUUID(), status: 'running', done: 0, startedAt: now, updatedAt: now };
    const job: Job = { value, stop: false, finish: false, completion: Promise.resolve(), deps, request };
    jobs.set(owner, job);
    job.completion = Promise.resolve().then(async () => {
      try {
        let retries = 0;
        let stopped: 'paused' | undefined;
        while (!job.stop) {
          let step: Awaited<ReturnType<ActivityDependencies['step']>>;
          try { step = await deps.step(request); retries = 0; }
          catch (error) {
            if (job.stop) break;
            // 租约正在被别的请求使用时，我先稍候再敲门；真正的模型失败不会自动反复请求哦。
            if (!deps.retryable?.(error) || retries >= 30) throw error;
            await delay(deps, retryDelay(++retries));
            continue;
          }
          if (step.completedStep) job.value.done++;
          job.value.updatedAt = new Date().toISOString();
          if (!step.continuing || (request.kind === 'daily' && request.steps > 0 && job.value.done >= request.steps)) { stopped = step.stopped; break; }
          if (!job.stop) await delay(deps, 500);
        }
        if (job.stop) await savePause(job, job.finish);
        job.value.status = job.stop ? job.finish ? 'completed' : 'paused' : stopped || 'completed';
      } catch (error) {
        job.value.status = 'pausing';
        job.value.error = deps.error(error);
        try { await savePause(job, false); } catch { /* 主人，下次启动时我仍会从已保存的进度继续。 */ }
        job.value.status = 'failed';
      } finally { job.value.updatedAt = new Date().toISOString(); }
    });
    return { ...job.value };
  }
  function pause(owner: string, id: string, finish = false): ActivityStatus | null {
    const job = jobs.get(owner);
    if (!job || job.value.id !== id) throw new Error('后台交流已变化，请刷新后重试。');
    if (active(owner)) { job.stop = true; job.finish ||= finish; job.value.status = 'pausing'; }
    else if (finish && ['paused', 'failed'].includes(job.value.status)) {
      // 已暂停的共议也能正式结束，只收好已存成果，不会为此多请求一轮模型呢。
      job.finish = true; job.value.status = 'pausing';
      job.completion = Promise.resolve().then(async () => {
        try { await savePause(job, true); job.value.status = 'completed'; delete job.value.error; }
        catch (error) { job.value.status = 'failed'; job.value.error = job.deps.error(error); }
        finally { job.value.updatedAt = new Date().toISOString(); }
      });
    }
    return snapshot(owner);
  }
  const discard = (owner: string): boolean => !active(owner) && jobs.delete(owner);
  return { snapshot, active, start, pause, discard, settled: (owner: string) => jobs.get(owner)?.completion ?? Promise.resolve() };
}

const registryKey = Symbol.for('palace.local.activity-runner');
const registry = globalThis as typeof globalThis & { [registryKey]?: ReturnType<typeof createActivityRunner> };
export const activityRunner = registry[registryKey] ||= createActivityRunner();
