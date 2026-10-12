import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { readState } from '@/lib/server/store';
import { createInitialState } from '@/lib/seeds';
import { referencedImageIds } from '@/lib/member-lifecycle';
import type { AppState } from '@/lib/types';

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (!user) return new Response("请先登录。", { status: 401, headers });
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !env.BUCKET) return new Response("图片不存在。", { status: 404, headers });
  const state = await readState<AppState>(user.userId,createInitialState);
  if (state.pendingCleanup?.some(job=>job.kind==='all') || !referencedImageIds(state).has(id)) return new Response('图片不存在。',{status:404,headers});
  const object = await env.BUCKET.get(`portraits/${encodeURIComponent(user.userId)}/${id}`);
  if (!object) return new Response("图片不存在。", { status: 404, headers });
  return new Response(object.body, { headers: { ...headers, "Content-Type": object.httpMetadata?.contentType || "image/png" } });
}
