import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../lib/seeds.ts';
import { upgradeAppState } from '../lib/character-profile.ts';
import {
  combineSystemPrompt, getPromptText, listPrompts, MAX_PROMPT_CHARS, MAX_TOTAL_PROMPT_CHARS,
  PROMPT_REGISTRY, validatePromptOverride, validatePromptOverrides,
} from '../lib/prompts.ts';

test('the registry identifies every production prompt stage without duplicate ids', () => {
  const ids = PROMPT_REGISTRY.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    'framework.system', 'actor.system', 'memory.instructions', 'reviewer.system', 'strategy.review',
    'task.instructions', 'recruiter.system', 'recruiter.batch.analysis', 'recruiter.batch.practice',
    'retry.action.schema', 'retry.action.source', 'retry.action.review', 'retry.action.truncated',
    'retry.action.json', 'retry.action.validation', 'retry.recruit.format', 'retry.recruit.schema',
    'retry.recruit.names', 'portrait.template', 'feedback.hire', 'feedback.like', 'feedback.unlike', 'feedback.adopt',
  ]) assert.ok(ids.includes(id), `missing registered prompt ${id}`);
  for (const definition of PROMPT_REGISTRY) {
    assert.ok(definition.title && definition.category && definition.description);
    assert.equal(validatePromptOverride(definition.id, definition.defaultText), definition.defaultText);
  }
});

test('retired portrait placeholders migrate without changing other custom text, variables or stages', () => {
  const original = '  固定文字 adultBasis {{adultBasis}}\n{{appearance}} / {{adultBasis}} 保留 {{traits}}  ';
  const expected = '  固定文字 adultBasis \n{{appearance}} /  保留 {{traits}}  ';
  const overrides = { 'portrait.template': original, 'actor.system': '另一项设置保持原样' };
  const imported = validatePromptOverrides(overrides);
  assert.equal(imported['portrait.template'], expected);
  assert.equal(imported['actor.system'], overrides['actor.system']);
  assert.equal(overrides['portrait.template'], original, 'import normalization must not mutate input');
  assert.equal(getPromptText('portrait.template', overrides, { appearance: '机械结构', traits: '寡言' }), '  固定文字 adultBasis \n机械结构 /  保留 寡言  ');
  assert.equal(listPrompts(overrides).find(item => item.id === 'portrait.template')!.text, expected);
  assert.deepEqual(validatePromptOverrides(imported), imported);
  assert.throws(() => validatePromptOverride('portrait.template', '{{ adultBasis }}'), /不支持的占位符/);
  assert.throws(() => validatePromptOverride('portrait.template', '{{adultBasisExtra}}'), /不支持的占位符/);
  assert.throws(() => validatePromptOverride('portrait.template', '{{adultBasis}} {{password}}'), /不支持的占位符/);
  const state = createInitialState();
  state.promptOverrides = structuredClone(overrides);
  const allOtherState = structuredClone({ ...state, promptOverrides: undefined });
  upgradeAppState(state);
  assert.deepEqual(state.promptOverrides, imported);
  assert.deepEqual({ ...state, promptOverrides: undefined }, allOtherState);
});

test('a legacy template containing only retired tokens resolves to its default, while defaults expose no retired field', () => {
  const originalDefault = PROMPT_REGISTRY.find(item => item.id === 'portrait.template')!;
  assert.equal(validatePromptOverride('portrait.template', ' {{adultBasis}} '), originalDefault.defaultText);
  const state = createInitialState();
  state.promptOverrides = { 'portrait.template': '{{adultBasis}}', 'reviewer.system': '保留审校设置' };
  upgradeAppState(state);
  assert.deepEqual(state.promptOverrides, { 'reviewer.system': '保留审校设置' });
  assert.equal(getPromptText('portrait.template', state.promptOverrides, { age: 'manufactured on 2026-10-12', species: 'synthetic', form: 'mechanical', appearance: 'steel', traits: 'calm' }).includes('2026-10-12'), true);
  for (const prompt of PROMPT_REGISTRY) {
    assert.equal(prompt.variables.includes('adultBasis'), false);
    assert.doesNotMatch(prompt.defaultText, /adultBasis|成年依据|成熟心智依据/);
  }
  const recruiter = getPromptText('recruiter.system');
  assert.match(recruiter, /batch\.totalSlots/);
  assert.match(recruiter, /每次调用的candidates数组始终恰好一人/);
  assert.doesNotMatch(recruiter, /你负责八人招聘|不得八人换名字/);
});

test('editing or resetting an override affects only that stage and never changes another user or a default', () => {
  const defaults = listPrompts();
  const alice = validatePromptOverrides({ 'actor.system': 'Alice 的角色生成器', 'reviewer.system': 'Alice 的审校器' });
  const bob = validatePromptOverrides({ 'actor.system': 'Bob 的独立配置' });
  assert.equal(getPromptText('actor.system', alice), 'Alice 的角色生成器');
  assert.equal(getPromptText('actor.system', bob), 'Bob 的独立配置');
  delete alice['actor.system'];
  assert.equal(getPromptText('actor.system', alice), getPromptText('actor.system'));
  assert.equal(getPromptText('reviewer.system', alice), 'Alice 的审校器');
  assert.equal(getPromptText('actor.system', bob), 'Bob 的独立配置');
  assert.deepEqual(listPrompts(), defaults);
  assert.equal(listPrompts(alice).find(prompt => prompt.id === 'actor.system')?.overridden, false);
  assert.equal(listPrompts(alice).find(prompt => prompt.id === 'reviewer.system')?.overridden, true);
});

