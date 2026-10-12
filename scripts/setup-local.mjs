import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { launch, stop, projectServerRunning, palaceAtInstallPort } from './local-launcher.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = join(root, '.palace-runtime');
const args = process.argv.slice(2);
const allowed = new Set(['--npm', '--install-only', '--repair', '--no-browser', '--stop', '--private-runtime']);
let npm = process.env.npm_execpath;
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
  if (args[i] === '--npm') { npm = args[++i]; if (!npm) throw new Error('--npm requires the npm-cli.js path.'); }
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required. Use the platform installation launcher.');
mkdirSync(runtime, { recursive: true });
if (args.includes('--stop')) {
  await stop(root);
} else {
  if (!npm || !existsSync(npm)) throw new Error('npm is missing. Use the platform installation launcher.');
  npm = realpathSync(npm);
  const lock = join(runtime, 'install-lock');
  try { mkdirSync(lock); }
  catch { throw new Error('Another installation may be running. If it was interrupted, close its terminal and rename .palace-runtime/install-lock before retrying.'); }
  try {
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    // 请容我把 package.json、锁文件、.npmrc、平台、架构和 Node 版本一起揉进这枚指纹哈希里。
    // 换了系统或升级 Node 之后指纹自然会变，就会触发 npm ci 重装——这样能替主人清掉跨平台残留的旧依赖呢。
    const fingerprint = createHash('sha256').update(JSON.stringify({
      node: process.version, platform: process.platform, arch: process.arch,
      package: readFileSync(join(root, 'package.json'), 'utf8'),
      lock: readFileSync(join(root, 'package-lock.json'), 'utf8'),
      npmrc: existsSync(join(root, '.npmrc')) ? readFileSync(join(root, '.npmrc'), 'utf8') : '',
      options: 'ci --include=dev --include=optional --no-audit --no-fund',
    })).digest('hex');
    const stamp = join(runtime, 'dependencies.json');
    let previous;
    try { previous = JSON.parse(readFileSync(stamp, 'utf8')); } catch {}
    const check = () => spawnSync(process.execPath, [join(root, 'scripts/doctor.mjs')], { cwd: root, stdio: 'pipe', windowsHide: true });
    if (args.includes('--repair') || previous?.fingerprint !== fingerprint || check().status !== 0) {
      // 主人，如果本项目的后台服务还在跑，这道门由我替您守着——阻止重建 node_modules，防止运行中的进程加载到不完整的依赖哦。
      if (projectServerRunning(root) || await palaceAtInstallPort()) throw new Error('A Palace server is running. Stop it before installing or repairing dependencies, then run the launcher again. If another project owns the configured port, choose a different PALACE_PORT.');
      console.log('Installing the locked dependencies, including local build and native packages...');
      const env = { ...process.env, npm_config_cache: join(runtime, 'npm-cache'), SHARP_IGNORE_GLOBAL_LIBVIPS: '1' };
      const oldPath = Object.keys(env).find(key => key.toLowerCase() === 'path');
      const searchPath = oldPath ? env[oldPath] : '';
      if (oldPath) delete env[oldPath];
      env[process.platform === 'win32' ? 'Path' : 'PATH'] = `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${searchPath}`;
      // --include=dev 保留构建与开发依赖，当前运行模式需要它们；--include=optional 则替主人拉取平台相关的原生包，比如 sharp。
      const installed = spawnSync(process.execPath, [npm, 'ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund'], { cwd: root, env, stdio: 'inherit', windowsHide: true });
      if (installed.error || installed.status !== 0) throw new Error('Dependency installation failed. Check the npm error above, then retry the same launcher. Saved data was not removed.');
      const checked = check();
      process.stdout.write(checked.stdout || '');
      process.stderr.write(checked.stderr || '');
      if (checked.status !== 0) throw new Error('Dependency verification failed. Retry with --repair after resolving the reported problem.');
      writeFileSync(stamp, JSON.stringify({ fingerprint, installedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch }, null, 2));
    } else {
      console.log('Dependencies are ready; the existing installation will be reused.');
    }
    if (args.includes('--install-only')) console.log('Installation is complete. Run the launcher again to open Palace.');
    else await launch(root, { noBrowser: args.includes('--no-browser') });
  } finally {
    rmSync(join(lock, 'owner.json'), { force: true });
    const { rmdirSync } = await import('node:fs');
    rmdirSync(lock);
  }
}
