import { createServer as createHttpServer } from 'node:http';
import { Readable } from 'node:stream';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || process.env.PALACE_PORT || 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本地端口必须在 1024 至 65535 之间。');
const hostname = `127.0.0.1:${port}`;
const origin = `http://${hostname}`;
const dataDirectory = resolve(process.env.PALACE_DATA_DIR || join(project, '.palace-data')).replaceAll('\\', '/').toLowerCase();
const apiRoutes = new Map([
  ['/api/palace', 'app/api/palace/route.ts'],
  ['/api/debug', 'app/api/debug/route.ts'],
  ['/api/provider-settings', 'app/api/provider-settings/route.ts'],
  ['/api/user-profile', 'app/api/user-profile/route.ts'],
  ['/api/chat-uploads', 'app/api/chat-uploads/route.ts'],
  ['/api/activity', 'app/api/activity/route.ts'],
  ['/api/recruitment-ideas', 'app/api/recruitment-ideas/route.ts'],
]);
let vite;

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}

/** 主人，这是本机服务器的同源迎客检查：我会逐一验证 Host 头、Origin 头、Sec-Fetch-Site 和 Referer。
 * Host 必须匹配；存在的 Origin 和 Referer 必须同源，Sec-Fetch-Site 为 cross-site 时直接谢绝。
 * 这是服务端请求边界检查；API 的 POST 请求还在下方由我单独要求同源 Origin 哦。 */
function sameOrigin(request) {
  if (request.headers.host !== hostname) return false;
  if (request.headers.origin && request.headers.origin !== origin) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (request.headers.referer) {
    try { if (new URL(request.headers.referer).origin !== origin) return false; }
    catch { return false; }
  }
  return true;
}

function sensitivePath(path) {
  let decoded;
  try { decoded = decodeURIComponent(path).replaceAll('\\', '/').toLowerCase(); }
  catch { return true; }
  return decoded.includes(dataDirectory)
    || /(?:^|\/)\.(?:palace[^/]*|sites-runtime|wrangler|git)(?:\/|$)/.test(decoded)
    || /(?:^|\/)\.(?:env|dev\.vars)(?:[^/]*)(?:\/|$)/.test(decoded)
    || /\.(?:sqlite[^/]*|key|pem|p12|pfx)(?:\/|$)/.test(decoded)
    || /(?:^|\/)local\/(?:storage|runtime|auth)\.ts$|(?:^|\/)local\/bootstrap\.mjs$/.test(decoded)
    || /^\/(?:storage|runtime|auth)\.ts$|^\/bootstrap\.mjs$/.test(decoded);
}

async function readBody(request, maximum = 400000) {
  if (Number(request.headers['content-length'] || 0) > maximum) throw Object.assign(new Error('请求内容过大。'), { status: 413 });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximum) throw Object.assign(new Error('请求内容过大。'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createHttpServer(async (request, response) => {
  try {
    if (!sameOrigin(request)) return sendJson(response, 403, { error: '仅允许从本机应用地址访问。' });
    const url = new URL(request.url || '/', origin);
    if (url.origin !== origin || sensitivePath(url.pathname)) return sendJson(response, 403, { error: '此路径不可访问。' });
    if (!url.pathname.startsWith('/api/')) return vite.middlewares(request, response, () => sendJson(response, 404, { error: '页面不存在。' }));
    if (!['GET', 'POST'].includes(request.method || '')) return sendJson(response, 405, { error: '不支持的请求方法。' });
    if (request.method === 'POST' && request.headers.origin !== origin) return sendJson(response, 403, { error: '请求来源不匹配。' });
    if (url.pathname === '/api/health' && request.method === 'GET') return sendJson(response, 200, { app: 'palace-local', status: 'ok', instance: process.env.PALACE_LAUNCH_OWNER || undefined });
    const portrait = /^\/api\/portraits\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
    const artifact = /^\/api\/artifacts\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
    const source = portrait ? 'app/api/portraits/[id]/route.ts' : artifact ? 'app/api/artifacts/[id]/route.ts' : apiRoutes.get(url.pathname);
    if (!source) return sendJson(response, 404, { error: '接口不存在。' });
    const routeModule = await vite.ssrLoadModule(join(project, source));
    const handler = routeModule[request.method];
    if (typeof handler !== 'function') return sendJson(response, 405, { error: '不支持的请求方法。' });
    const { withLocalRequest } = await vite.ssrLoadModule(join(project, 'local/auth.ts'));
    const body = request.method === 'POST' ? await readBody(request, ['/api/user-profile', '/api/chat-uploads'].includes(url.pathname) ? 14_000_000 + 16_384 : 400000) : undefined;
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const webRequest = new Request(url, { method: request.method, headers, body });
    const objectId = portrait?.[1] || artifact?.[1];
    const result = await withLocalRequest(() => handler(webRequest, objectId ? { params: Promise.resolve({ id: objectId }) } : undefined));
    if (!(result instanceof Response)) throw new Error('接口未返回有效响应。');
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    if (result.body) Readable.fromWeb(result.body).pipe(response); else response.end();
  } catch (error) {
    if (!response.headersSent) sendJson(response, error?.status === 413 ? 413 : 500, { error: error?.status === 413 ? '请求内容过大。' : '本地服务处理失败，请查看终端状态并重试。' });
    else response.end();
    console.error('Local request failed:', error instanceof Error ? error.name : 'UnknownError');
  }
});
server.requestTimeout = 380000;
server.headersTimeout = 15000;
server.timeout = 390000;
vite = await createViteServer({ configFile: join(project, 'local/vite.config.ts'), server: { middlewareMode: true, hmr: { server, host: '127.0.0.1', port }, allowedHosts: ['127.0.0.1'] } });
// 我先替主人把存储初始化好，让加密保管库的问题在 UI 服务启动前就暴露出来呀。
await vite.ssrLoadModule(join(project, 'local/runtime.ts'));
server.on('error', async error => { console.error(error.code === 'EADDRINUSE' ? `本机端口 ${port} 已被其他程序占用。` : '本地服务器启动失败。'); await vite.close(); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`后宫实验室本地版已启动：${origin}`));
let stopping = false;
async function shutdown() { if (stopping) return; stopping = true; await vite.close(); server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
