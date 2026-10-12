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
  const supported = new Set<string>(IMAGE_PROMPT_VARIABLES);
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (original, name: string) => {
    if (!supported.has(name)) return original;
    // 已组装的基础提示词才是「prompt」的权威来源——即使调用方另传了同名变量，我也只认这一份呢。
    return name === "prompt" ? basePrompt : valueText(variables[name]);
  });
}
