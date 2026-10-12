import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../lib/seeds.ts';
import { getPromptText, listPrompts } from '../lib/prompts.ts';
import { debugCatalog, runDebugCore, type DebugDependencies } from '../lib/server/debug-core.ts';
import { beginProviderTrace, updateProviderTrace } from '../lib/server/provider-trace.ts';
import { PalaceError } from '../lib/server/errors.ts';
import type { PortraitReference } from '../lib/server/portrait-reference.ts';

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const expectedDataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const avatarBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 11, 22, 33);
function fixture() {
  const calls = { images: 0, texts: 0, actions: 0, persistentWrites: 0 };
  const loadedReferences: { agentId: string; userId: string; reference: PortraitReference }[] = [];
  const generatedReferences: (PortraitReference | undefined)[] = [];
  const dependencies: DebugDependencies = {
    imageReady: () => true,
    getEffectiveProvider: kind => ({ apiKey: `${kind}-test-key` }),
    async loadReference(agent, userId) {
      const reference = { bytes: avatarBytes, contentType: 'image/png', sourceUrl: agent.portrait };
      loadedReferences.push({ agentId: agent.id, userId, reference });
      return reference;
    },
    async generatePortrait(prompt, reference) {
      const entry = beginProviderTrace({ kind: 'image', model: 'fixture-image', endpoint: 'https://fixture.invalid/images/generations', prompt });
      calls.images++;
      generatedReferences.push(reference);
      updateProviderTrace(entry, { status: 'ok', raw: 'fixture bytes', parsed: { contentType: 'image/png', bytes: bytes.length } });
      return { bytes, contentType: 'image/png' };
    },
    async completeJson(system, input) {
      const entry = beginProviderTrace({ kind: 'text', model: 'fixture-text', endpoint: 'https://fixture.invalid/chat/completions', messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }] });
      calls.texts++;
      const value = { pass: true, imageRequested: true };
      updateProviderTrace(entry, { status: 'ok', raw: JSON.stringify(value), parsed: value });
      return { value };
    },
    async performAction(state, payload, _userId, options) {
      calls.actions++;
      const agent = state.agents.find(item => item.id === payload.agentId)!;
      agent.weight += 10;
      agent.chats.push({ id: 'sandbox-user', role: 'user', content: payload.message!, createdAt: state.updatedAt });
      await dependencies.completeJson('Fixture actor', { message: payload.message }, 100, 100);
      await dependencies.completeJson('Fixture reviewer', { pass: true, imageRequested: true }, 100, 100);
      const reference = await dependencies.loadReference(agent, _userId);
      const generated = await dependencies.generatePortrait('Reviewed temporary image', reference);
      const store = options?.chatImageSink || (async () => { calls.persistentWrites++; return '/api/chat-images/unsafe'; });
      const url = await store(generated, 'sandbox-reply');
      agent.chats.push({ id: 'sandbox-reply', role: 'assistant', content: '这次用更近的镜头。', checked: true, createdAt: state.updatedAt, image: { status: 'ready', request: 'close-up', prompt: 'Reviewed temporary image', model: 'fixture-image', url, reference: { sourceUrl: reference.sourceUrl, mode: 'character' } } });
      agent.memories.push({ id: 'sandbox-memory', kind: 'experience', content: '用户请求了特写', source: 'sandbox-user', createdAt: state.updatedAt });
      return {};
    },
  };
  return { calls, dependencies, loadedReferences, generatedReferences };
}

test('image catalog uses manufacturing date, current request and available capability without a retired maturity field', () => {
  const state = createInitialState();
  state.agents[0].age = 0;
  state.agents[0].species = { ...state.agents[0].species, kind: 'synthetic', manufacturedAt: '2026-10-12' };
  const catalog = debugCatalog(state, state.agents[0].id, true);
  const image = catalog.stages.find(item => item.id === 'chat-image')!;
  assert.equal(image.kind, 'image');
  const input = image.defaultInput as Record<string, unknown>;
  assert.equal(input.age, 'manufactured on 2026-10-12');
  assert.equal(Object.hasOwn(input, 'adultBasis'), false);
  assert.ok(input.request && input.userMessage);
  const actor = catalog.stages.find(item => item.id === 'actor')!.defaultInput as Record<string, unknown>;
  assert.equal(actor.imageGenerationAvailable, true);
  assert.equal((actor.immutableCore as Record<string, unknown>).age, undefined);
  assert.equal((actor.immutableCore as Record<string, unknown>).manufacturedAt, '2026-10-12');
});

test('single chat-image preview maps the selected template and stops before generating or saving bytes', async () => {
  const state = createInitialState(), before = structuredClone(state);
  const { dependencies, calls } = fixture();
  const result = await runDebugCore(state, {
    stage: 'actor', promptId: 'chat.image.template', agentId: state.agents[0].id,
    input: { request: 'Close-up mechanical hands', userMessage: '看你的机械手' },
    draftOverrides: { 'chat.image.template': 'REQUEST={{request}} USER={{userMessage}} ID={{appearance}}' },
  }, 'preview', 'fixture-user', dependencies);
  assert.equal(result.status, 'preview');
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].kind, 'image');
  assert.ok(result.trace[0].prompt?.startsWith('REQUEST=Close-up mechanical hands USER=看你的机械手 ID='));
  assert.equal(calls.images, 0);
  assert.equal(calls.actions, 0);
  assert.equal(calls.persistentWrites, 0);
  assert.equal(result.imageDataUrl, undefined);
  assert.deepEqual(state, before);
});

