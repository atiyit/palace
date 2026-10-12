import { z } from 'zod';
import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { createInitialState } from '@/lib/seeds';
import type { AppState, UserImage } from '@/lib/types';
import { MAX_PENDING_USER_IMAGES } from '@/lib/user-profile';
import { upgradeAppState } from '@/lib/character-profile';
import { hydrateConfig } from '@/lib/server/engine';
import { PalaceError, publicError } from '@/lib/server/errors';
import { mutateState } from '@/lib/server/store';
import { withProviderSettings } from '@/lib/server/provider-settings';
import { runPendingCleanup } from '@/lib/server/data-cleanup';
import { decodeUserImage, userImageRequestJson, MAX_USER_IMAGE_BASE64_CHARS } from '@/lib/server/user-profile';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const requestId = z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional();
const payloadSchema = z.union([
  z.object({ action: z.literal('upload').optional(), requestId, dataBase64: z.string().min(1).max(MAX_USER_IMAGE_BASE64_CHARS), contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']), name: z.string().trim().max(160).optional() }).strict(),
  z.object({ action: z.literal('remove'), requestId, imageId: z.string().uuid() }).strict(),
]);

export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: '请先登录。', code: 'UNAUTHORIZED' }, 401);
    const parsed = payloadSchema.safeParse(await userImageRequestJson(request));
    if (!parsed.success) throw new PalaceError('图片上传参数无效，请重新选择 PNG、JPEG 或 WebP 图片。', 400, 'USER_IMAGE_INVALID');
    const payload = parsed.data; const operationId = payload.requestId || crypto.randomUUID();
    let image: UserImage | undefined;
    let result = await mutateState<AppState>(user.userId, operationId, createInitialState, async state => {
      upgradeAppState(state);
      if (state.pendingCleanup?.length) throw new PalaceError('请先完成数据清理，再处理图片。', 409, 'CLEANUP_PENDING');
      state.userUploads ??= [];
      if (payload.action === 'remove') {
        const removed = state.userUploads.find(item => item.id === payload.imageId);
        if (!removed) throw new PalaceError('这张图片不在待发送列表中，已发送的图片不能在这里删除。', 404, 'USER_IMAGE_NOT_PENDING');
        state.userUploads = state.userUploads.filter(item => item.id !== payload.imageId);
        state.pendingCleanup = [{ id: crypto.randomUUID(), kind: 'member', imageIds: [`upload-${removed.id}`], createdAt: new Date().toISOString() }];
      } else {
        if (!env.BUCKET) throw new PalaceError('图片存储尚未配置。', 503, 'IMAGE_NOT_CONFIGURED');
        if (state.userUploads.length >= MAX_PENDING_USER_IMAGES) throw new PalaceError('最多保留20张待发送图片，请先发送或移除一张。', 409, 'USER_UPLOAD_LIMIT');
        const normalized = await decodeUserImage(payload.dataBase64, payload.contentType);
        const id = crypto.randomUUID();
        image = { id, url: `/api/portraits/upload-${id}`, contentType: normalized.contentType, ...(payload.name ? { name: payload.name } : {}), createdAt: new Date().toISOString(), requestId: operationId };
        await env.BUCKET.put(`portraits/${encodeURIComponent(user.userId)}/upload-${id}`, normalized.bytes, { httpMetadata: { contentType: normalized.contentType } });
        state.userUploads.push(image);
      }
      state.updatedAt = new Date().toISOString();
    });
    const replayed = result.replayed;
    if (replayed && payload.action !== 'remove') image = [...(result.state.userUploads || []), ...result.state.agents.flatMap(agent => agent.chats.flatMap(chat => chat.attachments || []))].find(item => item.requestId === operationId);
    let message = payload.action === 'remove' ? '待发送图片已移除。' : '图片已上传。点击发送后才会加入对话。';
    if (result.state.pendingCleanup?.length) {
      result = await mutateState<AppState>(user.userId, crypto.randomUUID(), createInitialState, async state => {
        const cleanup = await runPendingCleanup(user.userId, state, env); if (cleanup.message) message = cleanup.message;
      });
    }
    return await withProviderSettings(user.userId, async () => json({ image, state: hydrateConfig(upgradeAppState(result.state)), message, replayed }));
  } catch (error) { const safe = publicError(error); return json({ error: safe.message, code: safe.code }, safe.status); }
}
