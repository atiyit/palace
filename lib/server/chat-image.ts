import type { Agent, ChatMessage } from "../types.ts";
import { PalaceError } from "./errors.ts";
import type { PortraitReference } from "./portrait-reference.ts";

export interface ChatImageBytes { bytes: Uint8Array; contentType: string; }
export type ChatImageSink = (image: ChatImageBytes, messageId: string) => Promise<string>;
export interface ChatImageDependencies {
  generate: (prompt: string, reference: PortraitReference, context: { agent: Agent; request: string; userMessage: string }) => Promise<ChatImageBytes>;
  reference: (agent: Agent) => Promise<PortraitReference>;
  store: ChatImageSink;
  model: () => string;
  prompt: (agent: Agent, request: string, userMessage: string) => string;
  now?: () => string;
}

export function chatImageStorageKey(userId: string, messageId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,95}$/.test(messageId)) throw new PalaceError("聊天图片编号无效。");
  return `portraits/${encodeURIComponent(userId)}/chat-${messageId}`;
}

function safeImageError(error: unknown): string {
  const code = error instanceof PalaceError ? error.code : "";
  if (code === "PROVIDER_QUOTA") return "图片服务余额不足，请充值或在庭院设置更换图片 API Key。";
  if (code === "PROVIDER_TIMEOUT") return "图片生成超时，文字回复已保留。可以单独重试图片。";
  if (code === "IMAGE_NOT_CONFIGURED" || code === "MODEL_NOT_CONFIGURED") return "图片服务尚未配置，请在庭院设置中填写图片 API。";
  if (code === "IMAGE_FORMAT") return "图片服务未返回有效图片，可以单独重试。";
  if (code === "IMAGE_PROMPT_INVALID") return error instanceof PalaceError ? error.message : "生图提示词编译失败，请检查该模型的提示词配置。";
  if (code === "IMAGE_REFERENCE_MISSING") return "请先为她生成头像，再重试这张聊天图片；生成时会使用头像作为角色参考。";
  if (code === "IMAGE_REFERENCE_INVALID") return "头像参考图无法读取或格式无效，请重新生成头像后重试。";
  if (code === "IMAGE_REFERENCE_UNSUPPORTED") return "参考图模型不支持当前参考接口，请在庭院设置中检查参考图生图模型。";
  if (code === "IMAGE_REFERENCE_PROVIDER") return "图片服务未完成头像参考生图，请检查参考图模型及 API 的接口支持后重试；原文字回复保留。";
  if (code === "PROVIDER_ERROR") return "图片服务连接、权限或限流异常，文字回复已保留。";
  return "图片生成或保存失败，文字回复已保留。可以单独重试图片。";
}

/** 一次调用我只为主人生成一张图片。若生成失败，原因会记录在聊天元数据中；已通过的文字回复不会被撤回呢。 */
export async function attachChatImage(agent: Agent, message: ChatMessage, request: string, userMessage: string, dependencies: ChatImageDependencies): Promise<"ready" | "failed" | "unchanged"> {
  if (message.role !== "assistant" || message.checked !== true) throw new PalaceError("只能为已通过审查的角色回复生成图片。");
  if (message.image?.status === "ready") return "unchanged";
  if (!request.trim() || request.length > 1200) throw new PalaceError("图片请求需要1至1200个字符。");
  message.image = { status: "failed", request, prompt: "", model: "", createdAt: (dependencies.now || (() => new Date().toISOString()))() };
  try {
    message.image.model = dependencies.model();
    message.image.prompt = dependencies.prompt(agent, request, userMessage);
    const reference = await dependencies.reference(agent);
    message.image.reference = { sourceUrl: reference.sourceUrl, mode: "character" };
    const generated = await dependencies.generate(message.image.prompt, reference, { agent, request, userMessage });
    const url = await dependencies.store(generated, message.id);
    message.image = { ...message.image, status: "ready", url };
    return "ready";
  } catch (error) {
    message.image = { ...message.image, status: "failed", error: safeImageError(error) };
    return "failed";
  }
}

export async function retryChatImage(agent: Agent, messageId: string, dependencies: ChatImageDependencies): Promise<"ready" | "failed" | "unchanged"> {
  const index = agent.chats.findIndex(message => message.id === messageId);
  const message = agent.chats[index];
  if (!message || message.role !== "assistant" || message.checked !== true || !message.image) throw new PalaceError("找不到可以重试的聊天图片。", 404);
  if (message.image.status === "ready") return "unchanged";
  const userMessage = agent.chats.slice(0, index).reverse().find(item => item.role === "user")?.content || "";
  return attachChatImage(agent, message, message.image.request, userMessage, dependencies);
}
