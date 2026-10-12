/** 这份配置是设置界面与服务端图片合成共用的公开目录，我不会把任何凭证信息夹带进来呀。 */
export type ImagePromptStyle = "default" | "novelai" | "gpt-image" | "custom";
export const MAX_CUSTOM_IMAGE_PROMPT_CHARS = 6000;
export const IMAGE_PROMPT_VARIABLES = ["prompt", "name", "age", "species", "form", "appearance", "traits", "request", "userMessage"] as const;

export const IMAGE_PROMPT_STYLES: ReadonlyArray<{ value: ImagePromptStyle; label: string; description: string }> = [
  { value: "default", label: "默认", description: "沿用框架当前的肖像、私聊或群聊提示词，不额外添加风格指令。" },
  { value: "novelai", label: "NovelAI 优化", description: "在当前提示词前加入画质与构图标签，保留具体种族、外观与本次画面要求。不会额外调用文本模型翻译。" },
  { value: "gpt-image", label: "GPT-image 优化", description: "用自然语言区分画面要求、身份细节与参考图用途，强调按本次要求调整衣装和取景。" },
  { value: "custom", label: "自定义", description: "使用你填写的模板。{{prompt}} 可插入当前完整基础提示；未提供的变量会留空。模板为空时沿用默认。" },
];

const NOVELAI_TEMPLATE = "best quality, very aesthetic, detailed composition\n\n{{prompt}}";
const GPT_IMAGE_TEMPLATE = "Create a single finished image that follows the visual brief below. Preserve the specified character identity, species, physical form, anatomy and visible exterior materials. If a reference image is attached, use it for identity consistency; do not copy its crop, pose or clothing when the current request asks for something different. Follow the requested framing and visible body part without adding unrelated elements. Do not introduce generic mechanical or supernatural features absent from the brief.\n\nVISUAL BRIEF\n{{prompt}}";
export const DEFAULT_CUSTOM_IMAGE_PROMPT = "{{prompt}}\n\n画面要求：细节清晰、构图自然，保留人物既有身份与外观，遵循本次衣装、姿态和取景要求。";

export type ImagePromptPreset = "nai5" | "nai45" | "gpt-image" | "nano-banana" | "custom";
export type ImagePromptSlot = "generation" | "reference";
export interface ImagePromptProfile {
  preset: ImagePromptPreset;
  llmEnabled: boolean;
  instructions: string;
  positivePrompt: string;
  negativePrompt: string;
}
export type ImagePromptProfiles = Record<ImagePromptSlot, ImagePromptProfile>;
export const MAX_IMAGE_PROMPT_INSTRUCTIONS_CHARS = 6000;
export const MAX_IMAGE_POSITIVE_PROMPT_CHARS = 6000;
export const MAX_IMAGE_NEGATIVE_PROMPT_CHARS = 3000;
export const IMAGE_PROMPT_PRESETS: ReadonlyArray<{ value: ImagePromptPreset; label: string; description: string; documentation?: string }> = [
  { value: "nai5", label: "NAI 5", description: "标签配合自然语言，保留主体关系、构图与材质；适合 NovelAI V5。", documentation: "https://docs.novelai.net/en/image/models/" },
  { value: "nai45", label: "NAI 4.5", description: "紧凑英文标签与短句，优先人物、动作和画面要求；适合 NovelAI V4.5。", documentation: "https://docs.novelai.net/en/image/models/" },
  { value: "gpt-image", label: "GPT-image", description: "自然语言描述场景、主体、细节与约束，明确参考图中需要保留和改变的部分。", documentation: "https://developers.openai.com/api/docs/guides/image-prompting" },
  { value: "nano-banana", label: "Nano Banana", description: "使用连贯场景叙述、镜头与语义约束。这是提示策略，仍需服务支持当前图片兼容接口。", documentation: "https://ai.google.dev/gemini-api/docs/image-generation" },
  { value: "custom", label: "自定义", description: "自行编写给文本模型的说明、正向模板与负面词。" },
];

