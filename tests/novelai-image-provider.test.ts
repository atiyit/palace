import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { strToU8, zipSync } from "fflate";
import { PalaceError } from "../lib/server/errors.ts";
import { generateReferenceImage, MAX_NATIVE_IMAGE_BYTES, MAX_NATIVE_RESPONSE_BYTES } from "../lib/server/novelai-image-provider.ts";
import { PreviewHalt, withProviderTrace } from "../lib/server/provider-trace.ts";
import type { PortraitReference } from "../lib/server/portrait-reference.ts";

const config = { baseUrl: "https://gateway.example.test/proxy/v1", model: "nai-diffusion-5-full", apiKey: "reference-provider-unit-test-key" };
const errorCode = (code: string) => (error: unknown) => error instanceof PalaceError && error.code === code;
async function fixture(): Promise<PortraitReference> {
  return {
    bytes: await sharp({ create: { width: 32, height: 48, channels: 3, background: "#ffaa99" } }).png().toBuffer(),
    contentType: "image/png",
    sourceUrl: "/api/portraits/fixture-character?v=current-avatar",
  };
}
type FetchCall = { url: RequestInfo | URL; init?: RequestInit };
async function mockedFetch<T>(handler: (call: FetchCall) => Response | Promise<Response>, run: (calls: FetchCall[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = async (url, init) => { const call = { url, init }; calls.push(call); return handler(call); };
  try { return await run(calls); } finally { globalThis.fetch = original; }
}
function zipResponse(bytes: Uint8Array): Response { return new Response(bytes as BodyInit, { headers: { "Content-Type": "binary/octet-stream" } }); }

test("reference provider makes one native ZIP request and traces metadata without image data or secrets", async () => {
  const reference = await fixture();
  const archive = zipSync({ "image_0.png": reference.bytes, "metadata.json": strToU8('{"seed":123}') });
  await mockedFetch(() => zipResponse(archive), async calls => {
    const result = await withProviderTrace(false, () => generateReferenceImage(config, `portrait ${config.apiKey}`, reference));
    assert.equal(result.error, undefined);
    assert.equal(result.value?.contentType, "image/png");
    assert.deepEqual(result.value?.bytes, new Uint8Array(reference.bytes));
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.url, "https://gateway.example.test/proxy/ai/generate-image");
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.redirect, "manual");
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("Accept"), "application/zip");
    assert.equal(headers.get("Authorization"), `Bearer ${config.apiKey}`);
    assert.ok(call.init?.signal instanceof AbortSignal);
    const sent = JSON.parse(String(call.init?.body));
    assert.equal(sent.model, "nai-diffusion-4-5-full");
    assert.equal(sent.parameters.prompt, sent.input);
    assert.match(sent.input, /^no text,/);
    assert.match(sent.parameters.uc, /speech bubble/);
    assert.match(sent.parameters.uc, /watermark/);
    assert.equal(sent.parameters.negative_prompt, sent.parameters.uc);
    assert.equal(sent.parameters.v4_negative_prompt.caption.base_caption, sent.parameters.uc);
    assert.equal(sent.parameters.qualityToggle, false);
    assert.equal(sent.parameters.add_original_image, false);
    assert.equal(sent.parameters.director_reference_images.length, 1);
    assert.equal(result.trace.length, 1);
    assert.equal(result.trace[0].model, sent.model);
    assert.equal(result.trace[0].endpoint, call.url);
    assert.equal(result.trace[0].status, "ok");
    assert.equal(result.trace[0].prompt, sent.input.replaceAll(config.apiKey, '[REDACTED]'));
    assert.equal(result.trace[0].negativePrompt, sent.parameters.uc);
    assert.deepEqual(result.trace[0].reference, { sourceUrl: reference.sourceUrl, mode: "character", strength: 1, fidelity: 0.5, width: 1024, height: 1536 });
    const traceText = JSON.stringify(result.trace);
    assert.ok(!traceText.includes(config.apiKey));
    assert.ok(!traceText.includes(sent.parameters.director_reference_images[0]));
    assert.ok(!traceText.includes(Buffer.from(reference.bytes).toString("base64")));
    assert.ok(!traceText.includes("director_reference_images"));
  });
});

test("normal native and OpenAI-compatible JSON image responses remain accepted", async () => {
  const reference = await fixture();
  const encoded = Buffer.from(reference.bytes).toString("base64");
  for (const payload of [{ images: [{ image: encoded, index: 0, seed: 123 }] }, { data: [{ b64_json: encoded }] }]) {
    await mockedFetch(() => Response.json(payload), async calls => {
      const image = await generateReferenceImage(config, "portrait", reference);
      assert.equal(image.contentType, "image/png");
      assert.deepEqual(image.bytes, reference.bytes);
      assert.equal(calls.length, 1);
    });
  }
});