test('single chat-image runs return only a data URL and leave every avatar and saved state unchanged', async () => {
  const state = createInitialState();
  const agent = state.agents[1];
  agent.portrait = `/api/portraits/${agent.id}?v=avatar-version`;
  const before = structuredClone(state);
  const { dependencies, calls, loadedReferences, generatedReferences } = fixture();
  const result = await runDebugCore(state, { stage: 'chat-image', promptId: 'chat.image.template', agentId: agent.id, input: { reference: 'https://untrusted.test/other-avatar.png' } }, 'run', 'fixture-user', dependencies);
  assert.equal(result.status, 'ok');
  assert.equal(result.imageDataUrl, expectedDataUrl);
  assert.equal(result.persisted, false);
  assert.equal(calls.images, 1);
  assert.equal(calls.actions, 0);
  assert.equal(calls.persistentWrites, 0);
  assert.equal(loadedReferences.length, 1);
  assert.equal(loadedReferences[0].agentId, agent.id);
  assert.equal(loadedReferences[0].userId, 'fixture-user');
  assert.strictEqual(generatedReferences[0], loadedReferences[0].reference);
  assert.strictEqual(generatedReferences[0]?.bytes, avatarBytes);
  assert.equal(generatedReferences[0]?.sourceUrl, agent.portrait);
  assert.deepEqual(state, before);
});

test('a standalone chat-image without an avatar fails before paid generation and preserves the original portrait', async () => {
  const state = createInitialState(), before = structuredClone(state);
  const { dependencies, calls, generatedReferences } = fixture();
  let loads = 0;
  dependencies.loadReference = async () => { loads++; throw new PalaceError('请先生成这位角色的头像。', 409, 'IMAGE_REFERENCE_MISSING'); };
  const result = await runDebugCore(state, { stage: 'chat-image', promptId: 'chat.image.template' }, 'run', 'fixture-user', dependencies);
  assert.equal(result.status, 'error');
  assert.match(result.error || '', /头像/);
  assert.equal(result.imageDataUrl, undefined);
  assert.equal(loads, 1);
  assert.equal(calls.images, 0);
  assert.equal(calls.persistentWrites, 0);
  assert.deepEqual(generatedReferences, []);
  assert.deepEqual(state, before);
});

test('standalone portrait generation does not need an existing avatar reference', async () => {
  const state = createInitialState(), before = structuredClone(state);
  const { dependencies, calls, generatedReferences } = fixture();
  dependencies.loadReference = async () => { assert.fail('a new avatar must not require an existing reference'); };
  const result = await runDebugCore(state, { stage: 'portrait', promptId: 'portrait.template' }, 'run', 'fixture-user', dependencies);
  assert.equal(result.status, 'ok');
  assert.equal(result.imageDataUrl, expectedDataUrl);
  assert.equal(calls.images, 1);
  assert.deepEqual(generatedReferences, [undefined]);
  assert.equal(calls.persistentWrites, 0);
  assert.deepEqual(state, before);
});

test('complete chat sandbox supplies an in-memory image sink and isolates actor changes and images from production', async () => {
  const state = createInitialState(), before = structuredClone(state);
  const { dependencies, calls } = fixture();
  const result = await runDebugCore(state, { stage: 'chat', promptId: 'chat.image.template', input: { message: '给我一张手部特写' } }, 'run', 'fixture-user', dependencies);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.trace.map(item => item.kind), ['text', 'text', 'image']);
  assert.equal(result.imageDataUrl, expectedDataUrl);
  assert.equal(calls.actions, 1);
  assert.equal(calls.images, 1);
  assert.equal(calls.persistentWrites, 0);
  const output = result.output as { reply: { image: { url: string }; checked: boolean }; proposedMemories: unknown[] };
  assert.equal(output.reply.image.url, expectedDataUrl);
  assert.equal(output.reply.checked, true);
  assert.equal(output.proposedMemories.length, 1);
  assert.deepEqual(state, before, 'including likes, hiring, weights, chats, memories, avatars and overrides');
});

test('complete chat preview stops at its first text request and does not manufacture an image preview or persist changes', async () => {
  const state = createInitialState(), before = structuredClone(state);
  const { dependencies, calls } = fixture();
  const result = await runDebugCore(state, { stage: 'chat', promptId: 'chat.image.template', input: { message: '生成特写' } }, 'preview', 'fixture-user', dependencies);
  assert.equal(result.status, 'preview');
  assert.deepEqual(result.trace.map(item => item.kind), ['text']);
  assert.equal(result.imageDataUrl, undefined);
  assert.equal(calls.texts, 0);
  assert.equal(calls.images, 0);
  assert.equal(calls.persistentWrites, 0);
  assert.deepEqual(state, before);
});

