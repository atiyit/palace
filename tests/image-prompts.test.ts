import test from "node:test";
import assert from "node:assert/strict";
import { renderImagePrompt } from "../lib/image-prompts.ts";

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
