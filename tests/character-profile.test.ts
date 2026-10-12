import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_SKILLS, LEGACY_SKILLS, NEW_SKILLS, normalizeCharacterSkills, profileTextLength, upgradeAgent, upgradeAppState, upgradeSkills } from '../lib/character-profile.ts';
import { createInitialState } from '../lib/seeds.ts';
import { PROFILE_FIELD_LABELS, SKILL_DESCRIPTIONS, SKILL_GROUPS, SKILL_LABELS, type Agent, type Skill } from '../lib/types.ts';
import { characterProfileSchema, createCharacterProfileSchema, createProfileExpansionSchema, createRichCandidateSchema, profileExpansionSchema, richCandidateSchema, speciesSchema } from '../lib/server/character-schema.ts';

const oldScores: Record<string, number[]> = {
  jade: [75, 90, 40, 40, 65, 50], pearl: [40, 45, 50, 90, 50, 85], amber: [70, 60, 50, 80, 70, 30], plum: [45, 65, 90, 40, 55, 65],
  mist: [90, 65, 45, 40, 85, 35], rose: [60, 65, 40, 70, 40, 85], indigo: [65, 55, 60, 35, 90, 55], fern: [45, 50, 65, 90, 70, 40],
};
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const hanLength = (text: string) => text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
function compactCandidate() {
  const candidate = structuredClone(createInitialState().agents[0]);
  candidate.bio = '简述';
  candidate.traits = ['沉静']; candidate.values = ['诚实']; candidate.boundaries = ['保密'];
  for (const key of Object.keys(candidate.profile) as (keyof Agent['profile'])[]) {
    Reflect.set(candidate.profile, key, Array.isArray(candidate.profile[key]) ? ['具体内容'] : '具体内容');
  }
  candidate.skills = Object.fromEntries(ALL_SKILLS.map((key, index) => [key, index === 0 ? 0 : 100])) as Agent['skills'];
  return candidate;
}

test('content-rule debugging permits alternate ages, concise complete profiles, and unrestricted in-scale skills', () => {
  const schema = createRichCandidateSchema(false);
  for (const age of [0, 18, 10001, Number.MAX_SAFE_INTEGER]) {
    const candidate = { ...compactCandidate(), age };
    assert.equal(schema.safeParse(candidate).success, true, `debug age ${age}`);
    assert.equal(createRichCandidateSchema().safeParse(candidate).success, false);
    assert.equal(createProfileExpansionSchema(false).safeParse({ species: candidate.species, profile: candidate.profile }).success, true);
  }
  const longProfile = structuredClone(createInitialState().agents[0].profile);
  for (const key of Object.keys(longProfile) as (keyof Agent['profile'])[]) {
    if (typeof longProfile[key] === 'string') Reflect.set(longProfile, key, '具体内容'.repeat(300));
  }
  assert.ok(profileTextLength(longProfile) > 12000);
  assert.equal(createCharacterProfileSchema(false).safeParse(longProfile).success, true);
  assert.equal(characterProfileSchema.safeParse(longProfile).success, false);
});

test('disabling content rules retains complete fields, valid chronology, display scales and bounded payloads', () => {
  const schema = createRichCandidateSchema(false);
  const valid = compactCandidate();
  const badProfiles = [
    { ...valid.profile, desire: undefined }, { ...valid.profile, fear: 4 },
    { ...valid.profile, speechExamples: [] }, { ...valid.profile, habits: '标签' },
    { ...valid.profile, worldview: '字'.repeat(2001) }, { ...valid.profile, habits: Array(9).fill('习惯') },
  ];
  for (const profile of badProfiles) assert.equal(schema.safeParse({ ...valid, profile }).success, false);
  for (const age of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '18']) assert.equal(schema.safeParse({ ...valid, age }).success, false);
  for (const skills of [
    { ...valid.skills, research: undefined }, { ...valid.skills, research: '50' },
    { ...valid.skills, research: -1 }, { ...valid.skills, research: 101 }, { ...valid.skills, research: 0.5 },
  ]) assert.equal(schema.safeParse({ ...valid, skills }).success, false);
  for (const candidate of [{ ...valid, name: '' }, { ...valid, bio: ' ' }, { ...valid, traits: [] }, { ...valid, bio: '字'.repeat(1601) }, { ...valid, species: { ...valid.species, kind: 'unknown' } }]) assert.equal(schema.safeParse(candidate).success, false);
  const robot = { ...valid, species: { ...valid.species, kind: 'synthetic', manufacturedAt: '2026-02-30' } };
  assert.equal(schema.safeParse(robot).success, false);
  assert.equal(schema.safeParse({ ...robot, species: { ...robot.species, manufacturedAt: undefined } }).success, false);
  assert.equal(schema.safeParse({ ...robot, species: { ...robot.species, manufacturedAt: '2026-02-28' } }).success, true);
});

