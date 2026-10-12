import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../lib/seeds.ts';
import { createRandomRecruitmentBrief, randomRecruitmentAxes } from '../lib/server/random-recruitment.ts';
import { startRecruitment, retryRecruitment } from '../lib/server/recruitment.ts';
import { PalaceError } from '../lib/server/errors.ts';

const generatedBrief = '希望寻访来自海岸修复工坊的原创人物，身体形态依照指定种族构思，平时穿便于活动的日常衣装，并珍惜一枚曾由自己修复的旧扣子。她擅长观察材料损坏的细节，能够耐心拆解复杂问题，却不善于安排多人工作。一次主动让出重要机会的经历使她渴望再次展示自己的能力，同时担心竞争会伤害亲近的人。她说话先给结论，再用生活中的小例子说明，愿意通过一起完成小事建立信任。请让不同候选人具有各自的来历、语言节奏和生活习惯，不重复已有角色的姓名与完整设定。';

test('random directions combine independent dimensions and cover human, synthetic and nonhuman possibilities', () => {
  let seed = 1967;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  const plans = Array.from({ length: 128 }, () => randomRecruitmentAxes(random));
  assert.equal(new Set(plans.map(plan => JSON.stringify(plan))).size, 128);
  const species = new Set(plans.map(plan => plan.species));
  for (const value of ['人类', '有仿生皮肤的机器人', '外露机械构型的机器人', '原创幻想种族', '灵体或其他非实体生命']) assert.ok(species.has(value));
  for (const axis of Object.keys(plans[0])) assert.ok(new Set(plans.map(plan => plan[axis as keyof typeof plan])).size >= 6);
});

test('idea generation keeps the chosen direction, public diversity and overrides while leaving all state intact', async () => {
  const state = createInitialState();
  state.userProfile = { name: 'private-profile-marker', description: 'private-description-marker', updatedAt: state.updatedAt };
  state.agents[0].chats = [{ id: 'private-chat', role: 'user', content: 'private-chat-marker', createdAt: state.updatedAt }];
  state.agents[0].memories = [{ id: 'private-memory', kind: 'experience', content: 'private-memory-marker', source: 'private-source', createdAt: state.updatedAt }];
  state.agents[0].strategy = 'private-strategy-marker';
  state.promptOverrides = { 'recruiter.idea': '自定义随机设定创作规则' };
  const candidate = structuredClone(state.agents[2]); candidate.id = 'new-id'; candidate.name = '本批已成功';
  state.recruitment = { id: 'batch', brief: '旧方向', count: 1, slots: [{ slot: 1, status: 'succeeded', candidate, attempts: 1, issues: [] }], applied: false, createdAt: state.updatedAt, updatedAt: state.updatedAt };
  const before = structuredClone(state);
  let called = 0;
  const result = await createRandomRecruitmentBrief(state, { brief: '  都是温和的硅胶皮肤仿生机器人  ', count: 4 }, async (system, input, maxTokens, timeoutMs) => {
    called++;
    assert.match(system, /自定义随机设定创作规则/);
    const context = input as { direction: string; requestedCount: number; nonce: string; creativeAxes: object; diversity: { totalKnownCharacters: number; existingCharacters: { name: string }[] }; existingNamesToAvoid: string[] };
    assert.equal(context.direction, '都是温和的硅胶皮肤仿生机器人');
    assert.equal(context.requestedCount, 4);
    assert.equal(context.nonce, 'fixture-nonce');
    assert.equal(context.diversity.totalKnownCharacters, before.agents.length + 1);
    assert.ok(context.diversity.existingCharacters.some(character => character.name === candidate.name));
    assert.ok(context.existingNamesToAvoid.includes(candidate.name));
    for (const marker of ['private-profile-marker', 'private-description-marker', 'private-chat-marker', 'private-memory-marker', 'private-strategy-marker', 'private-source']) assert.ok(!JSON.stringify(context).includes(marker));
    assert.equal(Object.keys(context.creativeAxes).length, 10);
    assert.ok(maxTokens >= 1800 && timeoutMs <= 90_000);
    return { brief: `  ${generatedBrief}  ` };
  }, { nonce: 'fixture-nonce', random: () => 0.3 });
  assert.equal(called, 1);
  assert.deepEqual(result, { brief: generatedBrief });
  assert.deepEqual(state, before);
});

test('empty input produces free creation and each request carries fresh random context', async () => {
  const state = createInitialState(); state.agents = [];
  const inputs: { direction: string; nonce: string }[] = [];
  for (let i = 0; i < 2; i++) await createRandomRecruitmentBrief(state, {}, async (system, input) => {
    assert.match(system, /人类、异种族/);
    assert.match(system, /至少100字符且最多1800字符/);
    inputs.push(input as typeof inputs[number]);
    return { brief: generatedBrief };
  });
  assert.equal(inputs[0].direction, '');
  assert.notEqual(inputs[0].nonce, inputs[1].nonce);
  assert.equal(state.recruitment, undefined);
});

test('invalid input and malformed model drafts never become a recruitment brief or mutate state', async () => {
  const state = createInitialState(); const before = structuredClone(state);
  const called = () => { throw new Error('must not call the model for invalid input'); };
  for (const input of [{ brief: '字'.repeat(1801) }, { brief: '\0' }, { count: 0 }, { count: 1.5 }, { count: 11 }, { other: 'unsupported' }]) {
    await assert.rejects(createRandomRecruitmentBrief(state, input, called), (error: unknown) => error instanceof PalaceError && error.code === 'RECRUITMENT_IDEA_INPUT_INVALID');
  }
  for (const output of [{}, { brief: '' }, { brief: '只有标签' }, { brief: '字'.repeat(1801) }, { brief: generatedBrief, candidates: [] }, { brief: `${generatedBrief}\0` }]) {
    await assert.rejects(createRandomRecruitmentBrief(state, {}, async () => output), (error: unknown) => error instanceof PalaceError && error.code === 'RECRUITMENT_IDEA_INVALID');
  }
  const failure = new PalaceError('模型响应超时。', 504, 'PROVIDER_TIMEOUT');
  await assert.rejects(createRandomRecruitmentBrief(state, {}, async () => { throw failure; }), failure);
  assert.deepEqual(state, before);
});

test('generated briefs use the existing recruitment queue, duplicate checks and targeted retries', async () => {
  const state = createInitialState();
  const first = structuredClone(state.agents[1]); first.name = '随机候选甲';
  const second = structuredClone(state.agents[2]); second.name = '随机候选乙';
  state.agents = [state.agents[0]];
  const idea = await createRandomRecruitmentBrief(state, { count: 2 }, async () => ({ brief: generatedBrief }));
  await startRecruitment(state, idea.brief, 2, { generate: async input => {
    assert.equal(input.brief, generatedBrief);
    return { candidates: [input.slot === 1 ? first : { ...second, name: first.name }] };
  } });
  assert.equal(state.recruitment!.slots[0].status, 'succeeded');
  assert.equal(state.recruitment!.slots[1].errorCode, 'RECRUITMENT_DUPLICATE');
  const savedFirst = structuredClone(state.recruitment!.slots[0]);
  await retryRecruitment(state, state.recruitment!.id, 2, { generate: async input => {
    assert.equal(input.slot, 2);
    assert.equal(input.brief, generatedBrief);
    assert.ok(input.knownNames.includes(first.name));
    return { candidates: [second] };
  } });
  assert.deepEqual(state.recruitment!.slots[0], savedFirst);
  assert.equal(state.recruitment!.applied, true);
});
