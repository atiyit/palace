import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { PalaceError } from "../lib/server/errors.ts";
import {
  buildCharacterReferenceRequest,
  characterReferenceEndpoint,
  characterReferenceModel,
  MAX_REFERENCE_PIXELS,
} from "../lib/server/novelai-reference.ts";
import type { PortraitReference } from "../lib/server/portrait-reference.ts";

const errorCode = (code: string) => (error: unknown) => error instanceof PalaceError && error.code === code;
const sourceUrl = "/api/portraits/fixture-character?v=avatar-version";
async function portrait(width = 80, height = 160): Promise<PortraitReference> {
  const bytes = await sharp({ create: { width, height, channels: 3, background: "#ff0000" } }).png().toBuffer();
  return { bytes, contentType: "image/png", sourceUrl };
}

test("Precise Reference maps V5 to the matching V4.5 family and rejects unsupported models", () => {
  assert.equal(characterReferenceModel("nai-diffusion-5-full"), "nai-diffusion-4-5-full");
  assert.equal(characterReferenceModel("nai-diffusion-5-curated"), "nai-diffusion-4-5-curated");
  assert.equal(characterReferenceModel("nai-diffusion-4-5-full"), "nai-diffusion-4-5-full");
  assert.equal(characterReferenceModel("nai-diffusion-4-5-curated"), "nai-diffusion-4-5-curated");
  for (const model of ["", "nai-diffusion-3", "nai-diffusion-5-full-inpainting", "gpt-image-1", "custom-nai-diffusion-5-full"]) {
    assert.throws(() => characterReferenceModel(model), errorCode("IMAGE_REFERENCE_UNSUPPORTED"));
  }
});

test("native image endpoint strips only the final v1 and preserves origin, port and proxy prefix", () => {
  assert.equal(characterReferenceEndpoint("https://api.example.com/v1"), "https://api.example.com/ai/generate-image");
  assert.equal(characterReferenceEndpoint("https://image.novelai.net/"), "https://image.novelai.net/ai/generate-image");
  assert.equal(characterReferenceEndpoint("https://gateway.example.com:9443/proxy/novelai/v1/"), "https://gateway.example.com:9443/proxy/novelai/ai/generate-image");
  assert.equal(characterReferenceEndpoint("https://gateway.example.com/proxy/v10"), "https://gateway.example.com/proxy/v10/ai/generate-image");
  assert.equal(characterReferenceEndpoint("https://gateway.example.com/v1/proxy"), "https://gateway.example.com/v1/proxy/ai/generate-image");
  for (const url of ["https://user:password@gateway.example.com/v1", "https://gateway.example.com/v1?redirect=https://other.example.com", "https://gateway.example.com/v1#other"]) {
    assert.throws(() => characterReferenceEndpoint(url), errorCode("INVALID_PROVIDER_SETTINGS"));
  }
});

test('native loopback reference endpoint requires explicit local mode and keeps configured ports', () => {
  assert.equal(characterReferenceEndpoint('http://127.0.0.1:1234/v1', true), 'http://127.0.0.1:1234/ai/generate-image');
  assert.equal(characterReferenceEndpoint('http://[::1]:80/proxy/v1', true), 'http://[::1]:80/proxy/ai/generate-image');
  assert.throws(() => characterReferenceEndpoint('http://127.0.0.1:1234/v1'), errorCode('INVALID_PROVIDER_SETTINGS'));
});