test("ZIP result content type comes from PNG, JPEG or WebP bytes rather than its filename", async () => {
  const reference = await fixture();
  for (const format of ["jpeg", "webp"] as const) {
    const bytes = await sharp(reference.bytes).toFormat(format).toBuffer();
    await mockedFetch(() => zipResponse(zipSync({ "image_0.png": bytes })), async calls => {
      const image = await generateReferenceImage(config, "portrait", reference);
      assert.equal(image.contentType, `image/${format}`);
      assert.deepEqual(image.bytes, new Uint8Array(bytes));
      assert.equal(calls.length, 1);
    });
  }
});

test("HTTP 200 error envelopes fail without leaking the gateway body or trying text-only generation", async () => {
  const reference = await fixture();
  const privateBody = `upstream body ${config.apiKey} private-base64-payload`;
  await mockedFetch(() => Response.json({ error: { code: "bad_response", message: privateBody } }), async calls => {
    const result = await withProviderTrace(false, () => generateReferenceImage(config, "portrait", reference));
    assert.ok(errorCode("IMAGE_REFERENCE_PROVIDER")(result.error));
    assert.equal(calls.length, 1);
    assert.equal(result.trace[0].status, "error");
    assert.ok(!JSON.stringify(result.trace).includes(privateBody));
    assert.ok(!String(result.error).includes("private-base64-payload"));
  });
});

test("HTTP auth, quota and gateway failures retain safe provider errors and never retry", async () => {
  const reference = await fixture();
  for (const [status, payload, expectedCode] of [
    [401, { error: { message: "secret upstream auth details" } }, "PROVIDER_ERROR"],
    [402, { error: { code: "insufficient_quota", message: "secret balance" } }, "PROVIDER_QUOTA"],
    [429, { error: { message: "limited" } }, "PROVIDER_ERROR"],
    [500, { error: { message: "secret server stack" } }, "PROVIDER_ERROR"],
    [200, { error: { code: "insufficient_quota" } }, "PROVIDER_QUOTA"],
  ] as const) {
    await mockedFetch(() => Response.json(payload, { status }), async calls => {
      await assert.rejects(generateReferenceImage(config, "portrait", reference), errorCode(expectedCode));
      assert.equal(calls.length, 1);
    });
  }
  await mockedFetch(() => new Response("", { status: 302, headers: { Location: "https://other.example.test/steal-key" } }), async calls => {
    await assert.rejects(generateReferenceImage(config, "portrait", reference), errorCode("PROVIDER_ERROR"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.redirect, "manual");
  });
});

test("preview halts after recording actual model and reference metadata with zero requests", async () => {
  const reference = await fixture();
  await mockedFetch(() => { throw new Error("preview must not send HTTP"); }, async calls => {
    const result = await withProviderTrace(true, () => generateReferenceImage({ ...config, apiKey: "" }, "preview portrait", reference));
    assert.ok(result.error instanceof PreviewHalt);
    assert.equal(calls.length, 0);
    assert.equal(result.trace[0].status, "preview");
    assert.equal(result.trace[0].model, "nai-diffusion-4-5-full");
    assert.equal(result.trace[0].reference?.sourceUrl, reference.sourceUrl);
    assert.equal(result.trace[0].prompt, "no text, preview portrait");
    assert.match(result.trace[0].negativePrompt || '', /speech bubble/);
    assert.ok(!JSON.stringify(result.trace).includes("base64"));
  });
});

test('local native reference services can omit authentication without forwarding a blank bearer token', async () => {
  const reference = await fixture();
  await mockedFetch(() => zipResponse(zipSync({ 'image_0.png': reference.bytes })), async calls => {
    const result = await generateReferenceImage({ ...config, baseUrl: 'http://localhost:1234/v1', local: true, apiKey: '' }, 'local reference', reference);
    assert.equal(result.contentType, 'image/png'); assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://localhost:1234/ai/generate-image');
    assert.equal(new Headers(calls[0].init?.headers).has('Authorization'), false);
  });
});

test("response size is bounded both by declared length and streaming bytes", async () => {
  const reference = await fixture();
  let headerCancelled = false;
  await mockedFetch(() => new Response(new ReadableStream({ cancel() { headerCancelled = true; } }), {
    headers: { "Content-Length": String(MAX_NATIVE_RESPONSE_BYTES + 1) },
  }), async calls => {
    await assert.rejects(generateReferenceImage(config, "portrait", reference), errorCode("IMAGE_FORMAT"));
    assert.equal(calls.length, 1);
    assert.equal(headerCancelled, true);
  });
  let streamCancelled = false;
  let chunk = 0;
  const halfLimit = new Uint8Array(MAX_NATIVE_RESPONSE_BYTES / 2);
  await mockedFetch(() => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(chunk++ < 2 ? halfLimit : Uint8Array.of(0)); },
    cancel() { streamCancelled = true; },
  })), async calls => {
    await assert.rejects(generateReferenceImage(config, "portrait", reference), errorCode("IMAGE_FORMAT"));
    assert.equal(calls.length, 1);
    assert.equal(streamCancelled, true);
  });
});

