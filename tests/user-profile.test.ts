import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createInitialState } from '../lib/seeds.ts';
import { userProfileContext, userAvatarUrl, MAX_USER_IMAGE_BYTES } from '../lib/user-profile.ts';
import { clearUserProfile, createUserProfileDraft, decodeUserImage, normalizeUserImage, removeUserAvatar, saveUserProfile, setUserAvatar, userAvatarPrompt, userImageRequestJson, MAX_USER_IMAGE_REQUEST_BYTES } from '../lib/server/user-profile.ts';

const iso = '2026-10-12T10:00:00.000Z';
test('saving explicit profile fields preserves the avatar and does not rewrite characters or their memories', () => {
  const state = createInitialState(); const characters = structuredClone(state.agents);
  setUserAvatar(state, '/api/portraits/user-profile?v=first', 'green portrait', iso);
  const result = saveUserProfile(state, { name: '  阿遥  ', description: '想用空闲时间做小项目。', preferences: '请直接说明判断依据。' }, iso);
  assert.equal(result.name, '阿遥'); assert.equal(result.avatar, '/api/portraits/user-profile?v=first'); assert.equal(result.avatarPrompt, 'green portrait');
  assert.equal(state.updatedAt, iso); assert.deepEqual(state.agents, characters);
  assert.deepEqual(userProfileContext(state), { source: 'user-provided-profile', name: '阿遥', description: '想用空闲时间做小项目。', preferences: '请直接说明判断依据。', avatar: { url: '/api/portraits/user-profile?v=first', visuallyObserved: false }, updatedAt: iso });
});

test('profile validation rejects unknown fields and excessive text; empty fields do not invent a biography', () => {
  const state = createInitialState();
  for (const input of [{ name: '', description: '', preferences: '' }, { name: 'a'.repeat(61), description: '' }, { name: 'name', description: 'b'.repeat(4001) }, { name: 'name', description: '', avatar: 'https://external.invalid/img.png' }, { name: 'name\0', description: '' }]) {
    assert.throws(() => saveUserProfile(state, input), { code: 'USER_PROFILE_INVALID' });
  }
  assert.equal(state.userProfile, undefined);
  assert.equal(saveUserProfile(state, { name: '', description: '仅分享这些信息。' }, iso).name, '你');
});

test('avatar removal and clearing retain unrelated records, and context never fetches remote images', () => {
  const state = createInitialState();
  saveUserProfile(state, { name: '阿遥', description: '爱看星星。' }, iso);
  setUserAvatar(state, '/api/portraits/user-profile?v=avatar', 'avatar description', iso);
  removeUserAvatar(state, iso); assert.equal(state.userProfile!.avatar, undefined); assert.equal(state.userProfile!.avatarPrompt, undefined); assert.equal(state.userProfile!.description, '爱看星星。');
  for (const url of ['https://outside.invalid/p.png', '/api/portraits/other-person', '/api/portraits/user-profile?redirect=x', 'data:image/png;base64,AA==']) assert.equal(userAvatarUrl(url), undefined);
  state.userProfile!.avatar = 'https://outside.invalid/p.png'; assert.equal(userProfileContext(state)!.avatar, undefined);
  clearUserProfile(state, iso); assert.equal(userProfileContext(state), undefined); assert.equal(state.agents.length, createInitialState().agents.length);
});

test('AI creates an editable draft only, receives no unrelated private history, and uses the editable prompt', async () => {
  const state = createInitialState(); state.promptOverrides = { 'user.profile': 'TEST PROFILE DRAFT' };
  state.agents[0].chats.push({ id: 'private', role: 'user', content: 'private-marker', createdAt: iso });
  const before = structuredClone(state); let calls = 0;
  const result = await createUserProfileDraft(state, '喜欢科幻和编程，叫我阿遥。', async (system, input, tokens, timeout) => {
    calls++; assert.match(system, /TEST PROFILE DRAFT/); assert.equal(JSON.stringify(input).includes('private-marker'), false);
    assert.equal((input as { mode: string }).mode, 'user-editable-draft'); assert.ok(tokens > 0 && timeout <= 75_000);
    return { name: '阿遥', description: '我喜欢科幻和编程。', preferences: '希望一起探索想法。' };
  });
  assert.equal(result.name, '阿遥'); assert.equal(calls, 1); assert.deepEqual(state, before);
  await assert.rejects(createUserProfileDraft(state, '描述', async () => ({ name: 'bad', extra: true })), { code: 'USER_PROFILE_DRAFT_INVALID' });
});

