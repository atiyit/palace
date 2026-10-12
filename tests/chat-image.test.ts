import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "../lib/seeds.ts";
import type { ChatMessage, Task } from "../lib/types.ts";
import { attachChatImage, retryChatImage, chatImageStorageKey, type ChatImageDependencies } from "../lib/server/chat-image.ts";
import { actionSchema, ownContext, validateImageRequest, validateTaskAction } from "../lib/server/guardrails.ts";
import { PalaceError } from "../lib/server/errors.ts";
import type { PortraitReference } from "../lib/server/portrait-reference.ts";

function fixture() {
  const agent = createInitialState().agents[0]; agent.hired = true; agent.weight = 8; agent.chatBoost = 3;
  agent.portrait = `/api/portraits/${agent.id}?v=original`;
  const user: ChatMessage = { id: "original-user", role: "user", content: "穿女仆装拍张手部特写给我", createdAt: "2026-10-12T00:00:00Z" };
  const reply: ChatMessage = { id: "image-reply", role: "assistant", content: "我会保持自己的样子，按你的要求准备一张图片。", checked: true, createdAt: user.createdAt };
  agent.chats = [user, reply];
  return { agent, user, reply };
}
const bytes = { bytes: Uint8Array.of(137, 80, 78, 71), contentType: "image/png" };
const referenceBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 42);
const dependencies = (override: Partial<ChatImageDependencies> = {}): ChatImageDependencies => ({
  reference: async agent => ({ bytes: referenceBytes, contentType: "image/png", sourceUrl: agent.portrait }),
  generate: async () => bytes, store: async (_image, id) => `/api/portraits/chat-${id}`, model: () => "test-image-model",
  prompt: (agent, request, message) => `${agent.appearance}; ${request}; ${message}`,
  now: () => "2026-10-12T00:00:01Z", ...override,
});

test("chat generation receives the actual portrait reference object and persists only reference metadata", async () => {
  const { agent, user, reply } = fixture();
  const portrait = agent.portrait;
  const reference: PortraitReference = { bytes: referenceBytes, contentType: "image/png", sourceUrl: portrait };
  const steps: string[] = [];
  const result = await attachChatImage(agent, reply, "女仆装手部特写", user.content, dependencies({
    reference: async selected => { assert.strictEqual(selected, agent); steps.push("reference"); return reference; },
    generate: async (prompt, supplied) => {
      steps.push("generate"); assert.strictEqual(supplied, reference);
      assert.strictEqual(supplied.bytes, referenceBytes); assert.match(prompt, /女仆装手部特写/); return bytes;
    },
    store: async (generated, id) => { steps.push("store"); assert.strictEqual(generated, bytes); return `/api/portraits/chat-${id}`; },
    model: () => "configured-reference-model",
  }));
  assert.equal(result, "ready");
  assert.deepEqual(steps, ["reference", "generate", "store"]);
  assert.equal(reply.image?.model, "configured-reference-model");
  assert.deepEqual(reply.image?.reference, { sourceUrl: portrait, mode: "character" });
  assert.equal(Object.hasOwn(reply.image!.reference!, "bytes"), false);
  assert.equal(agent.portrait, portrait);
});

test("missing or invalid portrait references never call the image provider or silently fall back to text-only generation", async () => {
  for (const code of ["IMAGE_REFERENCE_MISSING", "IMAGE_REFERENCE_INVALID"]) {
    const { agent, user, reply } = fixture();
    const before = structuredClone(agent);
    let referenceCalls = 0;
    const result = await attachChatImage(agent, reply, "看看你的脸", user.content, dependencies({
      reference: async () => { referenceCalls++; throw new PalaceError("private reference details", 409, code); },
      generate: async () => { assert.fail("missing reference must not call a paid image provider"); },
      store: async () => { assert.fail("missing reference must not store an image"); },
    }));
    assert.equal(result, "failed"); assert.equal(referenceCalls, 1);
    assert.equal(reply.image?.status, "failed"); assert.equal(reply.image?.url, undefined);
    assert.match(reply.image?.error || "", /头像/);
    assert.equal(JSON.stringify(reply.image).includes("private reference details"), false);
    assert.equal(reply.content, before.chats[1].content);
    assert.deepEqual(agent.memories, before.memories);
    assert.equal(agent.portrait, before.portrait);
  }
});

