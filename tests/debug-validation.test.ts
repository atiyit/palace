import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../lib/seeds.ts';
import { contentValidationOptions, contentValidationPolicy } from '../lib/debug-validation.ts';
import { debugCatalog, runDebugCore, type DebugDependencies } from '../lib/server/debug-core.ts';
import { beginProviderTrace, updateProviderTrace } from '../lib/server/provider-trace.ts';

function compactCandidate() {
  const candidate = createInitialState().agents[0];
  candidate.age = 18; candidate.bio = '简短的人物背景';
  candidate.traits = ['独立']; candidate.values = ['诚实']; candidate.boundaries = ['不造假'];
  for (const [key, value] of Object.entries(candidate.profile)) Reflect.set(candidate.profile, key, Array.isArray(value) ? ['一个条目'] : '简短描述');
  for (const key of Object.keys(candidate.skills)) Reflect.set(candidate.skills, key, 100);
  return candidate;
}

function provider(value: unknown) {
  const inputs: Record<string, unknown>[] = [];
  const dependencies: DebugDependencies = {
    loadReference: async () => { throw new Error('No image references in this test'); },
    imageReady: () => false, getEffectiveProvider: () => ({ apiKey: '' }),
    generatePortrait: async () => { throw new Error('Images are not part of this test'); },
    performAction: async () => { throw new Error('A single stage must not mutate stored agents'); },
    completeJson: async (system, input) => {
      const trace = beginProviderTrace({ kind: 'text', model: 'test', endpoint: 'https://fixture.invalid', messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }] });
      inputs.push(input as Record<string, unknown>);
      updateProviderTrace(trace, { status: 'ok', parsed: value });
      return { value };
    },
  };
  return { inputs, dependencies };
}

test('old saves default to enabled and debug catalog exposes the current policy', () => {
  const state = createInitialState();
  assert.deepEqual(contentValidationOptions(state), { contentRulesEnabled: true });
  assert.deepEqual(debugCatalog(state).validation, { contentRulesEnabled: true });
  state.debugOptions = { contentRulesEnabled: false };
  const catalog = debugCatalog(state);
  assert.equal(catalog.validation.contentRulesEnabled, false);
  for (const stage of catalog.stages.filter(item => item.kind === 'text')) {
    assert.deepEqual((stage.defaultInput as Record<string, unknown>).validationPolicy, contentValidationPolicy(state));
  }
});

test('single recruitment sandbox uses the saved switch, reports strict errors and preserves state', async () => {
  const candidate = compactCandidate();
  const state = createInitialState();
  const strict = provider({ candidates: [candidate] });
  const rejected = await runDebugCore(state, { stage: 'recruiter', input: { validationPolicy: { contentRulesEnabled: false } } }, 'run', 'qa', strict.dependencies);
  assert.equal(rejected.status, 'error'); assert.match(rejected.error!, /bio/);
  assert.equal(rejected.trace[0].status, 'error');
  assert.equal((strict.inputs[0].validationPolicy as { contentRulesEnabled: boolean }).contentRulesEnabled, true);
  state.debugOptions = { contentRulesEnabled: false };
  const before = structuredClone(state);
  const relaxed = provider({ candidates: [candidate] });
  const accepted = await runDebugCore(state, { stage: 'recruiter', input: { validationPolicy: { contentRulesEnabled: true } } }, 'run', 'qa', relaxed.dependencies);
  assert.equal(accepted.status, 'ok'); assert.equal(accepted.persisted, false);
  assert.equal((relaxed.inputs[0].validationPolicy as { contentRulesEnabled: boolean }).contentRulesEnabled, false);
  assert.deepEqual(state, before);
});

test('profile sandbox follows the same switch while malformed recruitment values still fail', async () => {
  const candidate = compactCandidate(); const state = createInitialState();
  const profile = provider({ species: candidate.species, profile: candidate.profile });
  const rejected = await runDebugCore(state, { stage: 'profile' }, 'run', 'qa', profile.dependencies);
  assert.equal(rejected.status, 'error');
  state.debugOptions = { contentRulesEnabled: false };
  const accepted = await runDebugCore(state, { stage: 'profile' }, 'run', 'qa', profile.dependencies);
  assert.equal(accepted.status, 'ok');
  const malformed = provider({ candidates: [{ ...candidate, age: '18' }] });
  const invalid = await runDebugCore(state, { stage: 'recruiter' }, 'run', 'qa', malformed.dependencies);
  assert.equal(invalid.status, 'error'); assert.match(invalid.error!, /age: 需要数值/);
});

test('age-only recruitment errors disappear with the switch disabled on either side of the default range', async () => {
  for (const age of [18, 10001]) {
    const candidate = createInitialState().agents[0]; candidate.age = age;
    const state = createInitialState(); const fixture = provider({ candidates: [candidate] });
    const rejected = await runDebugCore(state, { stage: 'recruiter' }, 'run', 'qa', fixture.dependencies);
    assert.equal(rejected.status, 'error'); assert.match(rejected.error!, /candidates\.0\.age/);
    state.debugOptions = { contentRulesEnabled: false };
    const accepted = await runDebugCore(state, { stage: 'recruiter' }, 'run', 'qa', fixture.dependencies);
    assert.equal(accepted.status, 'ok');
  }
});