test('unrestricted skill policy repairs only invalid dimensions without applying a hidden budget', () => {
  const agent = compactCandidate(); agent.skillPolicy = 'unrestricted';
  const valid = structuredClone(agent.skills);
  upgradeAgent(agent); assert.deepEqual(agent.skills, valid);
  agent.skills.research = NaN; agent.skills.planning = 140; agent.skills.execution = -3; agent.skills.creativity = 31.6;
  Reflect.deleteProperty(agent.skills, 'review'); Reflect.set(agent.skills, 'omnipotence', 999);
  upgradeAgent(agent);
  assert.equal(agent.skills.research, 60); assert.equal(agent.skills.planning, 100); assert.equal(agent.skills.execution, 0); assert.equal(agent.skills.creativity, 32); assert.equal(agent.skills.review, 60);
  assert.equal(agent.skills.empathy, 100); assert.equal(Object.hasOwn(agent.skills, 'omnipotence'), false);
  assert.deepEqual(Object.keys(agent.skills).sort(), [...ALL_SKILLS].sort());
});
function checkBudget(skills: Record<Skill, number>) {
  assert.deepEqual(Object.keys(skills).sort(), [...ALL_SKILLS].sort());
  assert.equal(sum(Object.values(skills)), 960);
  assert.ok(Object.values(skills).every(value => Number.isInteger(value) && value >= 15 && value <= 95));
  assert.ok(Object.values(skills).filter(value => value < 50).length >= 2);
}
function legacyAgent(agent: Agent): Agent {
  const legacy = structuredClone(agent);
  for (const field of ['species', 'profile', 'profileVersion', 'profileSource']) Reflect.deleteProperty(legacy, field);
  legacy.skills = Object.fromEntries(LEGACY_SKILLS.map(key => [key, legacy.skills[key]])) as Agent['skills'];
  return legacy;
}

test('sixteen abilities have unique labels and four complete, non-overlapping groups', () => {
  assert.equal(ALL_SKILLS.length, 16);
  assert.equal(SKILL_GROUPS.length, 4);
  assert.ok(SKILL_GROUPS.every(group => group.skills.length === 4 && group.label && group.description));
  assert.deepEqual(SKILL_GROUPS.flatMap(group => group.skills).sort(), [...ALL_SKILLS].sort());
  assert.equal(new Set(Object.values(SKILL_LABELS)).size, 16);
  assert.deepEqual(Object.keys(SKILL_DESCRIPTIONS).sort(), [...ALL_SKILLS].sort());
  assert.ok(Object.values(SKILL_DESCRIPTIONS).every(description => description.length >= 15));
});

