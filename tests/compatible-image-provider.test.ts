import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { generateCompatibleReferenceImage, MAX_COMPATIBLE_RESPONSE_BYTES, isGptImageModel } from '../lib/server/compatible-image-provider.ts';
import { PreviewHalt, withProviderTrace } from '../lib/server/provider-trace.ts';
import { PalaceError } from '../lib/server/errors.ts';
import type { PortraitReference } from '../lib/server/portrait-reference.ts';

const config = { baseUrl: 'https://image.example.test/proxy/v1', model: 'gpt-image-1', apiKey: 'compatible-image-unit-test-secret' };
const code = (expected: string) => (error: unknown) => error instanceof PalaceError && error.code === expected;
const fixture = async (): Promise<PortraitReference> => ({ bytes: await sharp({ create: { width: 20, height: 30, channels: 3, background: '#CC5577' } }).png().toBuffer(), contentType: 'image/png', sourceUrl: '/api/portraits/fixture?version=1' });
type Call = { url: string; init?: RequestInit };
async function mock<T>(handler: (call: Call) => Response | Promise<Response>, run: (calls: Call[]) => Promise<T>) {
  const old = globalThis.fetch; const calls: Call[] = [];
  globalThis.fetch = async (url, init) => { const call = { url: String(url), init }; calls.push(call); return handler(call); };
  try { return await run(calls); } finally { globalThis.fetch = old; }
}

test('GPT reference editing uploads actual avatar pixels as multipart and preserves the explicit model', async () => {
  const reference = await fixture();
  await mock(() => Response.json({ data: [{ b64_json: Buffer.from(reference.bytes).toString('base64') }] }), async calls => {
    const outcome = await withProviderTrace(false, () => generateCompatibleReferenceImage(config, `same character ${config.apiKey}`, reference));
    assert.equal(outcome.error, undefined); assert.deepEqual(outcome.value!.bytes, new Uint8Array(reference.bytes)); assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://image.example.test/proxy/v1/images/edits');
    assert.equal(calls[0].init!.redirect, 'manual'); assert.ok(calls[0].init!.signal instanceof AbortSignal);
    const headers = new Headers(calls[0].init!.headers); assert.equal(headers.get('authorization'), `Bearer ${config.apiKey}`); assert.equal(headers.has('content-type'), false, 'fetch supplies the multipart boundary');
    const form = calls[0].init!.body as FormData; assert.ok(form instanceof FormData);
    assert.equal(form.get('model'), 'gpt-image-1'); assert.equal(form.get('input_fidelity'), 'high'); assert.equal(form.get('response_format'), null); assert.equal(form.get('output_format'), 'png'); assert.equal(form.get('n'), '1');
    const upload = form.get('image') as File; assert.equal(upload.name, 'character-reference.png'); assert.equal(upload.type, 'image/png');
    const pixels = new Uint8Array(await upload.arrayBuffer());
    assert.deepEqual(await sharp(pixels).raw().toBuffer(), await sharp(reference.bytes).raw().toBuffer());
    assert.equal(outcome.trace[0].model, config.model); assert.equal(outcome.trace[0].reference!.width, 20); assert.equal(outcome.trace[0].reference!.height, 30);
    assert.equal(JSON.stringify(outcome.trace).includes(config.apiKey), false); assert.equal(JSON.stringify(outcome.trace).includes(Buffer.from(pixels).toString('base64')), false);
  });
});

test('other explicit compatible reference models retain their name and do not receive GPT-only parameters', async () => {
  const reference = await fixture();
  for (const model of ['custom-reference-model', 'nai-diffusion-5-full', 'gpt-image-1-mini', 'gpt-image-2']) {
    await mock(() => Response.json({ data: [{ b64_json: Buffer.from(reference.bytes).toString('base64') }] }), async calls => {
      await generateCompatibleReferenceImage({ ...config, model }, 'reference', reference);
      const form = calls[0].init!.body as FormData; assert.equal(form.get('model'), model); assert.equal(form.get('input_fidelity'), null);
      assert.equal(form.get('response_format'), isGptImageModel(model) ? null : 'b64_json'); assert.equal(calls.length, 1);
    });
  }
});

test('compatible preview records routing but never sends the reference or API key to a provider', async () => {
  const reference = await fixture();
  await mock(() => { throw new Error('preview fetch forbidden'); }, async calls => {
    const result = await withProviderTrace(true, () => generateCompatibleReferenceImage({ ...config, apiKey: '' }, 'preview', reference));
    assert.ok(result.error instanceof PreviewHalt); assert.equal(calls.length, 0); assert.equal(result.trace[0].status, 'preview'); assert.match(result.trace[0].endpoint, /\/images\/edits$/);
  });
});

