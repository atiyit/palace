import { z } from 'zod';
import sharp from 'sharp';
import type { AppState, UserProfile } from '../types.ts';
import { USER_PROFILE_LIMITS, MAX_USER_IMAGE_BYTES, type UserProfileDraft } from '../user-profile.ts';
import { combineSystemPrompt, getPromptText } from '../prompts.ts';
import { renderImagePrompt, type ImagePromptStyle } from '../image-prompts.ts';
import { PalaceError } from './errors.ts';

const field = (maximum: number) => z.string().trim().max(maximum).refine(value => !value.includes('\0'));
export const userProfileDraftSchema = z.object({
  name: field(USER_PROFILE_LIMITS.name), description: field(USER_PROFILE_LIMITS.description), preferences: field(USER_PROFILE_LIMITS.preferences).optional().default(''),
}).strict().refine(value => !!(value.name || value.description || value.preferences), '至少填写称呼、自我介绍或交流偏好中的一项。');
export const MAX_USER_IMAGE_BASE64_CHARS = Math.ceil(MAX_USER_IMAGE_BYTES / 3) * 4;
export const MAX_USER_IMAGE_REQUEST_BYTES = MAX_USER_IMAGE_BASE64_CHARS + 16_384;

export interface NormalizedUserImage { bytes: Uint8Array; contentType: 'image/png'; }
export type ProfileGenerate = (system: string, input: unknown, maxTokens: number, timeoutMs: number) => Promise<unknown>;

export function saveUserProfile(state: AppState, input: unknown, timestamp = new Date().toISOString()): UserProfile {
  const parsed = userProfileDraftSchema.safeParse(input);
  if (!parsed.success) throw new PalaceError('请填写称呼、自我介绍或交流偏好，并检查字段长度。', 400, 'USER_PROFILE_INVALID');
  const prior = state.userProfile;
  const profile: UserProfile = { ...parsed.data, name: parsed.data.name || '你', updatedAt: timestamp,
    ...(prior?.avatar ? { avatar: prior.avatar } : {}), ...(prior?.avatarPrompt ? { avatarPrompt: prior.avatarPrompt } : {}),
  };
  state.userProfile = profile; state.updatedAt = timestamp;
  return profile;
}

export function setUserAvatar(state: AppState, avatar: string, prompt?: string, timestamp = new Date().toISOString()) {
  const profile = state.userProfile || { name: '你', description: '', preferences: '', updatedAt: timestamp };
  state.userProfile = { ...profile, avatar, updatedAt: timestamp };
  if (prompt !== undefined) state.userProfile.avatarPrompt = prompt;
  else delete state.userProfile.avatarPrompt;
  state.updatedAt = timestamp;
}

export function removeUserAvatar(state: AppState, timestamp = new Date().toISOString()): void {
  if (state.userProfile) { delete state.userProfile.avatar; delete state.userProfile.avatarPrompt; state.userProfile.updatedAt = timestamp; }
  state.updatedAt = timestamp;
}

export function clearUserProfile(state: AppState, timestamp = new Date().toISOString()): void {
  delete state.userProfile; state.updatedAt = timestamp;
}

export async function createUserProfileDraft(state: AppState, brief: string, generate: ProfileGenerate): Promise<UserProfileDraft> {
  if (typeof brief !== 'string' || !brief.trim() || brief.length > USER_PROFILE_LIMITS.brief) throw new PalaceError('请输入1至2000字的资料构想。', 400, 'USER_PROFILE_BRIEF_INVALID');
  const result = await generate(combineSystemPrompt('user.profile', state.promptOverrides), {
    brief: brief.trim(), currentProfile: state.userProfile ? { name: state.userProfile.name, description: state.userProfile.description, preferences: state.userProfile.preferences || '' } : null,
    output: { name: '称呼，最多60字', description: '用户可编辑的自我介绍草稿，最多4000字', preferences: '交流偏好，最多2000字' },
    mode: 'user-editable-draft',
  }, 2200, 75_000);
  const parsed = userProfileDraftSchema.safeParse(result);
  if (!parsed.success) throw new PalaceError('资料草稿格式未通过检查，请重新生成或直接手动填写。', 502, 'USER_PROFILE_DRAFT_INVALID');
  return parsed.data;
}

export function userAvatarPrompt(state: AppState, request = '', options: { promptStyle?: ImagePromptStyle; customPrompt?: string } = {}): string {
  if (typeof request !== 'string' || request.length > USER_PROFILE_LIMITS.avatarPrompt) throw new PalaceError('头像描述最多2000字。');
  const profile = state.userProfile;
  if (!request.trim() && !(profile?.description || profile?.name)) throw new PalaceError('请先填写自我介绍，或描述想要的头像。');
  const variables = { name: profile?.name || '用户', description: profile?.description || '', preferences: profile?.preferences || '', request: request.trim() };
  const base = getPromptText('user.portrait.template', state.promptOverrides, variables);
  return renderImagePrompt(base, options.promptStyle, options.customPrompt, { ...variables, appearance: variables.description, userMessage: variables.request });
}

/** 我会亲自解码像素来验明正身，不轻信声称的 MIME 类型；元数据也一并剥离，像素尺寸和输出大小都严格把关呀。 */
export async function normalizeUserImage(bytes: Uint8Array, contentType: string): Promise<NormalizedUserImage> {
  const expected = ({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' } as Record<string, string>)[contentType];
  const invalid = () => new PalaceError('图片无效，请上传10 MiB以内的 PNG、JPEG 或 WebP 图片。', 400, 'USER_IMAGE_INVALID');
  if (!expected || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_USER_IMAGE_BYTES) throw invalid();
  try {
    const input = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'error', animated: false });
    const metadata = await input.metadata();
    if (metadata.format !== expected || !metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw invalid();
    const output = await input.rotate().resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    if (!output.length || output.length > MAX_USER_IMAGE_BYTES) throw invalid();
    return { bytes: new Uint8Array(output), contentType: 'image/png' };
  } catch (error) { if (error instanceof PalaceError) throw error; throw invalid(); }
}

export async function decodeUserImage(dataBase64: string, contentType: string): Promise<NormalizedUserImage> {
  if (typeof dataBase64 !== 'string' || !dataBase64.length || dataBase64.length > MAX_USER_IMAGE_BASE64_CHARS
    || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64)) {
    throw new PalaceError('图片编码无效或超过10 MiB，请重新选择图片。', 400, 'USER_IMAGE_INVALID');
  }
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.toString('base64') !== dataBase64) throw new PalaceError('图片编码不完整，请重新选择图片。', 400, 'USER_IMAGE_INVALID');
  return normalizeUserImage(new Uint8Array(bytes), contentType);
}

/** 不管是头像还是聊天图片上传，请求体都由我在门口检查——JSON 格式和大小上限缺一不可呢。 */
export async function userImageRequestJson(request: Request): Promise<unknown> {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new PalaceError('请求来源不匹配，请在应用页面内操作。', 403, 'ORIGIN_MISMATCH');
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new PalaceError('请求需要JSON格式。', 415);
  if (Number(request.headers.get('content-length') || 0) > MAX_USER_IMAGE_REQUEST_BYTES) throw new PalaceError('请求内容过大，图片上限为10 MiB。', 413);
  if (!request.body) throw new PalaceError('请求内容为空。');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_USER_IMAGE_REQUEST_BYTES) { await reader.cancel(); throw new PalaceError('请求内容过大，图片上限为10 MiB。', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new PalaceError('请求JSON格式无效。'); }
}