test('editable prompt views and validated override records cannot mutate the frozen defaults or their inputs', () => {
  const before = listPrompts();
  const views = listPrompts();
  views[0].defaultText = 'only a local view change';
  views[0].text = 'another local view change';
  views[0].variables.push('unregistered-variable');
  assert.deepEqual(listPrompts(), before);
  assert.ok(Object.isFrozen(PROMPT_REGISTRY));
  for (const definition of PROMPT_REGISTRY) {
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.variables));
  }
  const input = { 'actor.system': 'original user input' };
  const validated = validatePromptOverrides(input);
  validated['actor.system'] = 'local changed value';
  assert.equal(input['actor.system'], 'original user input');
});

test('placeholder interpolation is literal, single-pass and preserves ordinary JSON syntax', () => {
  const nestedJson = '{"candidate":{"content":"ordinary nested JSON"}}';
  assert.equal(validatePromptOverride('actor.system', nestedJson), nestedJson);
  assert.equal(getPromptText('actor.system', { 'actor.system': nestedJson }), nestedJson);
  const untrustedValue = 'literal $& $1 $` $\' {{reason}} {{apiKey}}';
  const overrides = { 'retry.action.validation': 'BEFORE {{reason}} / {{reason}} AFTER' };
  assert.equal(getPromptText('retry.action.validation', overrides, { reason: untrustedValue }), `BEFORE ${untrustedValue} / ${untrustedValue} AFTER`);
  const content = { text: '{{not_a_second_template}}', quotes: '"value"', nested: { n: 1 } };
  assert.equal(getPromptText('retry.action.validation', { 'retry.action.validation': '{{reason}}' }, { reason: content }), JSON.stringify(content));
});

test('unknown or incomplete placeholders and missing required values are rejected', () => {
  assert.throws(() => validatePromptOverride('unknown.prompt', 'value'));
  assert.throws(() => validatePromptOverride('actor.system', 'Inject {{apiKey}}'));
  assert.throws(() => validatePromptOverride('portrait.template', 'Unexpected {{password}}'));
  assert.throws(() => validatePromptOverride('portrait.template', 'Unclosed {{appearance'));
  assert.throws(() => getPromptText('portrait.template', {}, { age: 29, appearance: 'fixed adult face' }));
  const custom = { 'portrait.template': '{{appearance}}, age {{age}}, {{traits}}' };
  assert.equal(getPromptText('portrait.template', custom, { age: 29, appearance: 'adult woman', traits: ['calm', 'precise'] }), 'adult woman, age 29, ["calm","precise"]');
});

test('prompt validation preserves intentional spacing but bounds per-slot and total override size', () => {
  const spaced = '  First line\nSecond line  ';
  assert.equal(validatePromptOverride('actor.system', spaced), spaced);
  for (const invalid of ['', '  \n ', 'bad\0text', 'a'.repeat(MAX_PROMPT_CHARS + 1)]) {
    assert.throws(() => validatePromptOverride('actor.system', invalid));
  }
  const ids = ['framework.system', 'actor.system', 'reviewer.system', 'memory.instructions', 'task.instructions'];
  const full = Object.fromEntries(ids.map(id => [id, 'a'.repeat(MAX_PROMPT_CHARS)]));
  assert.equal(Object.values(validatePromptOverrides(full)).reduce((total, value) => total + value.length, 0), MAX_TOTAL_PROMPT_CHARS);
  assert.throws(() => validatePromptOverrides({ ...full, 'feedback.hire': 'one extra prompt' }));
});

test('system composition applies global, actor-memory and strategy-review dependencies in order', () => {
  const overrides = {
    'framework.system': 'GLOBAL', 'actor.system': 'ACTOR', 'memory.instructions': 'MEMORY',
    'reviewer.system': 'REVIEW', 'strategy.review': 'STRATEGY', 'recruiter.system': 'RECRUIT', 'user.context': 'USER CONTEXT',
  };
  assert.equal(combineSystemPrompt('framework.system', overrides), 'GLOBAL');
  assert.equal(combineSystemPrompt('actor.system', overrides), 'GLOBAL\n\nACTOR\n\nMEMORY\n\nUSER CONTEXT');
  assert.equal(combineSystemPrompt('reviewer.system', overrides), 'GLOBAL\n\nREVIEW\n\nUSER CONTEXT');
  assert.equal(combineSystemPrompt('strategy.review', overrides), 'GLOBAL\n\nREVIEW\n\nSTRATEGY\n\nUSER CONTEXT');
  assert.equal(combineSystemPrompt('recruiter.system', overrides), 'GLOBAL\n\nRECRUIT\n\nUSER CONTEXT');
  assert.throws(() => combineSystemPrompt('unknown.stage', overrides));
});

test('recruiter schema corrections include concrete diagnostics while old saved overrides remain compatible', () => {
  const reason = 'candidates.0.bio: String must contain at least 100 character(s)';
  const template = listPrompts().find(item => item.id === 'retry.recruit.schema')!;
  assert.deepEqual(template.variables, ['reason']);
  assert.ok(getPromptText(template.id, {}, { reason }).includes(reason));
  const oldOverrides = validatePromptOverrides({ [template.id]: '原有自定义纠正规则，不包含占位符。' });
  assert.equal(getPromptText(template.id, oldOverrides, { reason }), oldOverrides[template.id]);
});
