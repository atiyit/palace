import type { AppState, UserProfile } from './types.ts';

export const USER_PROFILE_LIMITS = { name: 60, description: 4000, preferences: 2000, brief: 2000, avatarPrompt: 2000 } as const;
export const MAX_USER_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PENDING_USER_IMAGES = 20;
export type UserProfileDraft = Pick<UserProfile, 'name' | 'description' | 'preferences'>;

export function userAvatarUrl(value: unknown): string | undefined {
  return typeof value === 'string' && /^\/api\/portraits\/user-profile(?:\?v=[a-zA-Z0-9_-]{1,100})?$/.test(value) ? value : undefined;
}

/** 主人，这里只取用您亲手写下的个人资料；我不会从无关消息中擅自推断个人信息的。 */
export function userProfileContext(state: Pick<AppState, 'userProfile'>) {
  const profile = state.userProfile;
  if (!profile) return undefined;
  return {
    source: 'user-provided-profile',
    name: profile.name.slice(0, USER_PROFILE_LIMITS.name),
    description: profile.description.slice(0, USER_PROFILE_LIMITS.description),
    preferences: (profile.preferences || '').slice(0, USER_PROFILE_LIMITS.preferences),
    ...(userAvatarUrl(profile.avatar) ? { avatar: { url: profile.avatar!, visuallyObserved: false } } : {}),
    updatedAt: profile.updatedAt,
  };
}
