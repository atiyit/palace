import type { Agent, AppState } from '../types.ts';
import { userAvatarUrl } from '../user-profile.ts';
import { loadPortraitReference } from './portrait-reference.ts';
import type { TextImageInput } from './text-provider-adapter.ts';
import { PalaceError } from './errors.ts';

/** 主人，只加载当前用户的头像和此角色最近的用户附件；绝不访问其他私聊内容。 */
export async function loadChatVision(state: AppState, agent: Agent, userId: string, bucket: Pick<R2Bucket, 'get'> | undefined, enabled: boolean): Promise<{ images: TextImageInput[]; context: { enabled: boolean; images: { sourceId: string; label: string; visuallyObserved: true }[] } }> {
  if (!enabled) return { images: [], context: { enabled: false, images: [] } };
  const sources: { sourceId: string; label: string; url: string }[] = [];
  const avatar = userAvatarUrl(state.userProfile?.avatar);
  if (avatar) sources.push({ sourceId: 'user-provided-profile', label: '用户头像', url: avatar });
  const message = agent.chats.slice(-12).reverse().find(chat => chat.role === 'user' && chat.attachments?.length);
  const image = message?.attachments?.at(-1);
  if (image && message) {
    if (!/^[a-zA-Z0-9_-]{1,85}$/.test(image.id) || image.url !== `/api/portraits/upload-${image.id}`) throw new PalaceError('聊天图片引用无效，请重新上传。', 400, 'VISION_IMAGE_INVALID');
    sources.push({ sourceId: message.id, label: `用户在消息 ${message.id} 上传的图片${image.name ? `（${image.name}）` : ''}`, url: image.url });
  }
  const images = await Promise.all(sources.map(async source => {
    const imageId = source.url.match(/^\/api\/portraits\/([a-zA-Z0-9_-]+)(?:\?v=[a-zA-Z0-9_-]+)?$/)?.[1];
    if (!imageId) throw new PalaceError('用户图片引用无效。', 400, 'VISION_IMAGE_INVALID');
    try {
      const image = await loadPortraitReference({ id: imageId, portrait: source.url }, userId, bucket);
      return { dataBase64: Buffer.from(image.bytes).toString('base64'), contentType: image.contentType as TextImageInput['contentType'], label: source.label, sourceUrl: source.url };
    } catch { throw new PalaceError('无法读取用户头像或聊天图片，请重新上传，或在 API 设置关闭图片识别后继续文字聊天。', 409, 'VISION_IMAGE_UNAVAILABLE'); }
  }));
  return { images, context: { enabled: true, images: sources.map(({ sourceId, label }) => ({ sourceId, label, visuallyObserved: true })) } };
}
