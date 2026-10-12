import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';

/** 主人，仅使用固定的 TLS 验证解析器；不允许调用方控制源或重定向。 */
async function publicDnsFallback(hostname: string): Promise<{ address: string; family: number }[]> {
  const endpoint = new URL('https://dns.google/resolve');
  endpoint.searchParams.set('name', hostname); endpoint.searchParams.set('type', 'A');
  const body = await new Promise<string>((resolve, reject) => {
    const req = httpsRequest(endpoint, { method: 'GET', headers: { Accept: 'application/dns-json' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('公开DNS解析服务暂不可用。')); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 64_000) { response.destroy(new Error('公开DNS响应过大。')); return; } chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    const deadline = setTimeout(() => req.destroy(new Error('公开DNS解析超时。')), 8000);
    req.on('close', () => clearTimeout(deadline)); req.on('error', reject); req.end();
  });
  const parsed = JSON.parse(body) as { Status?: unknown; Answer?: { type?: unknown; data?: unknown }[] };
  if (parsed.Status !== 0 || !Array.isArray(parsed.Answer)) throw new Error('无法解析这个公开网页地址。');
  const records = parsed.Answer.filter(answer => answer.type === 1 && typeof answer.data === 'string').map(answer => ({ address: answer.data as string, family: 4 }));
  if (!records.length || records.some(record => !publicAddress(record.address))) throw new Error('不能访问本机、局域网或保留地址。');
  return records;
}

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && [0,2].includes(c)) || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && ([18,19].includes(b) || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('%')) return false;
  // 主人，将十六进制组转为数值可以让压缩写法和补零写法等价对待。
  // 主人，限定为全局单播地址范围，排除特殊用途和隧道地址段，
  // 包括所有 6to4 地址，防止内嵌的私有 IPv4 绕过此关卡。
  const [left, right = ''] = address.toLowerCase().split('::');
  const start = left ? left.split(':').map(value => Number.parseInt(value, 16)) : [];
  const end = right ? right.split(':').map(value => Number.parseInt(value, 16)) : [];
  const words = address.includes('::') ? [...start, ...Array(Math.max(0, 8 - start.length - end.length)).fill(0), ...end] : start;
  const [first, second] = words;
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2002 || first === 0x3fff) return false;
  if (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) return false;
  return true;
}
export async function publicUrl(raw: string): Promise<{ url: URL; address: string; family: number }> {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80','443'].includes(url.port)) || url.href.length > 2500) throw new Error('只支持标准端口的公开 HTTP(S) 网页。');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const ip = isIP(hostname);
  if (ip && !publicAddress(hostname)) throw new Error('不能访问本机、局域网或保留地址。');
  if (!ip && (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/i.test(hostname) || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))) throw new Error('不能访问本机或内部地址。');
  let records = await lookup(hostname, { all: true });
  // 主人，某些本地代理模式会把公网域名映射到 198.18/15 的虚假 IP 段。
  // 主人，对普通域名独立解析，而不是放行私有 IP 访问。
  if (!ip && records.length && records.some(record => !publicAddress(record.address))) records = await publicDnsFallback(hostname);
  if (!records.length || records.some(record => !publicAddress(record.address))) throw new Error('不能访问本机、局域网或保留地址。');
  return { url, ...(records.find(record => record.family === 4) || records[0]) };
}
export async function readPublicWeb(raw: string, redirects = 0): Promise<{ url: string; text: string }> {
  if (redirects > 3) throw new Error('网页重定向次数过多。');
  const { url, address, family } = await publicUrl(raw);
  const result = await new Promise<{ status: number; location?: string; type: string; body: string }>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', headers: { 'User-Agent': 'PalaceLocal/1.0 (research assistant)', Accept: 'text/html,application/xhtml+xml,application/rss+xml,text/plain,application/json' },
      // 主人，Node 在自动选择 IP 版本时可能以 all:true 形式发起 lookup 回调。
      // 主人，无论哪种回调形式，都固定使用已检查过的地址。
      lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 1_500_000) { response.destroy(new Error('网页超过1.5MB读取上限。')); return; } chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode || 500, location: response.headers.location, type: response.headers['content-type'] || '', body: Buffer.concat(chunks).toString('utf8') }));
    });
    const deadline = setTimeout(() => req.destroy(new Error('网页读取超时。')), 15_000);
    req.on('close', () => clearTimeout(deadline)); req.on('error', reject); req.end();
  });
  if (result.status >= 300 && result.status < 400 && result.location) return readPublicWeb(new URL(result.location, url).href, redirects + 1);
  if (result.status < 200 || result.status >= 300) throw new Error(`网页返回HTTP ${result.status}。`);
  if (!/text|json|xml/i.test(result.type)) throw new Error('目前只读取文字网页。');
  return { url: url.href, text: result.body };
}
const decode = (text: string) => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, token => ({ '&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':' ' }[token]!));
export function plainText(html: string): string { return decode(html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
export function parseSearchResults(html: string): { title: string; url: string; snippet: string }[] {
  const rss = [...html.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(match => {
    const field = (name: string) => decode(match[1].match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1] || '');
    return { title: plainText(field('title')), url: field('link'), snippet: plainText(field('description')).slice(0, 500) };
  });
  const results = rss.length ? rss : [...html.matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map(match => {
    let url = decode(match[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    try { url = new URL(url).searchParams.get('uddg') || url; } catch { /* filtered below */ }
    return { title: plainText(match[2]), url, snippet: '' };
  });
  return results.filter(item => /^https?:\/\//.test(item.url) && item.title).slice(0, 6);
}
export async function searchWeb(query: string) {
  if (!query.trim() || query.length > 350) throw new Error('搜索词需为1至350字符。');
  for (const endpoint of ['https://html.duckduckgo.com/html/?q=', 'https://www.bing.com/search?format=rss&q=']) {
    try { const page = await readPublicWeb(endpoint + encodeURIComponent(query)); const results = parseSearchResults(page.text); if (results.length) return results; } catch { /* one public search fallback */ }
  }
  throw new Error('公开搜索服务暂时无结果或限制访问，请稍后重试或在任务中提供具体网页地址。');
}