test("an explicit image retry loads the latest avatar rather than reusing stale reference bytes", async () => {
  const { agent, user, reply } = fixture();
  const seen: PortraitReference[] = [];
  await attachChatImage(agent, reply, "看看你的脸", user.content, dependencies({
    generate: async (_prompt, supplied) => { seen.push(supplied); throw new PalaceError("reference unsupported", 502, "IMAGE_REFERENCE_UNSUPPORTED"); },
  }));
  assert.equal(seen.length, 1, "failed reference generation must not perform a text-only fallback");
  assert.equal(reply.image?.status, "failed");
  agent.portrait = `/api/portraits/${agent.id}?v=updated`;
  const newerBytes = Uint8Array.of(...referenceBytes, 123);
  const latest: PortraitReference = { bytes: newerBytes, contentType: "image/png", sourceUrl: agent.portrait };
  let loads = 0;
  const result = await retryChatImage(agent, reply.id, dependencies({
    reference: async selected => { loads++; assert.equal(selected.portrait, latest.sourceUrl); return latest; },
    generate: async (_prompt, supplied) => { seen.push(supplied); return bytes; },
  }));
  assert.equal(result, "ready"); assert.equal(loads, 1);
  assert.strictEqual(seen[1], latest); assert.strictEqual(seen[1].bytes, newerBytes);
  assert.notEqual(seen[0].sourceUrl, seen[1].sourceUrl);
  assert.deepEqual(reply.image?.reference, { sourceUrl: latest.sourceUrl, mode: "character" });
  assert.equal(agent.chats.length, 2);
});

test("a failed image keeps its accepted text and performs only one generation attempt", async () => {
  const { agent, user, reply } = fixture(); const before = structuredClone(agent);
  let calls = 0; let stores = 0;
  const result = await attachChatImage(agent, reply, "手部特写", user.content, dependencies({ generate: async () => { calls++; throw new PalaceError("secret gateway body", 502, "PROVIDER_QUOTA"); }, store: async () => { stores++; return ""; } }));
  assert.equal(result, "failed"); assert.equal(calls, 1); assert.equal(stores, 0);
  assert.equal(reply.content, before.chats[1].content); assert.equal(reply.checked, true);
  assert.equal(agent.chats.length, 2); assert.equal(agent.weight, 8); assert.equal(agent.chatBoost, 3);
  assert.deepEqual(agent.memories, before.memories); assert.equal(reply.image?.status, "failed");
  assert.ok(reply.image?.error?.includes("余额不足")); assert.equal(JSON.stringify(reply.image).includes("secret gateway body"), false);
});

test("explicit image retry uses the latest template and original request without a new chat or feedback", async () => {
  const { agent, user, reply } = fixture();
  await attachChatImage(agent, reply, "固定手部请求", user.content, dependencies({ generate: async () => { throw new Error("transport failed"); } }));
  const before = structuredClone(agent); let calls = 0;
  const result = await retryChatImage(agent, reply.id, dependencies({ prompt: (_agent, request, message) => `NEW TEMPLATE: ${request} / ${message}`, generate: async prompt => { calls++; assert.match(prompt, /^NEW TEMPLATE:/); return bytes; } }));
  assert.equal(result, "ready"); assert.equal(calls, 1);
  assert.equal(reply.image?.request, "固定手部请求"); assert.equal(reply.image?.url, "/api/portraits/chat-image-reply");
  assert.equal(reply.image?.error, undefined); assert.equal(reply.image?.model, "test-image-model");
  const withoutImage = structuredClone(agent); const beforeWithoutImage = structuredClone(before);
  delete withoutImage.chats[1].image; delete beforeWithoutImage.chats[1].image;
  assert.deepEqual(withoutImage, beforeWithoutImage);
  await retryChatImage(agent, reply.id, dependencies({ generate: async () => { assert.fail("ready images must not be regenerated"); } }));
});

