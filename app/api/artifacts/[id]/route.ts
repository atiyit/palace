import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { readState } from '@/lib/server/store';
import { createInitialState } from '@/lib/seeds';
import type { AppState } from '@/lib/types';

export async function GET(request: Request, context: { params: Promise<{id:string}> }) {
  const headers = { 'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'" };
  const user = await getChatGPTUser();
  if (!user) return new Response('请先登录。',{status:401,headers});
  const {id} = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !env.BUCKET) return new Response('文件不存在。',{status:404,headers});
  const state = await readState<AppState>(user.userId,createInitialState);
  const artifact = state.tasks.flatMap(task=>task.artifacts || []).find(item=>item.id===id);
  if (!artifact || state.pendingCleanup?.some(job=>job.kind==='all')) return new Response('文件不存在。',{status:404,headers});
  const object = await env.BUCKET.get(`artifacts/${encodeURIComponent(user.userId)}/${id}`);
  if (!object) return new Response('文件不存在。',{status:404,headers});
  const rasterImage = artifact.kind === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType);
  const inline = rasterImage && new URL(request.url).searchParams.get('inline') === '1';
  return new Response(object.body,{headers:{...headers,'Content-Type':rasterImage ? artifact.mimeType : `${artifact.mimeType}; charset=utf-8`,'Content-Disposition':`${inline ? 'inline' : 'attachment'}; filename="artifact.${artifact.name.split('.').pop()?.replace(/[^a-z0-9]/gi,'') || 'txt'}"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`}});
}