test("native request contains real padded PNG bytes and matching character reference arrays", async () => {
  const input = await portrait();
  const before = input.bytes.slice();
  const result = await buildCharacterReferenceRequest("nai-diffusion-5-full", "same character wearing a maid outfit", input);
  const { body, reference } = result;
  assert.equal(result.model, "nai-diffusion-4-5-full");
  assert.equal(body.model, result.model);
  assert.equal(body.input, "same character wearing a maid outfit");
  assert.equal(body.action, "generate");
  const parameters = body.parameters;
  assert.equal(parameters.v4_prompt.caption.base_caption, body.input);
  assert.deepEqual(parameters.director_reference_descriptions, [{ caption: { base_caption: "character", char_captions: [] } }]);
  assert.deepEqual(parameters.director_reference_information_extracted, [1]);
  assert.deepEqual(parameters.director_reference_strength_values, [1]);
  assert.deepEqual(parameters.director_reference_secondary_strength_values, [0.5]);
  assert.equal(parameters.director_reference_images.length, 1);
  assert.ok(Number.isInteger(parameters.seed) && parameters.seed >= 0 && parameters.seed <= 0xffffffff);
  assert.equal(parameters.steps, 28);
  assert.equal(parameters.scale, 5);
  assert.equal(parameters.n_samples, 1);
  assert.deepEqual(reference, { sourceUrl, mode: "character", strength: 1, fidelity: 0.5, width: 1024, height: 1536 });
  assert.ok(!parameters.director_reference_images[0].startsWith("data:"));
  const image = sharp(Buffer.from(parameters.director_reference_images[0], "base64"));
  const metadata = await image.metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, reference.width);
  assert.equal(metadata.height, reference.height);
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray(0, 3)], [0, 0, 0], "reference is padded with black");
  const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  assert.deepEqual([...data.subarray(center, center + 3)], [255, 0, 0], "source pixels survive reference preparation");
  assert.deepEqual(input.bytes, before, "stored avatar bytes stay unchanged");
  assert.ok(!("image" in parameters), "this is character reference rather than img2img");
  assert.ok(!("reference_image_multiple" in parameters), "Vibe Transfer is not mixed with Precise Reference");
});

test("landscape and square references use supported canvases", async () => {
  for (const [width, height, expectedWidth, expectedHeight] of [[160, 80, 1536, 1024], [100, 100, 1472, 1472]]) {
    const result = await buildCharacterReferenceRequest("nai-diffusion-4-5-curated", "portrait", await portrait(width, height));
    const metadata = await sharp(Buffer.from(result.body.parameters.director_reference_images[0], "base64")).metadata();
    assert.deepEqual([metadata.width, metadata.height], [expectedWidth, expectedHeight]);
    assert.deepEqual([result.reference.width, result.reference.height], [expectedWidth, expectedHeight]);
  }
});

test("EXIF orientation is applied before choosing the reference canvas", async () => {
  const bytes = await sharp({ create: { width: 160, height: 80, channels: 3, background: "#ff0000" } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const result = await buildCharacterReferenceRequest("nai-diffusion-4-5-full", "portrait", { bytes, contentType: "image/jpeg", sourceUrl });
  assert.deepEqual([result.reference.width, result.reference.height], [1024, 1536]);
});

test("invalid, mismatched and oversized decoded references fail without a text-only fallback", async () => {
  const valid = await portrait();
  for (const reference of [
    { ...valid, bytes: new Uint8Array() },
    { ...valid, bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) },
    { ...valid, contentType: "image/jpeg" },
    { ...valid, bytes: new Uint8Array(10 * 1024 * 1024 + 1) },
  ]) {
    await assert.rejects(buildCharacterReferenceRequest("nai-diffusion-5-full", "portrait", reference), errorCode("IMAGE_REFERENCE_INVALID"));
  }
  const dimension = Math.floor(Math.sqrt(MAX_REFERENCE_PIXELS)) + 1;
  const tooManyPixels = await sharp({ create: { width: dimension, height: dimension, channels: 3, background: "#000000" } }).png().toBuffer();
  await assert.rejects(buildCharacterReferenceRequest("nai-diffusion-5-full", "portrait", { ...valid, bytes: tooManyPixels }), errorCode("IMAGE_REFERENCE_INVALID"));
  await assert.rejects(buildCharacterReferenceRequest("unsupported-model", "portrait", valid), errorCode("IMAGE_REFERENCE_UNSUPPORTED"));
});