const IDENTITY_INSTRUCTIONS = "Preserve the supplied identity, species, physical form and visible materials. Follow the current request for framing, clothing, pose and visible body parts. Do not invent mechanical anatomy or supernatural features. References establish identity; preserve only the aspects the request asks to keep. Describe a scene without characters when none are requested.";
const NAI_TEXT_INSTRUCTIONS = "For requested image lettering, use appropriate text tags and put the exact lettering in a final Text: section. Nothing may follow that section. Do not add no text or negative text tags when lettering is requested.";

/** 主人，各预设只决定提示词写法，不会夹带某家模型的专属接口参数哦。 */
export function createImagePromptProfile(preset: ImagePromptPreset): ImagePromptProfile {
  const defaults: Record<ImagePromptPreset, Pick<ImagePromptProfile, "instructions" | "positivePrompt" | "negativePrompt">> = {
    nai5: {
      instructions: `Rewrite the visual brief as a concise NovelAI V5 image prompt. Combine recognizable tags with natural language for actions, composition and relationships. Prefer English descriptions; preserve requested literal lettering in its original language. Add only relevant quality cues. ${IDENTITY_INSTRUCTIONS} ${NAI_TEXT_INSTRUCTIONS} Produce distinct positive and negative prompts.`,
      positivePrompt: "very aesthetic, masterpiece\n{{prompt}}",
      negativePrompt: "lowres, artistic error, bad anatomy, bad hands, white haze",
    },
    nai45: {
      instructions: `Rewrite the visual brief for NovelAI V4.5 using compact English tags and short English sentences. Prioritize identity, action, framing and visible materials; avoid redundant prose to conserve its roughly 512-token combined prompt budget. ${IDENTITY_INSTRUCTIONS} ${NAI_TEXT_INSTRUCTIONS} V4.5 lettering is intended for English; never silently translate requested literal lettering. Produce distinct positive and negative prompts.`,
      positivePrompt: "very aesthetic, masterpiece\n{{prompt}}",
      negativePrompt: "lowres, scan artifacts, bad quality, jpeg artifacts",
    },
    "gpt-image": {
      instructions: `Write a clear natural-language image brief in the order scene, subject, visual details, constraints. Specify materials, lighting, composition and the requested medium. For reference edits, distinguish what changes from what must remain. Quote requested lettering exactly and describe its position. ${IDENTITY_INSTRUCTIONS} Express exclusions as plain language, without NovelAI tags, weights or sampler parameters. Produce distinct positive and negative prompts.`,
      positivePrompt: "Create one finished image following this visual brief:\n{{prompt}}",
      negativePrompt: "Avoid unrelated objects, unintended duplicate subjects and changes to the specified identity.",
    },
    "nano-banana": {
      instructions: `Write a coherent narrative scene description for Gemini image generation (Nano Banana). Describe the subject, action, environment, composition, lighting and medium concretely. Use camera language when useful. For edits, state the intended change and the identity details to preserve. Prefer semantic constraints describing the desired result to long negative tag lists. Quote requested lettering exactly. ${IDENTITY_INSTRUCTIONS} Do not use NovelAI weights or API parameters. Produce distinct positive and negative prompts.`,
      positivePrompt: "Create an image of the following scene:\n{{prompt}}",
      negativePrompt: "Keep the scene focused on the requested subjects and preserve their identity and intended proportions.",
    },
    custom: {
      instructions: `Turn the visual brief into final positive and negative image prompts suited to the selected model. ${IDENTITY_INSTRUCTIONS} Preserve requested literal lettering.`,
      positivePrompt: "{{prompt}}",
      negativePrompt: "",
    },
  };
  return { preset, llmEnabled: true, ...defaults[preset] };
}

export function inferImagePromptPreset(model: string): ImagePromptPreset {
  if (/nai[-_ ]?diffusion[-_ ]?5|novelai.*5/i.test(model)) return "nai5";
  if (/nai[-_ ]?diffusion|novelai/i.test(model)) return "nai45";
  if (/gpt[-_ ]?image|chatgpt[-_ ]?image/i.test(model)) return "gpt-image";
  if (/nano[-_ ]?banana|gemini.*image/i.test(model)) return "nano-banana";
  return "custom";
}