test("failed retry preserves failure metadata and unaccepted or missing messages cannot generate", async () => {
  const { agent, user, reply } = fixture();
  await attachChatImage(agent, reply, "脸部特写", user.content, dependencies({ store: async () => { throw new Error("private filesystem details"); } }));
  let calls = 0;
  const result = await retryChatImage(agent, reply.id, dependencies({ generate: async () => { calls++; throw new PalaceError("raw body", 504, "PROVIDER_TIMEOUT"); } }));
  assert.equal(result, "failed"); assert.equal(calls, 1); assert.match(reply.image!.error!, /超时/);
  assert.equal(reply.image?.url, undefined);
  await assert.rejects(retryChatImage(agent, "missing", dependencies()), /找不到/);
  await assert.rejects(attachChatImage(agent, user, "请求", user.content, dependencies()), /已通过审查/);
  reply.checked = false;
  await assert.rejects(retryChatImage(agent, reply.id, dependencies()), /找不到/);
});

test("image actions allow exactly one request and reject tasks, missing current turns, or unavailable services", () => {
  const action = actionSchema.parse({ kind: "submit", content: "准备一张图片", imageRequest: "女仆装、手部特写" });
  assert.equal(action.imageRequest, "女仆装、手部特写");
  assert.equal(actionSchema.safeParse({ ...action, imageRequest: ["第一张", "第二张"] }).success, false);
  assert.equal(actionSchema.safeParse({ ...action, imageRequest: "x".repeat(1201) }).success, false);
  validateImageRequest(action, { mode: "private-chat", imageGenerationAvailable: true, userMessage: { content: "发张手部特写" } });
  for (const context of [{ mode: "task-turn", imageGenerationAvailable: true }, { mode: "private-chat", imageGenerationAvailable: true }, { mode: "private-chat", imageGenerationAvailable: false, userMessage: { content: "发张照片" } }]) assert.throws(() => validateImageRequest(action, context));
  const { agent } = fixture();
  const task: Task = { id: "task", title: "讨论", status: "running", rounds: 1, round: 1, participants: [agent.id], order: [agent.id], cursor: 0, createdAt: "now" };
  assert.throws(() => validateTaskAction(action, agent, task, []), /共议任务不能生成图片/);
});

test("chat image storage has a separate user and message namespace and cannot overwrite portraits", () => {
  assert.equal(chatImageStorageKey("alice", "message-a"), "portraits/alice/chat-message-a");
  assert.notEqual(chatImageStorageKey("alice", "message-a"), chatImageStorageKey("bob", "message-a"));
  assert.notEqual(chatImageStorageKey("alice", "message-a"), "portraits/alice/message-a");
  assert.equal(chatImageStorageKey("alice/bob", "message-a"), "portraits/alice%2Fbob/chat-message-a");
  assert.throws(() => chatImageStorageKey("alice", "../avatar"));
});

test("short-term image context contains only status and request, never pixels, links or a claim of vision", async () => {
  const { agent, user, reply } = fixture();
  await attachChatImage(agent, reply, "手部特写", user.content, dependencies({ store: async () => "data:image/png;base64,private-bytes" }));
  const context = ownContext(agent, "图片");
  assert.deepEqual(context.shortTermChats[1].image, { status: "ready", request: "手部特写", visuallyObserved: false });
  assert.equal(JSON.stringify(context).includes("private-bytes"), false);
  assert.equal(JSON.stringify(context).includes("test-image-model"), false);
});