test('a failed chat image makes the debug result fail even when the caption passed review', async () => {
  const state = createInitialState(), before = structuredClone(state);
  const { dependencies } = fixture();
  dependencies.performAction = async (sandbox, payload) => {
    const agent = sandbox.agents.find(item => item.id === payload.agentId)!;
    const entry = beginProviderTrace({ kind: 'image', model: 'fixture-image', endpoint: 'https://fixture.invalid/images/generations', prompt: 'current image' });
    updateProviderTrace(entry, { status: 'error', error: 'fixture image failure' });
    agent.chats.push({ id: 'failed-image', role: 'assistant', content: '保留已审核的文字', checked: true, createdAt: sandbox.updatedAt, image: { status: 'failed', request: 'close-up', prompt: 'current image', model: 'fixture-image', error: '图片生成失败 image-test-key' } });
    return {};
  };
  const result = await runDebugCore(state, { stage: 'chat', promptId: 'chat.image.template', input: { message: '请发一张图' } }, 'run', 'fixture-user', dependencies);
  assert.equal(result.status, 'error');
  assert.match(result.error!, /图片生成失败/);
  assert.equal(JSON.stringify(result).includes('image-test-key'), false);
  assert.equal((result.output as { reply: { content: string } }).reply.content, '保留已审核的文字');
  assert.equal(result.trace[0].status, 'error');
  assert.deepEqual(state, before);
});

test('choosing the image prompt for a text-only complete chat does not itself trigger an image call', async () => {
  const state = createInitialState();
  const { dependencies, calls } = fixture();
  dependencies.performAction = async (sandbox, payload) => {
    const agent = sandbox.agents.find(item => item.id === payload.agentId)!;
    agent.chats.push({ id: 'text-only', role: 'assistant', content: '普通文字回答', checked: true, createdAt: sandbox.updatedAt });
    return {};
  };
  const result = await runDebugCore(state, { stage: 'chat', promptId: 'chat.image.template', input: { message: '今天怎么安排？' } }, 'run', 'fixture-user', dependencies);
  assert.equal(result.status, 'ok');
  assert.equal(result.imageDataUrl, undefined);
  assert.equal(calls.images, 0);
  await assert.rejects(runDebugCore(state, { stage: 'task', promptId: 'chat.image.template' }, 'preview', 'fixture-user', dependencies), /不属于这个完整流程/);
});

test('image provider failures remain errors in the standalone stage and cannot change the portrait', async () => {
  const state = createInitialState(), before = structuredClone(state);
  const { dependencies } = fixture();
  dependencies.generatePortrait = async () => { throw new PalaceError('图片暂不可用', 502, 'IMAGE_ERROR'); };
  const result = await runDebugCore(state, { stage: 'chat-image', promptId: 'chat.image.template' }, 'run', 'fixture-user', dependencies);
  assert.equal(result.status, 'error');
  assert.equal(result.error, '图片暂不可用');
  assert.equal(result.imageDataUrl, undefined);
  assert.deepEqual(state, before);
});

test('user portrait debug passes the same identity aliases and raw prompt used by negative templates', async () => {
  const state = createInitialState();
  const { dependencies } = fixture();
  dependencies.generatePortrait = async (prompt, reference, variables) => {
    assert.equal(reference, undefined); assert.equal(variables?.name, '阿遥');
    assert.equal(variables?.appearance, 'short black hair'); assert.equal(variables?.userMessage, 'round glasses');
    assert.equal(variables?.prompt, prompt);
    return { bytes, contentType: 'image/png' };
  };
  const result = await runDebugCore(state, { stage: 'user-portrait', input: { name: '阿遥', description: 'short black hair', request: 'round glasses' } }, 'run', 'fixture-user', dependencies);
  assert.equal(result.status, 'ok');
});

test('chat-image template is independently editable and faithfully interpolates temporary composition instructions', () => {
  const definition = listPrompts().find(item => item.id === 'chat.image.template')!;
  assert.deepEqual(definition.variables, ['age', 'species', 'form', 'appearance', 'traits', 'request', 'userMessage']);
  const prompt = getPromptText(definition.id, {}, { age: 'manufactured on 2026-10-12', species: 'synthetic', form: 'steel hands', appearance: 'jade eyes, usual teal outfit', traits: 'calm', request: 'hands close-up, maid outfit, literal {{traits}}', userMessage: '女仆装和机械手特写' });
  assert.ok(prompt.includes('hands close-up, maid outfit, literal {{traits}}'));
  assert.equal(prompt.includes('女仆装和机械手特写'), false);
  assert.ok(prompt.includes('steel hands'));
  assert.match(prompt, /clothing instructions override clothing/);
  assert.match(prompt, /do not add a visible face/i);
  assert.doesNotMatch(prompt, /adultBasis|0 years old/);
  const oldPortrait = getPromptText('portrait.template', { 'portrait.template': '旧头像 {{appearance}}' }, { appearance: 'unchanged' });
  assert.equal(oldPortrait, '旧头像 unchanged');
});
