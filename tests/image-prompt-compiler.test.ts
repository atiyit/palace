import test from 'node:test';
import assert from 'node:assert/strict';
import { createImagePromptProfile } from '../lib/image-prompts.ts';
import { compileImagePrompt, withImageConstraints } from '../lib/server/image-prompt-compiler.ts';

test('model-specific instructions and visual brief reach the real compiler separately', async () => {
  const profile = { ...createImagePromptProfile('nai45'), instructions: 'Use compact English and prioritize skin material.', negativePrompt: 'extra fingers' };
  const result = await compileImagePrompt({ prompt: 'soft silicone skin, hands close-up', model: 'nai-diffusion-4-5-full', reference: true, profile, canUseLlm: true }, async (system, input: any) => {
    assert.match(system, /Use compact English and prioritize skin material/);
    assert.equal(input.referenceAttached, true); assert.equal(input.negativePrompt, 'extra fingers');
    assert.equal(input.visualBrief, 'soft silicone skin, hands close-up');
    return { value: { prompt: 'hands close-up, soft silicone skin', negativePrompt: 'extra fingers' } };
  });
  assert.match(result.prompt, /^no text, hands close-up/); assert.match(result.negativePrompt, /extra fingers/); assert.match(result.negativePrompt, /speech bubble/);
});

test('disabled optimization or unavailable text channel uses the prepared template without another request', async () => {
  for (const [llmEnabled, canUseLlm] of [[false, true], [true, false]]) {
    const result = await compileImagePrompt({ prompt: 'CUSTOM prepared once', model: 'other', reference: false, profile: { ...createImagePromptProfile('custom'), llmEnabled }, canUseLlm }, async () => { throw new Error('must not call'); });
    assert.deepEqual(result, { prompt: 'CUSTOM prepared once', negativePrompt: '' });
  }
});

test('custom profiles fully control exclusions on NAI models without preset text guards', async () => {
  for (const model of ['nai-diffusion-5-full', 'nai-diffusion-4-5-full']) {
    for (const negativePrompt of ['', 'bad hands']) {
      const result = await compileImagePrompt({ prompt: 'CUSTOM prepared once', model, reference: false, profile: { ...createImagePromptProfile('custom'), llmEnabled: false, negativePrompt }, canUseLlm: true }, async () => { throw new Error('must not call'); });
      assert.deepEqual(result, { prompt: 'CUSTOM prepared once', negativePrompt });
    }
  }
});

test('custom NAI profiles still protect literal lettering and remove only conflicting text exclusions', async () => {
  const result = await compileImagePrompt({ prompt: 'no text, poster\nText: Welcome', model: 'nai-diffusion-5-full', reference: false, profile: { ...createImagePromptProfile('custom'), llmEnabled: false, negativePrompt: 'text, bad hands, watermark' }, canUseLlm: false }, async () => { throw new Error('must not call'); });
  assert.deepEqual(result, { prompt: 'poster\nText: Welcome', negativePrompt: 'bad hands' });
});

test('explicit lettering survives compilation literally and remains the last section without text suppression', async () => {
  const result = await compileImagePrompt({ prompt: 'poster\nText: PALACE\n欢迎', model: 'nai-diffusion-5-full', reference: false, profile: createImagePromptProfile('nai5'), canUseLlm: true }, async () => ({ value: { prompt: 'no text, colorful poster\nText: WRONG', negativePrompt: 'text, caption, bad anatomy, logo' } }));
  assert.equal(result.prompt, 'colorful poster\nText: PALACE\n欢迎');
  assert.equal(result.negativePrompt, 'bad anatomy');
  assert.ok(withImageConstraints(result.prompt, result.negativePrompt).endsWith('Text: PALACE\n欢迎'));
});

test('ordinary-language lettering requests can become a final Text section without being suppressed', async () => {
  const result = await compileImagePrompt({ prompt: 'A gardener holding a sign with the words Welcome home.', model: 'nai-diffusion-5-full', reference: false, profile: createImagePromptProfile('nai5'), canUseLlm: true }, async system => {
    assert.match(system, /ordinary language without a Text: marker/);
    assert.match(system, /never turn names, biography or conversation metadata into image lettering/);
    return { value: { prompt: 'portrait, green coat, text, english text\nText: Welcome home', negativePrompt: 'text, caption, watermark' } };
  });
  assert.equal(result.prompt, 'portrait, green coat, text, english text\nText: Welcome home');
  assert.equal(result.negativePrompt, '');
});

test('invalid compiler output reports the exact field and does not become an image prompt', async () => {
  for (const value of [{ prompt: '', negativePrompt: '' }, { prompt: 'portrait', negativePrompt: 2 }, { prompt: 'x'.repeat(16001), negativePrompt: '' }, { prompt: 'portrait', negativePrompt: '', secret: true }]) {
    await assert.rejects(compileImagePrompt({ prompt: 'portrait', model: 'model', reference: false, profile: createImagePromptProfile('custom'), canUseLlm: true }, async () => ({ value })), (error: any) => error.code === 'IMAGE_PROMPT_INVALID' && /生图提示词编译失败/.test(error.message));
  }
});

test('natural-language profiles carry their exclusions without NAI tags or protocol parameters', async () => {
  for (const preset of ['gpt-image', 'nano-banana'] as const) {
    const result = await compileImagePrompt({ prompt: 'A still life', model: preset, reference: false, profile: createImagePromptProfile(preset), canUseLlm: true }, async () => ({ value: { prompt: 'A still life on linen', negativePrompt: 'Keep the background empty.' } }));
    assert.equal(withImageConstraints(result.prompt, result.negativePrompt), 'Image constraints / undesired content:\nKeep the background empty.\n\nA still life on linen');
  }
});