test('avatar generation composes editable profile and channel templates literally', () => {
  const state = createInitialState(); saveUserProfile(state, { name: '阿遥', description: 'short black hair', preferences: 'warm colors' }, iso);
  state.promptOverrides = { 'user.portrait.template': '{{name}} / {{description}} / {{preferences}} / {{request}}' };
  assert.equal(userAvatarPrompt(state, 'glasses {{name}}', { promptStyle: 'custom', customPrompt: 'Draw {{name}}: {{prompt}}' }), 'Draw 阿遥: 阿遥 / short black hair / warm colors / glasses {{name}}');
  assert.throws(() => userAvatarPrompt(state, 'x'.repeat(2001)));
});

test('uploaded PNG/JPEG/WebP images are decoded into bounded PNG pixels without EXIF metadata', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const bytes = await sharp({ create: { width: 18, height: 12, channels: 3, background: '#557A67' } }).withMetadata({ exif: { IFD0: { Artist: 'private-metadata' } } }).toFormat(format).toBuffer();
    const output = await decodeUserImage(bytes.toString('base64'), `image/${format}`);
    const metadata = await sharp(output.bytes).metadata();
    assert.equal(output.contentType, 'image/png'); assert.equal(metadata.format, 'png'); assert.equal(metadata.width, 18); assert.equal(metadata.height, 12); assert.equal(metadata.exif, undefined);
  }
  const large = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#557A67' } }).png().toBuffer();
  const resized = await normalizeUserImage(new Uint8Array(large), 'image/png'); const metadata = await sharp(resized.bytes).metadata();
  assert.equal(metadata.width, 1536); assert.equal(metadata.height, 768);
});

test('spoofed MIME types, malformed base64, non-raster payloads and byte overflows are rejected before storage', async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#557A67' } }).png().toBuffer();
  await assert.rejects(decodeUserImage(bytes.toString('base64'), 'image/jpeg'), { code: 'USER_IMAGE_INVALID' });
  for (const data of ['', '%%%=', 'AAA', 'data:image/png;base64,AAAA', 'AB==']) await assert.rejects(decodeUserImage(data, 'image/png'), { code: 'USER_IMAGE_INVALID' });
  await assert.rejects(normalizeUserImage(new TextEncoder().encode('<svg onload="private-marker"/>'), 'image/png'), { code: 'USER_IMAGE_INVALID' });
  await assert.rejects(normalizeUserImage(new Uint8Array(MAX_USER_IMAGE_BYTES + 1), 'image/png'), { code: 'USER_IMAGE_INVALID' });
  await assert.rejects(normalizeUserImage(new Uint8Array(bytes), 'image/gif'), { code: 'USER_IMAGE_INVALID' });
});

test('upload JSON reader enforces same-origin and bounded bytes without echoing submitted payloads', async () => {
  const origin = 'http://127.0.0.1:5173'; const request = (body: string, extra: Record<string, string> = {}) => new Request(`${origin}/api/user-profile`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...extra }, body });
  assert.deepEqual(await userImageRequestJson(request('{"action":"save"}')), { action: 'save' });
  await assert.rejects(userImageRequestJson(request('{}', { origin: 'https://evil.invalid' })), { code: 'ORIGIN_MISMATCH' });
  await assert.rejects(userImageRequestJson(request('{}', { 'sec-fetch-site': 'cross-site' })), { code: 'ORIGIN_MISMATCH' });
  await assert.rejects(userImageRequestJson(request('{}', { 'content-type': 'text/plain' })), { status: 415 });
  await assert.rejects(userImageRequestJson(request('{}', { 'content-length': String(MAX_USER_IMAGE_REQUEST_BYTES + 1) })), { status: 413 });
  await assert.rejects(userImageRequestJson(request('{private-marker')), error => error instanceof Error && !error.message.includes('private-marker'));
});
