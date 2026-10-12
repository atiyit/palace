import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../lib/seeds.ts';
import { getPromptText } from '../lib/prompts.ts';
import { recruitmentCorrection, recruitmentNamesToAvoid } from '../lib/server/recruitment.ts';
import { debugCatalog, runDebugCore, type DebugDependencies } from '../lib/server/debug-core.ts';

test('name corrections include the concrete conflict and the complete exclusion list, and remain editable', () => {
  const input = { knownNames: ['陆知微', 'Alice'], previousIssues: [{ path: 'candidates.0.name', message: '姓名与已有角色「陆知微」重复。' }] };
  const correction = recruitmentCorrection(input);
  assert.ok(correction.includes(input.previousIssues[0].message));
  for (const name of input.knownNames) assert.ok(correction.includes(name));
  const overrides = { 'retry.recruit.schema': '问题：{{reason}}', 'retry.recruit.names': '排除：{{names}}' };
  assert.equal(recruitmentCorrection(input, overrides), `问题：candidates.0.name: ${input.previousIssues[0].message}\n排除：${JSON.stringify(input.knownNames)}`);
  assert.equal(recruitmentCorrection({ ...input, previousIssues: [] }), '');
  assert.doesNotMatch(recruitmentCorrection({ ...input, previousIssues: [{ path: 'candidates.0.bio', message: '太短' }] }, overrides), /排除：/);
  assert.match(getPromptText('recruiter.system'), /existingNamesToAvoid/);
  assert.match(getPromptText('recruiter.names'), /全半角/);
});

test('exclusion collection preserves display names but deduplicates equivalent spellings', () => {
  const state = createInitialState();
  state.agents = state.agents.slice(0, 3);
  state.agents[0].name = 'Alice'; state.agents[1].name = 'ＡＬＩＣＥ'; state.agents[2].name = '清 禾';
  assert.deepEqual(recruitmentNamesToAvoid(state), ['Alice', '清 禾']);
});

function captureRecruitment() {
  const calls: { system: string; input: Record<string, unknown> }[] = [];
  const dependencies: DebugDependencies = {
    loadReference: async () => { throw new Error('No image references in this test'); },
    imageReady: () => false, getEffectiveProvider: () => ({ apiKey: '' }),
    generatePortrait: async () => { throw new Error('No images in this test'); },
    performAction: async () => { throw new Error('No state mutations in this test'); },
    completeJson: async (system, input) => {
      calls.push({ system, input: input as Record<string, unknown> });
      return { value: { candidates: [{ ...createInitialState().agents[0], name: '全新的测试角色' }] } };
    },
  };
  return { calls, dependencies };
}

test('recruitment debug sends real candidate and recycle-bin exclusions and renders the editable naming rule', async () => {
  const state = createInitialState();
  state.agents[0].hired = true;
  state.agents[1].archivedAt = '2026-10-12T00:00:00.000Z';
  const before = structuredClone(state);
  const expected = recruitmentNamesToAvoid(state);
  const catalog = debugCatalog(state);
  assert.deepEqual((catalog.stages.find(stage => stage.id === 'recruiter')!.defaultInput as Record<string, unknown>).existingNamesToAvoid, expected);
  const fixture = captureRecruitment();
  const result = await runDebugCore(state, { stage: 'recruiter', promptId: 'retry.recruit.names', draftOverrides: { 'recruiter.names': '只选不在名单中的新名字。' } }, 'run', 'qa', fixture.dependencies);
  assert.equal(result.status, 'ok');
  assert.deepEqual(fixture.calls[0].input.existingNamesToAvoid, expected);
  assert.equal(fixture.calls[0].input.nameRequirements, '只选不在名单中的新名字。');
  for (const name of expected) assert.ok(String(fixture.calls[0].input.correction).includes(name));
  assert.deepEqual(state, before);
});

test('empty-save recruitment debug does not exclude temporary sandbox sample names', async () => {
  const state = createInitialState(); state.agents = [];
  const fixture = captureRecruitment();
  await runDebugCore(state, { stage: 'recruiter' }, 'run', 'qa', fixture.dependencies);
  assert.deepEqual(fixture.calls[0].input.existingNamesToAvoid, []);
  assert.deepEqual(state.agents, []);
});