test('malformed avatars fail before any network call and are never replaced by a text-only request', async () => {
  const reference = await fixture();
  for (const invalid of [{ ...reference, bytes: new Uint8Array() }, { ...reference, contentType: 'image/jpeg' }, { ...reference, bytes: new Uint8Array(10 * 1024 * 1024 + 1) }]) {
    await mock(() => { throw new Error('invalid reference fetch forbidden'); }, async calls => {
      await assert.rejects(generateCompatibleReferenceImage(config, 'portrait', invalid), code('IMAGE_REFERENCE_INVALID')); assert.equal(calls.length, 0);
    });
  }
});

test('reference errors, provider redirects, URL-only and malformed responses never fall back to another request', async () => {
  const reference = await fixture();
  for (const [status, body, expected] of [
    [200, { error: { message: `private ${config.apiKey}` } }, 'IMAGE_REFERENCE_PROVIDER'],
    [200, { error: { code: 'insufficient_quota' } }, 'PROVIDER_QUOTA'],
    [401, { error: 'private key diagnostic' }, 'PROVIDER_ERROR'],
    [200, { data: [{ url: 'https://other.example.test/download' }] }, 'IMAGE_FORMAT'],
    [200, { data: [{ b64_json: 'not-base64' }] }, 'IMAGE_FORMAT'],
    [200, { data: [{ b64_json: 'dGV4dA==' }] }, 'IMAGE_FORMAT'],
  ] as const) {
    await mock(() => Response.json(body, { status }), async calls => {
      const result = await withProviderTrace(false, () => generateCompatibleReferenceImage(config, 'portrait', reference));
      assert.ok(code(expected)(result.error)); assert.equal(calls.length, 1); assert.equal(JSON.stringify(result.trace).includes(config.apiKey), false); assert.equal(String(result.error).includes('private'), false);
    });
  }
  await mock(() => new Response('', { status: 302, headers: { Location: 'https://elsewhere.example.test' } }), async calls => {
    await assert.rejects(generateCompatibleReferenceImage(config, 'portrait', reference), code('PROVIDER_ERROR')); assert.equal(calls.length, 1);
  });
});

test('large streaming reference responses are cancelled before unbounded allocation', async () => {
  const reference = await fixture(); let cancelled = false;
  await mock(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(MAX_COMPATIBLE_RESPONSE_BYTES + 1) } }), async calls => {
    await assert.rejects(generateCompatibleReferenceImage(config, 'portrait', reference), code('IMAGE_FORMAT')); assert.equal(calls.length, 1); assert.equal(cancelled, true);
  });
  let parts = 0, streamCancelled = false; const chunk = new Uint8Array(MAX_COMPATIBLE_RESPONSE_BYTES / 2);
  await mock(() => new Response(new ReadableStream({ pull(controller) { controller.enqueue(parts++ < 2 ? chunk : Uint8Array.of(1)); }, cancel() { streamCancelled = true; } })), async calls => {
    await assert.rejects(generateCompatibleReferenceImage(config, 'portrait', reference), code('IMAGE_FORMAT')); assert.equal(calls.length, 1); assert.equal(streamCancelled, true);
  });
});

test('transport errors never expose upstream secrets and stop after one reference request', async () => {
  const reference = await fixture();
  await mock(() => { throw new Error(config.apiKey); }, async calls => {
    const result = await withProviderTrace(false, () => generateCompatibleReferenceImage(config, 'portrait', reference)); assert.ok(code('IMAGE_REFERENCE_PROVIDER')(result.error));
    assert.equal(calls.length, 1); assert.equal(JSON.stringify(result.trace).includes(config.apiKey), false);
  });
});

test('explicit local reference services accept no key and never receive an empty Authorization header', async () => {
  const reference = await fixture();
  await mock(() => Response.json({ data: [{ b64_json: Buffer.from(reference.bytes).toString('base64') }] }), async calls => {
    const result = await generateCompatibleReferenceImage({ ...config, baseUrl: 'http://127.0.0.1:1234/v1', local: true, apiKey: '' }, 'local reference', reference);
    assert.equal(result.contentType, 'image/png'); assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/images/edits');
    assert.equal(new Headers(calls[0].init!.headers).has('Authorization'), false);
  });
  await mock(() => { throw new Error('not explicitly local'); }, async calls => {
    await assert.rejects(generateCompatibleReferenceImage({ ...config, baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '' }, 'local reference', reference), code('INVALID_PROVIDER_SETTINGS'));
    assert.equal(calls.length, 0);
  });
});