test('all eight authored profiles are substantial and distinct, retaining their human identities and all six original priors', () => {
  const agents = createInitialState().agents;
  assert.equal(agents.length, 8);
  for (const agent of agents) {
    assert.equal(agent.profileSource, 'authored');
    assert.equal(agent.profileVersion, 2);
    assert.equal(agent.species.kind, 'human');
    assert.equal(agent.species.manufacturedAt, undefined);
    assert.equal(Object.hasOwn(agent.species, 'adultBasis'), false);
    assert.ok(hanLength(agent.bio) >= 160, `${agent.id} needs a substantive biography`);
    assert.ok(hanLength(JSON.stringify(agent.profile)) >= 1000, `${agent.id} needs a full authored profile`);
    assert.ok(profileTextLength(agent.profile) <= 12000);
    assert.deepEqual(Object.keys(agent.profile).sort(), Object.keys(PROFILE_FIELD_LABELS).sort());
    assert.deepEqual(LEGACY_SKILLS.map(key => agent.skills[key]), oldScores[agent.id]);
    assert.equal(sum(NEW_SKILLS.map(key => agent.skills[key])), 600);
    checkBudget(agent.skills);
    characterProfileSchema.parse(agent.profile);
    richCandidateSchema.parse(agent);
    assert.equal(agent.appointment, undefined);
    assert.equal(agent.weight, 1);
  }
  for (const field of Object.keys(PROFILE_FIELD_LABELS) as (keyof Agent['profile'])[]) {
    assert.equal(new Set(agents.map(agent => JSON.stringify(agent.profile[field]))).size, 8, `${field} should distinguish all eight personas`);
  }
});

test('legacy six-score migration is deterministic, preserves every old dimension and gives only the new ten the remaining budget', () => {
  for (const scores of Object.values(oldScores)) {
    const input = Object.fromEntries(LEGACY_SKILLS.map((key, index) => [key, scores[index]]));
    const before = structuredClone(input);
    const upgraded = upgradeSkills(input);
    checkBudget(upgraded);
    assert.deepEqual(input, before, 'migration must not mutate the source scores');
    assert.deepEqual(LEGACY_SKILLS.map(key => upgraded[key]), scores);
    assert.equal(sum(NEW_SKILLS.map(key => upgraded[key])), 600);
    assert.deepEqual(upgradeSkills(input), upgraded);
    assert.deepEqual(upgradeSkills(upgraded), upgraded);
  }
});

test('generated scores normalize extreme, incomplete and non-finite inputs without granting extra dimensions or losing weaknesses', () => {
  const cases: Partial<Record<Skill, number>>[] = [
    {}, { research: NaN, planning: Infinity, execution: -Infinity },
    ...[15, 60, 95, 0, 999].map(value => Object.fromEntries(ALL_SKILLS.map(key => [key, value]))),
    Object.fromEntries(ALL_SKILLS.map((key, index) => [key, index % 2 ? 95 : 15])),
  ];
  for (const input of cases) {
    const before = structuredClone(input);
    const normalized = normalizeCharacterSkills(input);
    checkBudget(normalized);
    assert.deepEqual(input, before);
    assert.deepEqual(normalizeCharacterSkills(input), normalized);
  }
  const valid = createInitialState().agents[0].skills;
  const withUnknown = { ...valid, omnipotence: 999 };
  assert.deepEqual(upgradeSkills(withUnknown), valid);
  assert.equal('omnipotence' in normalizeCharacterSkills(withUnknown), false);
});

