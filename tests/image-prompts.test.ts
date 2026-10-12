import test from "node:test";
import assert from "node:assert/strict";
import { renderImagePrompt, renderImagePromptTemplate, createImagePromptProfile, inferImagePromptPreset, resolveImagePromptProfiles, getImagePromptProfile } from "../lib/image-prompts.ts";

test("default and empty custom image templates preserve the exact assembled prompt", () => {
  const prompt = "  用户要求：展示手部。\n仿生皮肤；保持既有人物。  ";
  assert.equal(renderImagePrompt(prompt), prompt);
  assert.equal(renderImagePrompt(prompt, "custom", " \n\t "), prompt);
});

test("image presets preserve the full visual brief and do not force a biological identity or body crop", () => {
  const prompt = "合成生命，制造于2021-01-02。仿生皮肤，手部特写，穿女仆装，不露脸。";
  for (const style of ["novelai", "gpt-image"] as const) {
    const result = renderImagePrompt(prompt, style);
    assert.ok(result.includes(prompt));
    assert.equal(result.split(prompt).length - 1, 1);
    assert.doesNotMatch(result, /adult human|full body|metal hands|robotic hands/i);
  }
  assert.match(renderImagePrompt(prompt, "novelai"), /best quality, very aesthetic/);
  assert.match(renderImagePrompt(prompt, "gpt-image"), /VISUAL BRIEF/);
});

test("custom templates interpolate current identity and request variables once without executing expressions", () => {
  const result = renderImagePrompt("原始框架提示 {{request}}", "custom", "{{ prompt }}\n{{name}} · {{species}} · {{age}}\n{{form}} / {{appearance}} / {{traits}}\n{{request}}\n{{userMessage}}\n{{unknown}}", {
    prompt: "不得覆盖基础提示",
    name: "绫", species: "合成生命", age: "manufactured on 2021-01-02", form: "仿生构型", appearance: "人工皮肤", traits: ["温柔", "谨慎"],
    request: "手部特写 {{name}}", userMessage: "看看你的手 {{constructor}}",
  });
  assert.equal(result, "原始框架提示 {{request}}\n绫 · 合成生命 · manufactured on 2021-01-02\n仿生构型 / 人工皮肤 / 温柔, 谨慎\n手部特写 {{name}}\n看看你的手 {{constructor}}\n{{unknown}}");
});

test("general group image templates leave unavailable character variables empty and preserve user literals", () => {
  const result = renderImagePrompt("画一座花园", "custom", "{{prompt}}\n{{name}}|{{species}}|{{appearance}}\n{{userMessage}}\n{{constructor}} {{a+b}}", { userMessage: "花园示意图", name: { unexpected: true } });
  assert.equal(result, "画一座花园\n||\n花园示意图\n{{constructor}} {{a+b}}");
});

test("fresh image prompt profiles independently follow each model and enable LLM composition", () => {
  const profiles = resolveImagePromptProfiles("nai-diffusion-5-full", "gpt-image-1");
  assert.equal(profiles.generation.preset, "nai5");
  assert.equal(profiles.reference.preset, "gpt-image");
  assert.equal(profiles.generation.llmEnabled, true);
  assert.equal(profiles.reference.llmEnabled, true);
  assert.match(profiles.generation.instructions, /NovelAI V5/);
  assert.match(profiles.reference.instructions, /natural-language/);
  assert.notEqual(createImagePromptProfile("nai5").negativePrompt, createImagePromptProfile("nai45").negativePrompt);
  assert.match(createImagePromptProfile("nai45").instructions, /compact English/);
  assert.match(createImagePromptProfile("nano-banana").instructions, /narrative|semantic/);
  assert.equal(inferImagePromptPreset("gemini-2.5-flash-image"), "nano-banana");
  assert.equal(inferImagePromptPreset("a-private-image-model"), "custom");
});

test("saved profiles and legacy custom templates are copied without sharing or losing edits", () => {
  const customPrompt = "原样 {{name}}\n{{prompt}}\n后缀 {{unknown}}";
  const legacy = resolveImagePromptProfiles("nai-diffusion-5-full", "gpt-image-1", { promptStyle: "custom", customPrompt });
  assert.equal(legacy.generation.positivePrompt, customPrompt);
  assert.equal(legacy.reference.positivePrompt, customPrompt);
  assert.equal(legacy.reference.llmEnabled, false);
  legacy.reference.positivePrompt = "参考专用";
  assert.equal(legacy.generation.positivePrompt, customPrompt);
  const saved = resolveImagePromptProfiles("gpt-image-1", "another-model", { promptProfiles: legacy, promptStyle: "default" });
  assert.deepEqual(saved, legacy);
  saved.reference.negativePrompt = "参考独立负面";
  assert.equal(legacy.reference.negativePrompt, "");
  assert.equal(getImagePromptProfile("gpt-image-1", "another-model", "reference", { promptProfiles: saved }).negativePrompt, "参考独立负面");
});

test("NAI preset templates keep requested Text lettering last and all template values remain literal", () => {
  const prompt = "a sign at the station. Text: Hello\n\nWelcome";
  for (const preset of ["nai5", "nai45"] as const) {
    const profile = createImagePromptProfile(preset);
    assert.ok(renderImagePromptTemplate(prompt, profile.positivePrompt).endsWith("Text: Hello\n\nWelcome"));
    assert.doesNotMatch(profile.positivePrompt + profile.negativePrompt, /no text|negative space|blank page/);
  }
  assert.equal(renderImagePromptTemplate("literal {{name}}", "{{prompt}}|{{name}}|{{missing}}", { name: "{{request}}", prompt: "wrong" }), "literal {{name}}|{{request}}|{{missing}}");
});

test("custom positive suffixes and repeated request variables stay outside the original lettering section", () => {
  const prompt = "a station sign\nText: WELCOME\n\nHOME";
  const rendered = renderImagePromptTemplate(prompt, "{{prompt}}\nCUSTOM-SUFFIX\n{{request}}\nAFTER-REQUEST", { request: prompt });
  assert.equal(rendered, "a station sign\nCUSTOM-SUFFIX\na station sign\nAFTER-REQUEST\nText: WELCOME\n\nHOME");
  assert.equal(rendered.split('Text:').length - 1, 1);
  assert.equal(renderImagePromptTemplate(prompt, "avoid {{name}}", { name: "duplicate portrait" }, { preserveLettering: false }), "avoid duplicate portrait");
  assert.equal(renderImagePromptTemplate("poster\nText:\n欢迎", "{{prompt}}\nclear composition"), "poster\nclear composition\nText:\n欢迎");
  assert.equal(renderImagePromptTemplate("base scene: poster\nText: Welcome. FRAMEWORK-SUFFIX", "{{prompt}}\nMODEL-SUFFIX", { request: "poster\nText: Welcome" }), "base scene: poster\n. FRAMEWORK-SUFFIX\nMODEL-SUFFIX\nText: Welcome");
});
