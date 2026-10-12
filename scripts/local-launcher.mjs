import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const recordPath = root => join(root, '.palace-runtime', 'server-session.json');
function readRecord(root) { try { return JSON.parse(readFileSync(recordPath(root), 'utf8')); } catch { return null; } }

export function validSession(record, root) {
  return record?.root === resolve(root) && Number.isInteger(record.pid) && record.pid > 0
    && Number.isInteger(record.port) && record.port >= 1024 && record.port <= 65535
    && /^[a-f0-9-]{36}$/.test(record.owner || '');
}

function processCommand(pid) {
  try {
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); (Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`], { encoding: 'utf8', windowsHide: true }).trim();
    }
    return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function ownedProcess(record, root) {
  if (!validSession(record, root)) return false;
  const command = processCommand(record.pid);
  return command.includes(join(root, 'scripts', 'serve-local.mjs')) && command.includes(`--owner=${record.owner}`);
}

export function projectServerRunning(project) {
  const root = resolve(project);
  if (ownedProcess(readRecord(root), root)) return true;
  try {
    const pid = Number(readFileSync(join(root, '.palace-data', 'server.pid'), 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 && processCommand(pid).includes(join(root, 'local', 'server.mjs'));
  } catch { return false; }
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
    const body = await response.json();
    return response.ok && body.app === 'palace-local' ? body : null;
  } catch { return null; }
}

export async function palaceAtInstallPort() {
  return Boolean(await health(Number(process.env.PALACE_PORT || 5173)));
}

function openBrowser(url) {
  const executable = process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['-NoProfile', '-Command', `Start-Process '${url}'`] : [url];
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`Open this address manually: ${url}`));
  child.unref();
}

export async function launch(project, { noBrowser = false } = {}) {
  const root = resolve(project);
  const port = Number(process.env.PALACE_PORT || 5173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PALACE_PORT must be an integer from 1024 to 65535.');
  const url = `http://127.0.0.1:${port}`;
  const runtime = join(root, '.palace-runtime');
  mkdirSync(runtime, { recursive: true });
  const existing = readRecord(root);
  if (ownedProcess(existing, root)) {
    if (existing.port !== port) throw new Error(`This project is already running on port ${existing.port}. Stop it before choosing a different port.`);
    if ((await health(port))?.instance !== existing.owner) throw new Error('The recorded server is still starting, is unresponsive, or no longer owns its port. Stop it before restarting.');
    console.log(`Palace is already running at ${url}`);
    if (!noBrowser) openBrowser(url);
    return;
  }
  if (await health(port)) throw new Error(`Another Palace session is already using ${url}. Stop that session or choose a different PALACE_PORT.`);
  const startupLock = join(runtime, 'startup-lock');
  try { mkdirSync(startupLock); } catch { throw new Error('Another launch may be in progress. If interrupted, rename .palace-runtime/startup-lock after checking the log.'); }
  let child;
  let session;
  try {
    const owner = randomUUID();
    const log = join(runtime, 'server.log');
    const fd = openSync(log, 'a');
    try {
      child = spawn(process.execPath, [join(root, 'scripts', 'serve-local.mjs'), `--owner=${owner}`], {
        cwd: root, detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
        env: { ...process.env, PORT: String(port), PALACE_PORT: String(port), PALACE_DATA_DIR: resolve(process.env.PALACE_DATA_DIR || join(root, '.palace-data')) },
      });
    } finally { closeSync(fd); }
    let failure;
    child.once('error', error => { failure = error; });
    child.unref();
    session = { root, pid: child.pid, owner, port, startedAt: new Date().toISOString() };
    if (!Number.isInteger(child.pid)) throw new Error(`Could not start the server. See ${log}`);
    writeFileSync(recordPath(root), JSON.stringify(session, null, 2));
    for (let attempt = 0; attempt < 90; attempt++) {
      await delay(500);
      if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited during startup. See ${log}`);
      const ready = await health(port);
      if (ready) {
        if (ready.instance !== owner) throw new Error(`The port was claimed by another Palace instance. See ${log}`);
        if (!ownedProcess(session, root)) throw new Error(`The port was claimed by another process. See ${log}`);
        console.log(`Palace is running at ${url}\nServer log: ${log}`);
        if (!noBrowser) openBrowser(url);
        return;
      }
    }
    throw new Error(`Server startup timed out. See ${log}`);
  } catch (error) {
    if (session && ownedProcess(session, root)) {
      process.kill(session.pid, 'SIGTERM');
      for (let attempt = 0; attempt < 40; attempt++) {
        await delay(100);
        try { process.kill(session.pid, 0); } catch { break; }
      }
    }
    if (session && !ownedProcess(session, root) && readRecord(root)?.owner === session.owner) rmSync(recordPath(root), { force: true });
    throw error;
  } finally {
    const { rmdirSync } = await import('node:fs');
    rmdirSync(startupLock);
  }
}

export async function stop(project) {
  const root = resolve(project);
  const record = readRecord(root);
  if (!record) { console.log('No launcher-owned server is recorded.'); return; }
  if (!ownedProcess(record, root)) {
    console.log('The recorded server is no longer running, or its identity has changed. No process was stopped.');
    rmSync(recordPath(root), { force: true });
    return;
  }
  process.kill(record.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(250);
    try { process.kill(record.pid, 0); } catch {
      rmSync(recordPath(root), { force: true });
      console.log('Palace stopped. Your saved data is preserved.');
      return;
    }
  }
  throw new Error('The stop signal was sent but the process has not exited yet. Check .palace-runtime/server.log before retrying.');
}
