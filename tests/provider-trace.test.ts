import test from 'node:test';
import assert from 'node:assert/strict';
import { beginProviderTrace, updateProviderTrace, withProviderTrace, PreviewHalt, redactDebugValue, markLastTraceValidation } from '../lib/server/provider-trace.ts';

test('preview captures the assembled request and halts before the provider operation', async () => {
  let called = false;
  const result = await withProviderTrace(true, async () => {
    beginProviderTrace({ kind: 'text', model: 'example', endpoint: 'https://model.example/v1/chat/completions', messages: [{ role: 'system', content: '框架规则' }, { role: 'user', content: '{"message":"草稿"}' }] });
    called = true;
  });
  assert.equal(called, false);
  assert(result.error instanceof PreviewHalt);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].status, 'preview');
  assert.equal(result.trace[0].messages?.[1].content, '{"message":"草稿"}');
});

test('trace preserves failed raw model output and redacts actual credential values', async () => {
  const secret = 'qa-credential-that-must-not-appear';
  const raw = '{"answer":"unfinished';
  const result = await withProviderTrace(false, async () => {
    const entry = beginProviderTrace({ kind: 'text', model: 'example', endpoint: 'https://model.example/v1/chat/completions', messages: [{ role: 'user', content: `Accidental value: ${secret}` }] }, secret);
    updateProviderTrace(entry, { raw, tokens: 89, finishReason: 'length' });
    updateProviderTrace(entry, { parsed: { nested: { accidental: secret } }, error: `Failed: ${secret}`, status: 'error', elapsedMs: 25 });
    throw new Error('parse failed');
  });
  assert.equal(result.trace[0].raw, raw);
  assert.equal(result.trace[0].finishReason, 'length');
  assert.equal(result.trace[0].tokens, 89);
  assert.equal(result.trace[0].status, 'error');
  assert.equal(JSON.stringify(result.trace).includes(secret), false);
  assert(JSON.stringify(result.trace).includes('[REDACTED]'));
});

test('concurrent debug requests cannot see one another’s trace or overwrite it', async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const first = withProviderTrace(false, async () => {
    const entry = beginProviderTrace({ kind: 'text', model: 'one', endpoint: 'https://one.example/v1/chat/completions', messages: [{ role: 'user', content: 'private-one' }] });
    await hold;
    updateProviderTrace(entry, { status: 'ok', raw: '{"one":true}' });
  });
  const second = await withProviderTrace(false, async () => {
    const entry = beginProviderTrace({ kind: 'text', model: 'two', endpoint: 'https://two.example/v1/chat/completions', messages: [{ role: 'user', content: 'private-two' }] });
    updateProviderTrace(entry, { status: 'ok', raw: '{"two":true}' });
  });
  release();
  const one = await first;
  assert.equal(one.trace.length, 1);
  assert.equal(second.trace.length, 1);
  assert.equal(one.trace[0].model, 'one');
  assert.equal(second.trace[0].model, 'two');
  assert.equal(JSON.stringify(one.trace).includes('private-two'), false);
  assert.equal(beginProviderTrace({ kind: 'text', model: 'none', endpoint: 'https://none.example' }), undefined);
});

test('whole-result redaction covers nested final outputs and both provider channels without mutation', () => {
  const textKey = 'qa-text-secret', imageKey = 'qa-image-secret';
  const source = { output: { reply: { content: textKey }, items: [imageKey, { [textKey]: imageKey }] }, error: imageKey, persisted: false };
  const clean = redactDebugValue(source, [textKey, imageKey]);
  assert(!JSON.stringify(clean).includes(textKey));
  assert(!JSON.stringify(clean).includes(imageKey));
  assert.equal(clean.persisted, false);
  assert.equal(source.output.reply.content, textKey);
});

test('application-level rejection remains visible even when model output was valid JSON', async () => {
  const result = await withProviderTrace(false, async () => {
    const actor = beginProviderTrace({ kind: 'text', model: 'example', endpoint: 'https://model.example' });
    updateProviderTrace(actor, { status: 'ok', parsed: { kind: 'submit', content: '草案' } });
    const reviewer = beginProviderTrace({ kind: 'text', model: 'example', endpoint: 'https://model.example' });
    updateProviderTrace(reviewer, { status: 'ok', parsed: { pass: false, reason: '超出能力' } });
    markLastTraceValidation('人设审查', '超出能力');
  });
  assert.equal(result.trace[0].status, 'ok');
  assert.equal(result.trace[1].status, 'error');
  assert.equal(result.trace[1].error, '人设审查：超出能力');
  assert.deepEqual(result.trace[1].parsed, { pass: false, reason: '超出能力' });
});
