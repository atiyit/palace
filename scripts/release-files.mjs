import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const sourceDirectories = new Set(['app', 'build', 'components', 'db', 'docs', 'drizzle', 'examples', 'hooks', 'lib', 'local', 'public', 'scripts', 'tests', 'vendor', '.github']);
export const sourceRootFiles = new Set([
  '.env.example', '.gitignore', '.gitattributes', '.npmrc', '.node-version', '.nvmrc',
  'README.md', 'LICENSE', 'LICENSE.md', 'UNLICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'NOTICE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'package-lock.json', 'components.json', 'cloudflare-env.d.ts', 'drizzle.config.ts',
  'eslint.config.mjs', 'next.config.ts', 'postcss.config.mjs', 'tsconfig.json', 'vite.config.ts',
  '启动后宫.cmd', '停止后宫.cmd', '一键安装并启动.cmd', '一键安装并启动.command', '一键安装并启动.sh', '停止后宫.command', '停止后宫.sh',
]);

const forbiddenSegments = /^(?:\.git|\.openai|\.palace[^/]*|\.sites-runtime|\.wrangler|\.codex|\.agents|node_modules|outputs|work|coverage|dist(?:-local)?|\.next|\.vinext)$/i;
const forbiddenFile = /(?:\.(?:sqlite[^.]*|db(?:-.*)?|pem|key|p12|pfx|log|pid|tsbuildinfo)|(?:^|\/)(?:vault|server-secrets)(?:\.[^/]*)?)$/i;
const oldProvider = String.fromCharCode(99, 104, 114, 49);
const checks = [
  ['private provider branding', new RegExp(oldProvider, 'i')],
  ['private hosting address', /\b[a-z0-9-]+\.chatgpt\.site\b/i],
  ['API key material', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gsk_[A-Za-z0-9]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['local user directory', /\b[A-Z]:[\\/]Users[\\/][^\s"'<>]+/i],
];

function hasEmbeddedCredentials(content, file) {
  for (const match of content.matchAll(/https?:\/\/[^\s"'<>`]+/gi)) {
    try {
      const url = new URL(match[0]);
      if (!url.username && !url.password) continue;
      const testHost = /^(?:[a-z0-9-]+\.)?example\.com$|^localhost$/i.test(url.hostname);
      const testPair = ['user:password', 'name:password', 'user:key'].includes(`${url.username}:${url.password}`);
      if (file.startsWith('tests/') && testHost && testPair) continue;
      return true;
    } catch {}
  }
  return false;
}

export function isPrivatePath(file) {
  const normalized = file.replaceAll('\\', '/');
  return normalized.split('/').some(part => forbiddenSegments.test(part))
    || forbiddenFile.test(normalized)
    || normalized.split('/').some(part => /^(?:\.env|\.dev\.vars)/i.test(part) && part !== '.env.example');
}

export async function releaseFiles(root = projectRoot) {
  const files = [];
  async function visit(directory) {
    for (const item of await readdir(join(root, directory), { withFileTypes: true })) {
      const name = directory ? `${directory}/${item.name}` : item.name;
      if (!directory && !sourceDirectories.has(item.name) && !sourceRootFiles.has(item.name)) continue;
      if (isPrivatePath(name)) throw new Error(`Private file found inside a source directory: ${name}`);
      if (item.isSymbolicLink()) throw new Error(`Symbolic links are not exported: ${name}`);
      if (item.isDirectory()) await visit(name);
      else if (item.isFile()) files.push(name);
      else throw new Error(`Unsupported source entry: ${name}`);
    }
  }
  await visit('');
  return files.sort();
}

export async function inspectRelease(root, files) {
  const findings = [];
  const manifest = [];
  for (const file of files) {
    const absolute = resolve(root, file);
    const within = relative(resolve(root), absolute);
    if (!within || within === '..' || within.startsWith(`..${sep}`)) throw new Error('Source path escapes the project.');
    if (isPrivatePath(file)) { findings.push({ file, rule: 'private path' }); continue; }
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Only regular files can be exported: ${file}`);
    const bytes = await readFile(absolute);
    const content = bytes.toString('utf8');
    for (const [rule, expression] of checks) if (expression.test(content)) findings.push({ file, rule });
    if (hasEmbeddedCredentials(content, file)) findings.push({ file, rule: 'embedded URL credentials' });
    manifest.push({ path: file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { findings, manifest };
}

export function printFindings(findings) {
  for (const finding of findings) console.error(`BLOCKED ${finding.file}: ${finding.rule}`);
}

export function assertReleaseReady(files) {
  const missing = ['README.md', 'package.json', 'package-lock.json', 'local/server.mjs', 'local/vite.config.ts'].filter(file => !files.includes(file));
  if (!['LICENSE', 'LICENSE.md', 'UNLICENSE'].some(file => files.includes(file))) missing.push('LICENSE');
  if (missing.length) throw new Error(`Required release files are missing: ${missing.join(', ')}`);
}
