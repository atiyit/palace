import { z } from "zod";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { createInitialState } from "@/lib/seeds";
import { hydrateConfig, performAction } from "@/lib/server/engine";
import { PalaceError, publicError } from "@/lib/server/errors";
import { mutateState, readState } from "@/lib/server/store";
import type { AppState } from "@/lib/types";
import { withProviderSettings } from "@/lib/server/provider-settings";
import { upgradeAppState } from "@/lib/character-profile";
import { env } from 'cloudflare:workers';
import { runPendingCleanup } from '@/lib/server/data-cleanup';
import { activityRunner } from '@/lib/server/activity-runner';

export const dynamic = "force-dynamic";
const responseHeaders = { "Cache-Control": "private, no-store, max-age=0", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: responseHeaders });
const payloadSchema = z.object({
  action: z.enum(["recruit", "recruit.retry", "recruit.skip", "profile.enrich", "hire", "like", "adopt", "chat", "chat.image.retry", "task.create", "task.step", "task.pause", "task.resume", "task.finish", "task.message", "task.continue", "task.deliver", "memory.delete", "memory.update", "appointment.set", "appointment.remove", "settings", "portrait", "daily.step", "role.review", "member.trash", "member.restore", "member.delete", "data.clear", "cleanup.retry"]),
  requestId: z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  agentId: z.string().max(100).optional(), message: z.string().max(4000).optional(), brief: z.string().max(1800).optional(),
  title: z.string().max(2500).optional(), rounds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), participantCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), taskId: z.string().max(100).optional(),
  memoryId: z.string().max(100).optional(), content: z.string().max(600).optional(), exploration: z.number().finite().optional(), drama: z.number().finite().optional(),
  memoryLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), groupToolLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  groupImageLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), groupArtifactLimit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  eventId: z.string().max(100).optional(),
  duties: z.string().max(600).optional(),
  count: z.number().int().min(1).max(10).optional(), batchId: z.string().max(100).optional(), slot: z.number().int().min(1).max(10).optional(),
  messageId: z.string().max(95).optional(),
  imageId: z.string().min(1).max(100).optional(),
  proposalId: z.string().max(100).optional(), decision: z.enum(['approve','private','reject']).optional(), confirmation: z.string().max(50).optional(),
});

export async function GET() {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: "请先登录你的私人后宫。", code: "UNAUTHORIZED" }, 401);
    return await withProviderSettings(user.userId, async () => {
      const state = upgradeAppState(await readState<AppState>(user.userId, createInitialState));
      return json(hydrateConfig(state));
    });
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
    if (!origin || origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
      throw new PalaceError("请求来源不匹配，请在应用页面内操作。", 403, "ORIGIN_MISMATCH");
    }
    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new PalaceError("请求需要JSON格式。", 415);
    const body = await request.text();
    if (body.length > 16_000) throw new PalaceError("请求内容过长。", 413);
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { throw new PalaceError("请求JSON格式无效。"); }
    const parsed = payloadSchema.safeParse(raw);
    if (!parsed.success) throw new PalaceError("操作参数无效，请刷新页面后重试。");
    const payload = parsed.data;
    if (payload.action === 'data.clear' && activityRunner.active(user.userId)) throw new PalaceError('请先停止后台交流，再清除所有数据。', 409, 'ACTIVITY_RUNNING');
    let detail: { message?: string; taskId?: string } = {};
    let result = await mutateState<AppState>(user.userId, payload.requestId || crypto.randomUUID(), createInitialState, async state => {
        upgradeAppState(state);
        detail = await withProviderSettings(user.userId, () => {
          if (payload.action === 'data.clear' && activityRunner.active(user.userId)) throw new PalaceError('请先停止后台交流，再清除所有数据。', 409, 'ACTIVITY_RUNNING');
          return performAction(state, payload, user.userId);
        });
    });
    if (payload.action === 'data.clear') activityRunner.discard(user.userId);
    const replayed = result.replayed;
    if (result.state.pendingCleanup?.length) {
      try {
        result = await mutateState<AppState>(user.userId, crypto.randomUUID(), createInitialState, async state => {
          const cleanup = await runPendingCleanup(user.userId,state,env);
          detail.message = cleanup.message || (payload.action === 'data.clear' ? '所有庭院记录、图片、成果及API密钥已清除。' : '数据清理完成。');
        });
      } catch { detail.message = '记录已更新，存储清理尚未完成，请在数据管理中重试清理。'; }
    }
    if (replayed && payload.action === 'task.create') detail.taskId = result.state.tasks[result.state.tasks.length - 1]?.id;
    return await withProviderSettings(user.userId, async () => json({ state: hydrateConfig(upgradeAppState(result.state)), ...detail, replayed }));
  } catch (error) {
    const safe = publicError(error);
    return json({ error: safe.message, code: safe.code }, safe.status);
  }
}
