import { z } from "zod";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { PalaceError, publicError } from "@/lib/server/errors";
import { readPublicProviderSettings, resetProviderSettings, saveProviderSettings } from "@/lib/server/provider-settings";
import { mutateState } from '@/lib/server/store';
import { createInitialState } from '@/lib/seeds';
import type { AppState } from '@/lib/types';
import { MAX_IMAGE_PROMPT_INSTRUCTIONS_CHARS, MAX_IMAGE_POSITIVE_PROMPT_CHARS, MAX_IMAGE_NEGATIVE_PROMPT_CHARS } from '@/lib/image-prompts';

export const dynamic = "force-dynamic";
const responseHeaders = { "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: responseHeaders });
const promptProfileSchema = z.object({
  preset: z.enum(['nai5', 'nai45', 'gpt-image', 'nano-banana', 'custom']), llmEnabled: z.boolean(),
  instructions: z.string().max(MAX_IMAGE_PROMPT_INSTRUCTIONS_CHARS), positivePrompt: z.string().max(MAX_IMAGE_POSITIVE_PROMPT_CHARS), negativePrompt: z.string().max(MAX_IMAGE_NEGATIVE_PROMPT_CHARS),
}).strict();
const payloadSchema = z.object({
  action: z.enum(["save", "reset"]), kind: z.enum(["text", "image"]),
  baseUrl: z.string().max(2048).optional(), model: z.string().max(200).optional(), apiKey: z.string().max(2048).optional(),
  referenceModel: z.string().max(200).optional(), promptStyle: z.enum(['default', 'novelai', 'gpt-image', 'custom']).optional(), customPrompt: z.string().max(6000).optional(),
  promptProfiles: z.object({ generation: promptProfileSchema, reference: promptProfileSchema }).strict().optional(),
  protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic', 'ollama']).optional(), local: z.boolean().optional(), visionEnabled: z.boolean().optional(),
}).strict();

export async function GET() {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: "请先登录你的私人后宫。", code: "UNAUTHORIZED" }, 401);
    return json(await readPublicProviderSettings(user.userId));
  } catch (error) {
    const safe = publicError(error);
    return json({ error: safe.message, code: safe.code }, safe.status);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: "请先登录你的私人后宫。", code: "UNAUTHORIZED" }, 401);
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") throw new PalaceError("请求来源不匹配，请在应用页面内操作。", 403, "ORIGIN_MISMATCH");
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new PalaceError("请求需要JSON格式。", 415);
    const declaredLength = Number(request.headers.get("content-length") || "0");
    if (declaredLength > 262144) throw new PalaceError("配置请求不能超过256KB。", 413);
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 262144) throw new PalaceError("配置请求不能超过256KB。", 413);
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { throw new PalaceError("请求JSON格式无效。"); }
    const parsed = payloadSchema.safeParse(raw);
    if (!parsed.success) throw new PalaceError("API 配置参数无效，请检查地址、模型名和密钥长度。");
    const { action, kind, ...input } = parsed.data;
    let settings: Awaited<ReturnType<typeof readPublicProviderSettings>> | undefined;
    await mutateState<AppState>(user.userId, crypto.randomUUID(),createInitialState,async state=>{
      if (state.pendingCleanup?.length) throw new PalaceError('请先完成数据清理，再更改API配置。',409,'CLEANUP_PENDING');
      settings = action === 'reset' ? await resetProviderSettings(user.userId, kind) : await saveProviderSettings(user.userId, kind, input);
    });
    return json({ settings, message: action === "reset" ? `已恢复${kind === "text" ? "文本" : "图片"}渠道的默认 API 配置。` : `已保存${kind === "text" ? "文本" : "图片"}渠道的 API 配置。` });
  } catch (error) {
    const safe = publicError(error);
    return json({ error: safe.message, code: safe.code }, safe.status);
  }
}
