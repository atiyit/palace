import { z } from 'zod';
import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { createInitialState } from '@/lib/seeds';
import type { AppState } from '@/lib/types';
import { USER_PROFILE_LIMITS } from '@/lib/user-profile';
import { upgradeAppState } from '@/lib/character-profile';
import { hydrateConfig } from '@/lib/server/engine';
import { PalaceError, publicError } from '@/lib/server/errors';
import { mutateState, readState } from '@/lib/server/store';
import { withProviderSettings, getEffectiveProvider } from '@/lib/server/provider-settings';
import { completeJson, generatePortrait } from '@/lib/server/provider';
import { runPendingCleanup } from '@/lib/server/data-cleanup';
import { clearUserProfile, createUserProfileDraft, decodeUserImage, normalizeUserImage, removeUserAvatar, saveUserProfile, setUserAvatar, userAvatarPrompt, userImageRequestJson, MAX_USER_IMAGE_BASE64_CHARS } from '@/lib/server/user-profile';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const requestId = z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional();
const payloadSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), requestId, name: z.string().max(USER_PROFILE_LIMITS.name), description: z.string().max(USER_PROFILE_LIMITS.description), preferences: z.string().max(USER_PROFILE_LIMITS.preferences).optional() }).strict(),
  z.object({ action: z.literal('clear'), requestId }).strict(),
  z.object({ action: z.literal('draft'), requestId, brief: z.string().trim().min(1).max(USER_PROFILE_LIMITS.brief) }).strict(),
  z.object({ action: z.literal('avatar.generate'), requestId, prompt: z.string().max(USER_PROFILE_LIMITS.avatarPrompt).optional() }).strict(),
  z.object({ action: z.literal('avatar.upload'), requestId, dataBase64: z.string().min(1).max(MAX_USER_IMAGE_BASE64_CHARS), contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']) }).strict(),
  z.object({ action: z.literal('avatar.remove'), requestId }).strict(),
]);

export async function GET() {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: '请先登录。', code: 'UNAUTHORIZED' }, 401);
    const state = await readState<AppState>(user.userId, createInitialState);
    return json({ profile: state.userProfile || null });
  } catch (error) { const safe = publicError(error); return json({ error: safe.message, code: safe.code }, safe.status); }
}

export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: '请先登录。', code: 'UNAUTHORIZED' }, 401);
    const parsed = payloadSchema.safeParse(await userImageRequestJson(request));
    if (!parsed.success) throw new PalaceError('资料操作参数不完整或超过长度限制，请检查后重试。', 400, 'USER_PROFILE_INVALID');
    const payload = parsed.data;
    return await withProviderSettings(user.userId, async () => {
      if (payload.action === 'draft') {
        const state = await readState<AppState>(user.userId, createInitialState);
        if (state.pendingCleanup?.length) throw new PalaceError('请先完成数据清理，再生成资料。', 409, 'CLEANUP_PENDING');
        const draft = await createUserProfileDraft(state, payload.brief, async (...args) => (await completeJson(...args)).value);
        return json({ draft, message: '已生成可编辑草稿。确认内容并点击保存后，成员才会使用这份资料。' });
      }
      let message = '';
      let result = await mutateState<AppState>(user.userId, payload.requestId || crypto.randomUUID(), createInitialState, async state => {
        upgradeAppState(state);
        if (state.pendingCleanup?.length) throw new PalaceError('请先完成数据清理，再更新资料。', 409, 'CLEANUP_PENDING');
        if (payload.action === 'save') {
          saveUserProfile(state, { name: payload.name, description: payload.description, preferences: payload.preferences || '' });
          message = '你的自我介绍已保存，后续交流会参考这份资料。';
        } else if (payload.action === 'clear' || payload.action === 'avatar.remove') {
          const hadAvatar = !!state.userProfile?.avatar;
          if (payload.action === 'clear') clearUserProfile(state); else removeUserAvatar(state);
          if (hadAvatar) state.pendingCleanup = [{ id: crypto.randomUUID(), kind: 'member', imageIds: ['user-profile'], createdAt: new Date().toISOString() }];
          message = payload.action === 'clear' ? '自我介绍和头像已清空。已经发生的聊天记录保留。' : '你的头像已移除。';
        } else {
          if (!env.BUCKET) throw new PalaceError('图片存储尚未配置。', 503, 'IMAGE_NOT_CONFIGURED');
          const prompt = payload.action === 'avatar.generate' ? userAvatarPrompt(state, payload.prompt || '', getEffectiveProvider('image')) : undefined;
          const image = payload.action === 'avatar.upload' ? await decodeUserImage(payload.dataBase64, payload.contentType) : await (async () => {
            const generated = await generatePortrait(prompt!);
            return normalizeUserImage(generated.bytes, generated.contentType);
          })();
          await env.BUCKET.put(`portraits/${encodeURIComponent(user.userId)}/user-profile`, image.bytes, { httpMetadata: { contentType: image.contentType } });
          setUserAvatar(state, `/api/portraits/user-profile?v=${crypto.randomUUID()}`, payload.action === 'avatar.generate' ? payload.prompt || '' : undefined);
          message = payload.action === 'avatar.upload' ? '你的头像已上传并保存。' : '你的头像已生成并保存。';
        }
      });
      const replayed = result.replayed;
      if (result.state.pendingCleanup?.length) {
        result = await mutateState<AppState>(user.userId, crypto.randomUUID(), createInitialState, async state => {
          const cleanup = await runPendingCleanup(user.userId, state, env);
          if (cleanup.message) message = cleanup.message;
        });
      }
      return json({ state: hydrateConfig(upgradeAppState(result.state)), profile: result.state.userProfile || null, message: message || '这项资料操作已经处理。', replayed });
    });
  } catch (error) { const safe = publicError(error); return json({ error: safe.message, code: safe.code }, safe.status); }
}
