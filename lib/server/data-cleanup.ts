import type { AppState } from '../types.ts';
import { referencedImageIds } from '../member-lifecycle.ts';
import { PalaceError } from './errors.ts';
import { providerSettingsRepository } from './provider-settings-repository.ts';

export type CleanupEnvironment = Cloudflare.Env & { CLEAR_LOCAL_DEFAULTS?: () => Promise<void> };

async function removeObjects(bucket: R2Bucket, prefix: string, keep = new Set<string>()): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    const keys = page.objects.map(object => object.key).filter(key => key.startsWith(prefix) && !keep.has(key.slice(prefix.length)));
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** 主人，请在领域变更提交并持有新状态租约后再执行。
 * 失败的任务会保留在队列中可重试；删除操作本身是幂等的。 */
export async function runPendingCleanup(userId: string, state: AppState, env: CleanupEnvironment): Promise<{ completed: number; pending: number; message?: string }> {
  let completed = 0;
  const prefix = `portraits/${encodeURIComponent(userId)}/`;
  for (const job of [...(state.pendingCleanup || [])]) {
    try {
      if (job.kind === 'all') {
        if (!env.DB) throw new PalaceError('数据库尚未配置。', 503, 'DATABASE_NOT_READY');
        const repository = providerSettingsRepository(env.DB);
        await repository.remove(userId, 'text');
        await repository.remove(userId, 'image');
        if (env.CLEAR_LOCAL_DEFAULTS) await env.CLEAR_LOCAL_DEFAULTS();
        if (env.BUCKET) {
          await removeObjects(env.BUCKET, prefix);
          await removeObjects(env.BUCKET, `artifacts/${encodeURIComponent(userId)}/`);
        }
      } else if (env.BUCKET) {
        const keep = referencedImageIds(state);
        const keys = job.imageIds.filter(id => /^[a-zA-Z0-9_-]{1,100}$/.test(id) && !keep.has(id)).map(id => prefix + id);
        if (keys.length) await env.BUCKET.delete(keys);
        // 主人，也会清理因历史记录裁剪而失去引用的聊天图片；保留在庭和归档角色仍引用的图片。
        await removeObjects(env.BUCKET, prefix, keep);
      }
      state.pendingCleanup = (state.pendingCleanup || []).filter(item => item.id !== job.id);
      completed++;
    } catch {
      return { completed, pending: state.pendingCleanup?.length || 0, message: '记录已删除；部分图片、文件或 API 配置尚未清理完成，请在数据管理中重试清理。' };
    }
  }
  return { completed, pending: state.pendingCleanup?.length || 0 };
}
