import test from "node:test";
import assert from "node:assert/strict";
import { loadPortraitReference, MAX_PORTRAIT_REFERENCE_BYTES } from "../lib/server/portrait-reference.ts";
import { PalaceError } from "../lib/server/errors.ts";

const agent = { id: "agent-one", portrait: "/api/portraits/agent-one?v=123" };
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQWQAAAAASUVORK5CYII=", "base64"));
type StoredImage = { body: ReadableStream<Uint8Array>; httpMetadata?: { contentType?: string }; size?: number };
const bucket = (get: (key: string) => Promise<StoredImage | null>) => ({ get }) as unknown as Pick<R2Bucket, "get">;
const image = (bytes = png, contentType = "image/png"): StoredImage => ({ body: new Response(bytes).body!, httpMetadata: { contentType } });
const code = (expected: string) => (error: unknown) => error instanceof PalaceError && error.code === expected;

test("portrait references return the actual avatar bytes using only the current owner's storage namespace", async () => {
  const keys: string[] = [];
  const saved = image();
  const result = await loadPortraitReference(agent, "owner/a@example.test", bucket(async key => { keys.push(key); return saved; }));
  assert.deepEqual(keys, ["portraits/owner%2Fa%40example.test/agent-one"]);
  assert.deepEqual(result, { bytes: png, contentType: "image/png", sourceUrl: agent.portrait });
  assert.equal(saved.body.locked, false);
});

test("portrait reference path checks reject remote, traversing, other-character and chat image paths before storage access", async () => {
  const untouched = bucket(async () => { assert.fail("invalid paths must not access storage"); });
  for (const portrait of [
    "https://example.test/api/portraits/agent-one", "http://127.0.0.1/api/portraits/agent-one",
    "//example.test/api/portraits/agent-one", "/api/portraits/agent-two", "/api/portraits/chat-agent-one",
    "/api/portraits/../agent-one", "/api/portraits/%61gent-one", "/api/portraits/agent-one/",
    "/api/portraits/agent-one?userId=other", "/api/portraits/agent-one?v=123&userId=other", "/api/portraits/agent-one#fragment",
  ]) {
    await assert.rejects(loadPortraitReference({ ...agent, portrait }, "owner", untouched), code("IMAGE_REFERENCE_INVALID"));
  }
  await assert.rejects(loadPortraitReference({ id: "chat-message", portrait: "/api/portraits/chat-message" }, "owner", untouched), code("IMAGE_REFERENCE_INVALID"));
  await assert.rejects(loadPortraitReference(agent, "..", untouched), code("IMAGE_REFERENCE_INVALID"));
});

test("missing, seed-only and deleted avatars require a generated portrait; missing storage is distinct", async () => {
  const untouched = bucket(async () => { assert.fail("missing avatar must not access storage"); });
  for (const portrait of ["", "/portraits/pearl.png"]) {
    await assert.rejects(loadPortraitReference({ ...agent, portrait }, "owner", untouched), code("IMAGE_REFERENCE_MISSING"));
  }
  await assert.rejects(loadPortraitReference(agent, "owner", bucket(async () => null)), code("IMAGE_REFERENCE_MISSING"));
  await assert.rejects(loadPortraitReference(agent, "owner", undefined), code("IMAGE_NOT_CONFIGURED"));
});

test("supported MIME types must match their binary signatures", async () => {
  const jpeg = Uint8Array.of(255, 216, 255, 224, 0, 16, 74, 70, 73, 70);
  const webp = Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80);
  for (const [bytes, contentType] of [[png, "image/png"], [jpeg, "image/jpeg"], [webp, "image/webp"]] as const) {
    const result = await loadPortraitReference(agent, "owner", bucket(async () => image(bytes, contentType)));
    assert.deepEqual(result.bytes, bytes);
    assert.equal(result.contentType, contentType);
  }
  for (const [bytes, contentType] of [
    [png, "image/jpeg"], [png, "text/html"], [jpeg, "image/png"],
    [Uint8Array.of(137, 80, 78, 71), "image/png"], [new Uint8Array(), "image/png"],
    [Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 78, 79, 80, 69), "image/webp"],
  ] as const) {
    await assert.rejects(loadPortraitReference(agent, "owner", bucket(async () => image(bytes, contentType))), code("IMAGE_REFERENCE_INVALID"));
  }
  const normalized = await loadPortraitReference(agent, "owner", bucket(async () => image(png, " IMAGE/PNG; charset=binary")));
  assert.equal(normalized.contentType, "image/png");
  await assert.rejects(loadPortraitReference(agent, "owner", bucket(async () => ({ body: new Response(png).body! }))), code("IMAGE_REFERENCE_INVALID"));
});

test("streaming size checks stop and cancel oversized images without trusting the stored size", async () => {
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(MAX_PORTRAIT_REFERENCE_BYTES / 2 + 1)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(loadPortraitReference(agent, "owner", bucket(async () => ({ body, size: 1, httpMetadata: { contentType: "image/png" } }))), code("IMAGE_REFERENCE_INVALID"));
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("oversized metadata is rejected before reading and boundary-sized chunked bytes are preserved", async () => {
  let pulls = 0;
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({ pull() { pulls++; }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await assert.rejects(loadPortraitReference(agent, "owner", bucket(async () => ({ body: oversized, size: MAX_PORTRAIT_REFERENCE_BYTES + 1, httpMetadata: { contentType: "image/png" } }))), code("IMAGE_REFERENCE_INVALID"));
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
  const bytes = new Uint8Array(MAX_PORTRAIT_REFERENCE_BYTES);
  bytes.set(png);
  bytes[bytes.length - 1] = 17;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 512 * 1024, bytes.length);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    },
  });
  const result = await loadPortraitReference(agent, "owner", bucket(async () => ({ body, httpMetadata: { contentType: "image/png" } })));
  assert.deepEqual(result.bytes, bytes);
});

test("broken storage and read streams return a safe reference validation error", async () => {
  const secret = "private object key or provider key";
  const check = (error: unknown) => code("IMAGE_REFERENCE_INVALID")(error) && error instanceof Error && !error.message.includes(secret);
  await assert.rejects(loadPortraitReference(agent, "owner", bucket(async () => { throw new Error(secret); })), check);
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(secret)); } });
  await assert.rejects(loadPortraitReference(agent, "owner", bucket(async () => ({ body, httpMetadata: { contentType: "image/png" } }))), check);
  assert.equal(body.locked, false);
});