export interface ImagePromptProfileOptions {
  promptProfiles?: ImagePromptProfiles;
  promptStyle?: ImagePromptStyle;
  customPrompt?: string;
}

/** 旧模板先妥善搬进两个独立抽屉，主人写下的原文和显式选择都会保留。 */
export function resolveImagePromptProfiles(model: string, referenceModel: string, options: ImagePromptProfileOptions = {}): ImagePromptProfiles {
  const migrate = (target: string): ImagePromptProfile => {
    const preset = options.promptStyle === "custom" ? "custom" : options.promptStyle === "gpt-image" ? "gpt-image" : options.promptStyle === "novelai" ? (/5/.test(target) ? "nai5" : "nai45") : inferImagePromptPreset(target);
    const profile = createImagePromptProfile(preset);
    if (options.promptStyle === "custom") return { ...profile, llmEnabled: false, positivePrompt: options.customPrompt?.trim() ? options.customPrompt : "{{prompt}}" };
    if (options.promptStyle === "novelai" || options.promptStyle === "gpt-image") return { ...profile, llmEnabled: false, positivePrompt: options.promptStyle === "novelai" ? NOVELAI_TEMPLATE : GPT_IMAGE_TEMPLATE, negativePrompt: "" };
    return profile;
  };
  return {
    generation: { ...(options.promptProfiles?.generation ?? migrate(model)) },
    reference: { ...(options.promptProfiles?.reference ?? migrate(referenceModel)) },
  };
}

export function getImagePromptProfile(model: string, referenceModel: string, slot: ImagePromptSlot, options: ImagePromptProfileOptions = {}): ImagePromptProfile {
  return resolveImagePromptProfiles(model, referenceModel, options)[slot];
}

export function splitImagePromptLettering(prompt: string): { body: string; lettering?: string } {
  const match = /(?:^|\s)(Text:\s*\S[\s\S]*)$/.exec(prompt);
  return match ? { body: prompt.slice(0, match.index).trimEnd(), lettering: match[1] } : { body: prompt };
}

/** 我会先把原稿的印字单独收好，套完模板才放回末尾，免得模板尾缀也被印在画面上呢。 */
export function renderImagePromptTemplate(basePrompt: string, template: string, variables: Record<string, unknown> = {}, options: { preserveLettering?: boolean } = {}): string {
  const requestLettering = typeof variables.request === 'string' ? splitImagePromptLettering(variables.request).lettering : undefined;
  const original = options.preserveLettering === false ? { body: basePrompt } : requestLettering
    ? { body: basePrompt.replaceAll(requestLettering, '').trimEnd(), lettering: requestLettering }
    : splitImagePromptLettering(basePrompt);
  const supported = new Set<string>(IMAGE_PROMPT_VARIABLES);
  const rendered = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (placeholder, name: string) => {
    if (!supported.has(name)) return placeholder;
    if (name === "prompt") return original.body;
    const value = valueText(variables[name]);
    if (original.lettering) {
      const part = splitImagePromptLettering(value);
      if (part.lettering === original.lettering) return part.body;
    }
    return value;
  });
  return original.lettering ? `${splitImagePromptLettering(rendered).body.trimEnd()}\n${original.lettering}` : rendered;
}

function valueText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.filter(item => typeof item === "string" || typeof item === "number").join(", ");
  return "";
}

/**
 * 主人，框架组装完基础图片提示词后，这个函数只替您执行一次模板替换。
 * 变量值是字面文本——用户原文里的花括号序列不会被二次求值呢。
 * 未识别的占位符会原样保留，我不会擅自删掉主人写的自定义文字哦。
 */
export function renderImagePrompt(
  basePrompt: string,
  style: ImagePromptStyle = "default",
  customPrompt = "",
  variables: Record<string, unknown> = {},
): string {
  if (style === "default" || (style === "custom" && !customPrompt.trim())) return basePrompt;
  const template = style === "novelai" ? NOVELAI_TEMPLATE : style === "gpt-image" ? GPT_IMAGE_TEMPLATE : style === "custom" ? customPrompt : "{{prompt}}";
  return renderImagePromptTemplate(basePrompt, template, variables);
}