test('state migration preserves existing core, preferences, private chats, memory, appointments and task history', () => {
  const state = createInitialState();
  state.agents = state.agents.map(legacyAgent);
  const agent = state.agents[0];
  agent.bio = '这是旧版本中已保存的简历，不应被新的默认长简历覆盖。';
  agent.hired = true; agent.liked = true; agent.weight = 28; agent.chatBoost = 3;
  agent.strategy = '用户真实反馈后形成的既有策略。';
  agent.evidence = { planning: 4, review: 2 };
  agent.appointment = { title: '议事记录官', duties: '按要求整理共议记录', appointedAt: '2026-10-11T10:00:00Z' };
  agent.chats = [{ id: 'private-chat', role: 'user', content: '只有她知道的偏好', createdAt: state.updatedAt }];
  agent.memories = [{ id: 'real-memory', kind: 'preference', content: '只来自真实反馈', source: 'private-chat', createdAt: state.updatedAt }];
  state.promptOverrides = { 'framework.system': '用户保存的框架提示词' };
  state.tasks = [{ id: 'real-task', title: '旧任务', rounds: 3, round: 1, status: 'running', participants: ['jade', 'mist'], order: ['jade', 'mist'], cursor: 1, createdAt: state.updatedAt }];
  state.events = [{ id: 'request', taskId: 'real-task', round: 1, agentId: 'jade', targetId: 'mist', kind: 'request', content: '真实邀请', checked: true, createdAt: state.updatedAt }];
  state.relationships = [{ id: 'accepted-relation', from: 'jade', to: 'mist', kind: 'delegation', taskId: 'earlier-task', eventId: 'actual-acceptance', createdAt: state.updatedAt }];
  const original = structuredClone(state);
  assert.equal(upgradeAppState(state), state);
  const restored = structuredClone(state);
  restored.agents = restored.agents.map(legacyAgent);
  assert.deepEqual(restored, original, 'only new profile/species metadata and skill dimensions may change');
  assert.equal(state.agents[0].profileSource, 'authored');
  assert.equal(state.agents[0].bio, original.agents[0].bio);
  const once = structuredClone(state);
  upgradeAppState(state);
  assert.deepEqual(state, once, 'repeated reads must not add memories or rewrite current state');
});

test('unknown legacy recruits get transparent grounded derived profiles without invented childhood or changing their race', () => {
  const agent = legacyAgent(createInitialState().agents[0]);
  agent.id = 'recruited-real-id'; agent.name = '素年'; agent.title = '档案整理者';
  agent.bio = '负责旧书目录，喜欢安静整理已提供的资料。';
  agent.traits = ['安静', '克制', '认真']; agent.values = ['目录准确', '尊重作者'];
  const before = structuredClone(agent);
  upgradeAgent(agent);
  assert.equal(agent.profileSource, 'derived');
  assert.equal(agent.species.kind, 'human');
  assert.ok(agent.profile.originStory.includes(before.bio));
  assert.match(agent.profile.originStory, /未记载/);
  assert.match(agent.profile.formativeExperience, /未记载|不能.*推断/);
  assert.match(agent.profile.expertise, /确定性推导.*不是.*测试/);
  assert.ok(agent.profile.worldview.includes('目录准确'));
  assert.deepEqual(legacyAgent(agent), before);
  assert.doesNotMatch(JSON.stringify(agent.profile), /城市更新|沿江城市|听证会/);
});

test('existing non-human profiles and robot manufacturing dates survive migration unchanged', () => {
  const agent = createInitialState().agents[0];
  agent.name = '银弦'; agent.id = 'robot-generated'; agent.age = 0; agent.profileSource = 'generated';
  agent.species = { name: '合成机器人', kind: 'synthetic', form: '银色合成躯体', origin: '虚构实验室', lifespan: '以保养周期计', manufacturedAt: '2026-10-12', innateTraits: ['可整理多种格式的文字'], limitations: ['没有接入任何现实执行工具'] };
  agent.profile.originStory = '这台机器人于指定制造日期完成组装，其余背景属于现有虚构档案。';
  const before = structuredClone(agent);
  upgradeAgent(agent);
  assert.deepEqual(agent, before);
  const another = createInitialState().agents[1];
  assert.notEqual(another.profile, createInitialState().agents[1].profile);
  another.profile.habits.push('只属于本状态的修改');
  assert.equal(createInitialState().agents[1].profile.habits.includes('只属于本状态的修改'), false);
});

test('robot candidates require a real manufacturing date but no human age or retired maturity field', () => {
  const candidate = createInitialState().agents[0];
  candidate.age = 0;
  candidate.species = { ...candidate.species, kind: 'synthetic', name: '机器人', manufacturedAt: '2024-02-29' };
  assert.equal(richCandidateSchema.parse(candidate).age, 0);
  assert.equal(Object.hasOwn(speciesSchema.parse(candidate.species), 'adultBasis'), false);
  for (const date of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-1-1', 'not-a-date', '']) {
    assert.equal(speciesSchema.safeParse({ ...candidate.species, manufacturedAt: date }).success, false, date);
  }
  const missingDate = { ...candidate.species }; Reflect.deleteProperty(missingDate, 'manufacturedAt');
  assert.equal(speciesSchema.safeParse(missingDate).success, false);
});

