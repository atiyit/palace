import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS, applyProviderPreset, detectProviderPreset, isLocalProviderAddress, providerOrigin, type ProviderConnectionDraft } from "../lib/provider-presets.ts";
import { providerDefaults } from "../lib/server/provider-config-core.ts";

const cloud: ProviderConnectionDraft = { baseUrl: "https://api.example.com/v1", model: "fixture-model", apiKey: "test-only-unsaved-key", protocol: "openai-chat", local: false, visionEnabled: true };
const preset = (kind: "text" | "image", id: string) => PROVIDER_PRESETS[kind].find(item => item.id === id)!;

test("changing a service preset clears an unsaved key and vision assumption without mutating saved input", () => {
  const original = structuredClone(cloud);
  const selected = applyProviderPreset(cloud, preset("text", "anthropic"));
  assert.equal(selected.apiKey, "");
  assert.equal(selected.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(selected.model, "claude-opus-4-6");
  assert.equal(selected.protocol, "anthropic");
  assert.equal(selected.local, false);
  assert.equal(selected.visionEnabled, false);
  assert.deepEqual(cloud, original);
});

test("local presets require a real installed model and do not carry cloud credentials into local requests", () => {
  for (const id of ["ollama", "lm-studio"]) {
    const selected = applyProviderPreset(cloud, preset("text", id));
    assert.equal(selected.apiKey, "");
    assert.equal(selected.local, true);
    assert.equal(selected.model, "");
    assert.ok(isLocalProviderAddress(selected.baseUrl));
    assert.equal(selected.visionEnabled, false);
  }
  assert.equal(preset("text", "ollama").connection?.baseUrl, "http://127.0.0.1:11434");
  assert.equal(preset("text", "ollama").connection?.protocol, "ollama");
  assert.equal(preset("text", "lm-studio").connection?.baseUrl, "http://127.0.0.1:1234/v1");
});

test("image service changes choose both image models while preserving the user's custom prompt draft", () => {
  const draft = { ...cloud, referenceModel: "old-reference", promptStyle: "custom", customPrompt: "{{prompt}} · 自己的画风" };
  const selected = applyProviderPreset(draft, preset("image", "openai"));
  assert.equal(selected.model, "gpt-image-1");
  assert.equal(selected.referenceModel, "gpt-image-1");
  assert.equal(selected.protocol, "openai-chat");
  assert.equal(selected.customPrompt, draft.customPrompt);
  assert.equal(selected.promptStyle, "custom");
  assert.equal(selected.apiKey, "");
});

test("custom preserves typed connection details but never carries over an unsaved credential", () => {
  const selected = applyProviderPreset(cloud, preset("text", "custom"));
  assert.equal(selected.baseUrl, cloud.baseUrl);
  assert.equal(selected.model, cloud.model);
  assert.equal(selected.protocol, cloud.protocol);
  assert.equal(selected.apiKey, "");
});

test("preset detection respects protocol and local mode instead of guessing from model names", () => {
  assert.equal(detectProviderPreset("text", { baseUrl: "https://api.example.com/v1/" }), "custom");
  assert.equal(detectProviderPreset("text", { baseUrl: "https://api.openai.com/v1", protocol: "openai-responses" }), "openai");
  assert.equal(detectProviderPreset("text", { baseUrl: "https://api.openai.com/v1", protocol: "anthropic" }), "custom");
  assert.equal(detectProviderPreset("text", { baseUrl: "http://127.0.0.1:1234/v1", local: true }), "lm-studio");
  assert.equal(detectProviderPreset("text", { baseUrl: "http://127.0.0.1:1234/v1", local: false }), "custom");
});

test("fresh installations use editable custom placeholders without credentials", () => {
  const defaults = providerDefaults({});
  for (const kind of ["text", "image"] as const) {
    assert.equal(defaults[kind].baseUrl, "https://api.example.com/v1");
    assert.equal(defaults[kind].apiKey, "");
    assert.equal(detectProviderPreset(kind, defaults[kind]), "custom");
  }
  assert.equal(defaults.text.model, "claude-opus-4-6");
});

test("local address guidance accepts only loopback addresses with an explicit port", () => {
  for (const value of ["http://127.0.0.1:1234/v1", "localhost:11434", "http://[::1]:8080/v1", "https://localhost:3443/v1", "http://localhost:80/v1"]) assert.equal(isLocalProviderAddress(value), true, value);
  for (const value of ["http://localhost/v1", "http://192.168.1.2:1234/v1", "https://api.example.com:443/v1", "http://127.0.0.1:0/v1", "ftp://localhost:1234", "http://user:key@localhost:1234", "http://localhost:1234?key=x", "not a url"]) assert.equal(isLocalProviderAddress(value), false, value);
  assert.equal(providerOrigin("api.example.com"), "https://api.example.com");
  assert.equal(providerOrigin("localhost:1234", true), "http://localhost:1234");
});
