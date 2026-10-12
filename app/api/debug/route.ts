import { z } from "zod";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { createInitialState } from "@/lib/seeds";
import { upgradeAppState } from "@/lib/character-profile";
import type { AppState } from "@/lib/types";
import { validatePromptOverrides } from "@/lib/prompts";
import { debugCatalog, runDebug } from "@/lib/server/debug-engine";
import { PalaceError, publicError } from "@/lib/server/errors";
import { mutateState, readState } from "@/lib/server/store";
import { withProviderSettings } from "@/lib/server/provider-settings";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const schema = z.object({ action: z.enum(["save", "reset", "resetAll", "preview", "run", "validation.save", "validation.reset"]), contentRulesEnabled: z.boolean().optional(), id: z.string().max(100).optional(), promptId: z.string().max(100).optional(), text: z.string().max(16000).optional(), requestId: z.string().min(8).max(100).optional(), stage: z.enum(["actor", "reviewer", "recruiter", "profile", "strategy-review", "portrait", "chat-image", "chat", "task", "daily", "daily-review", "delivery", "delivery-review", "group", "group-review", "user-profile", "user-portrait"]).optional(), agentId: z.string().max(100).optional(), taskId: z.string().max(100).optional(), input: z.unknown().optional(), draftOverrides: z.record(z.string().max(16000)).optional(), maxTokens: z.number().int().min(128).max(8000).optional() }).strict();

export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: "请先登录。" }, 401);
    const state = upgradeAppState(await readState<AppState>(user.userId, createInitialState));
    return await withProviderSettings(user.userId, async () => json(debugCatalog(state, new URL(request.url).searchParams.get("agentId") || undefined)));
  } catch (error) { const safe = publicError(error); return json({ error: safe.message, code: safe.code }, safe.status); }
}

export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: "请先登录。" }, 401);
    if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") throw new PalaceError("请求来源不匹配。", 403);
    if (!request.headers.get("content-type")?.includes("application/json")) throw new PalaceError("请求需要JSON格式。", 415);
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 400_000) throw new PalaceError("调试请求内容过大。", 413);
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { throw new PalaceError("请求JSON无效。"); }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new PalaceError("调试参数无效，请检查输入JSON和长度限制。");
    const payload = parsed.data;
    if (payload.action === "validation.save" || payload.action === "validation.reset") {
      if (payload.action === "validation.save" && payload.contentRulesEnabled === undefined) throw new PalaceError("请选择是否启用内容规则检查。");
      const result = await mutateState<AppState>(user.userId, payload.requestId || crypto.randomUUID(), createInitialState, async state => {
        upgradeAppState(state);
        state.debugOptions = { contentRulesEnabled: payload.action === "validation.reset" ? true : payload.contentRulesEnabled! };
        state.updatedAt = new Date().toISOString();
      });
      return await withProviderSettings(user.userId, async () => json({ ...debugCatalog(result.state, payload.agentId), message: result.state.debugOptions!.contentRulesEnabled ? "内容规则检查已开启，后续生成使用默认约束。" : "内容规则检查已关闭，后续生成只保留必要结构和运行检查。" }));
    }
    if (["save", "reset", "resetAll"].includes(payload.action)) {
      return await withProviderSettings(user.userId, async () => {
      const result = await mutateState<AppState>(user.userId, payload.requestId || crypto.randomUUID(), createInitialState, async state => {
        upgradeAppState(state);
        const overrides = { ...state.promptOverrides };
        const id = payload.id || payload.promptId;
        if (payload.action !== "resetAll" && !id) throw new PalaceError("请选择提示词配置项。");
        if (payload.action === "save") { if (payload.text === undefined) throw new PalaceError("请输入提示词。"); overrides[id!] = payload.text; }
        if (payload.action === "reset") { if (!debugCatalog(state).prompts.some(item => item.id === id)) throw new PalaceError("未知提示词配置项。"); delete overrides[id!]; }
        try { state.promptOverrides = validatePromptOverrides(payload.action === "resetAll" ? {} : overrides); }
        catch (error) { throw new PalaceError(error instanceof Error ? error.message : "提示词无效。"); }
        state.updatedAt = new Date().toISOString();
        if (new TextEncoder().encode(JSON.stringify(state)).length > 1_800_000) throw new PalaceError("存档容量不足，未保存提示词。", 413);
      });
      return json({ ...debugCatalog(upgradeAppState(result.state), payload.agentId), message: payload.action === "save" ? "已保存，后续模型调用使用新提示词。" : "已恢复默认提示词。" });
      });
    }
    if (!payload.stage) throw new PalaceError("请选择调试阶段。");
    const state = upgradeAppState(await readState<AppState>(user.userId, createInitialState));
    if (state.pendingCleanup?.length && payload.action === 'run') throw new PalaceError('请先完成数据清理，再运行模型调试。',409,'CLEANUP_PENDING');
    return await withProviderSettings(user.userId, async () => json(await runDebug(state, { ...payload, stage: payload.stage! }, payload.action as "preview" | "run", user.userId)));
  } catch (error) { const safe = publicError(error); return json({ error: safe.message, code: safe.code }, safe.status); }
}