test('fantasy species have distinct kind metadata, and non-robot candidates retain adult age validation', () => {
  const candidate = createInitialState().agents[0];
  for (const kind of ['human', 'mythical', 'spirit', 'alien', 'other'] as const) {
    const species = { ...candidate.species, kind, name: `虚构${kind}` };
    assert.equal(richCandidateSchema.safeParse({ ...candidate, species, age: 21 }).success, true);
    assert.equal(richCandidateSchema.safeParse({ ...candidate, species, age: 20 }).success, false);
    assert.equal(richCandidateSchema.safeParse({ ...candidate, species, age: 10000 }).success, true);
    assert.equal(speciesSchema.safeParse({ ...species, manufacturedAt: '2026-10-12' }).success, false);
    assert.equal(Object.hasOwn(speciesSchema.parse({ ...species, adultBasis: '旧设定' }), 'adultBasis'), false);
  }
  assert.equal(profileExpansionSchema.safeParse({ species: candidate.species, profile: candidate.profile, weight: 99 }).success, false);
  assert.equal(characterProfileSchema.safeParse({ ...candidate.profile, speechExamples: ['只有一句'] }).success, false);
  const fragments = Object.fromEntries(Object.entries(candidate.profile).map(([key, value]) => [key, Array.isArray(value) ? ['短', '短'] : '短']));
  assert.equal(characterProfileSchema.safeParse(fragments).success, false);
});

test('migration removes only the retired maturity field from agents and pending recruitment candidates', () => {
  const state = createInitialState();
  const candidate = legacyAgent(state.agents[1]);
  candidate.species = { ...state.agents[1].species, kind: 'synthetic', name: '机械生命', manufacturedAt: '2026-10-12' };
  candidate.age = 0;
  Object.assign(candidate.species, { adultBasis: '旧机器人成熟依据' });
  Object.assign(state.agents[0].species, { adultBasis: '旧人类成年依据' });
  state.recruitment = {
    id: 'partial-batch', brief: '保留此需求', count: 2, createdAt: state.updatedAt, updatedAt: state.updatedAt, applied: false,
    slots: [
      { slot: 1, status: 'succeeded', attempts: 1, candidate, issues: [] },
      { slot: 2, status: 'failed', attempts: 2, issues: [{ path: 'bio', message: '原有校验说明' }], errorCode: 'PROVIDER_FORMAT' },
    ],
  };
  const originalAgent = structuredClone(state.agents[0]);
  const originalCandidate = structuredClone(candidate);
  const originalBatch = structuredClone(state.recruitment);
  upgradeAppState(state);
  Reflect.deleteProperty(originalAgent.species, 'adultBasis');
  assert.deepEqual(state.agents[0], originalAgent, 'all other identity, species and private state remain identical');
  assert.equal(Object.hasOwn(candidate.species, 'adultBasis'), false);
  assert.equal(candidate.age, 0);
  assert.equal(candidate.species.manufacturedAt, '2026-10-12');
  assert.equal(candidate.profileSource, 'derived');
  checkBudget(candidate.skills);
  assert.deepEqual(LEGACY_SKILLS.map(key => candidate.skills[key]), LEGACY_SKILLS.map(key => originalCandidate.skills[key]));
  const { candidate: ignoredBefore, ...beforeSlot } = originalBatch.slots[0];
  const { candidate: ignoredAfter, ...afterSlot } = state.recruitment!.slots[0];
  assert.ok(ignoredBefore && ignoredAfter);
  assert.deepEqual(afterSlot, beforeSlot);
  assert.deepEqual(state.recruitment!.slots[1], originalBatch.slots[1]);
  assert.deepEqual({ ...state.recruitment, slots: [] }, { ...originalBatch, slots: [] });
  const once = structuredClone(state);
  upgradeAppState(state);
  assert.deepEqual(state, once);
});