function patchDeclaredZipSizes(archive: Uint8Array, sizes: number[]): Uint8Array {
  const bytes = archive.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let count = 0;
  for (let offset = 0; offset + 28 < bytes.length; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50 && count < sizes.length) view.setUint32(offset + 24, sizes[count++], true);
  }
  assert.equal(count, sizes.length);
  return bytes;
}

test("ZIP rejects single-file and combined decompression limits before allocating inflated content", async () => {
  const reference = await fixture();
  const one = patchDeclaredZipSizes(zipSync({ "image_0.png": reference.bytes }), [MAX_NATIVE_IMAGE_BYTES + 1]);
  const combined = patchDeclaredZipSizes(zipSync({ "image_0.png": reference.bytes, "metadata.txt": strToU8("safe") }), [MAX_NATIVE_IMAGE_BYTES, 1]);
  for (const archive of [one, combined]) {
    await mockedFetch(() => zipResponse(archive), async calls => {
      await assert.rejects(generateReferenceImage(config, "portrait", reference), errorCode("IMAGE_FORMAT"));
      assert.equal(calls.length, 1);
    });
  }
});

test("corrupt ZIP, missing image, multiple images and invalid JSON image bytes are rejected", async () => {
  const reference = await fixture();
  for (const archive of [
    Uint8Array.of(80, 75, 3, 4, 0, 0),
    zipSync({ "metadata.txt": strToU8("no image") }),
    zipSync({ "image_0.png": reference.bytes, "image_1.png": reference.bytes }),
    zipSync({ "image_0.png": strToU8("this is not an image") }),
  ]) {
    await mockedFetch(() => zipResponse(archive), async calls => {
      await assert.rejects(generateReferenceImage(config, "portrait", reference), errorCode("IMAGE_FORMAT"));
      assert.equal(calls.length, 1);
    });
  }
  for (const payload of [{ images: [] }, { images: [{ image: "not base64" }] }, { data: [{ b64_json: "dGV4dA==" }] }]) {
    await mockedFetch(() => Response.json(payload), async calls => {
      await assert.rejects(generateReferenceImage(config, "portrait", reference), errorCode("IMAGE_FORMAT"));
      assert.equal(calls.length, 1);
    });
  }
});

test("network failure and unsupported model never trigger another generation call", async () => {
  const reference = await fixture();
  await mockedFetch(() => { throw new Error(`network diagnostic ${config.apiKey}`); }, async calls => {
    await assert.rejects(generateReferenceImage(config, "portrait", reference), errorCode("IMAGE_REFERENCE_PROVIDER"));
    assert.equal(calls.length, 1);
  });
  await mockedFetch(() => { throw new Error("unsupported model must stop before fetch"); }, async calls => {
    await assert.rejects(generateReferenceImage({ ...config, model: "other-model" }, "portrait", reference), errorCode("IMAGE_REFERENCE_UNSUPPORTED"));
    assert.equal(calls.length, 0);
  });
});

test("the 150-second deadline aborts the single request and returns a timeout", async () => {
  const reference = await fixture();
  const originalTimer = globalThis.setTimeout;
  const seenTimeouts: number[] = [];
  await mockedFetch(call => new Promise<Response>((_resolve, reject) => {
    call.init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }), async calls => {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      seenTimeouts.push(ms || 0);
      return originalTimer(callback, ms === 150_000 ? 0 : ms, ...args);
    }) as typeof setTimeout;
    try { await assert.rejects(generateReferenceImage(config, "portrait", reference), errorCode("PROVIDER_TIMEOUT")); }
    finally { globalThis.setTimeout = originalTimer; }
    assert.ok(seenTimeouts.includes(150_000));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init?.signal?.aborted, true);
  });
});
