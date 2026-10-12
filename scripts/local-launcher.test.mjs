import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { launch, stop, validSession, projectServerRunning } from './local-launcher.mjs';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'palace-launcher-中文 space-'));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, '.palace-data'));
  await writeFile(join(root, '.palace-data', 'saved.txt'), 'keep this saved data');
  await writeFile(join(root, 'scripts', 'serve-local.mjs'), `
    import { createServer } from 'node:http';
    const owner = process.argv.find(arg=>arg.startsWith('--owner=')).slice(8);
    const server = createServer((req, res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({app:'palace-local',status:'ok',instance:owner})); });
    server.listen(Number(process.env.PORT),'127.0.0.1');
    process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
  `);
  const originalPort = process.env.PALACE_PORT;
  process.env.PALACE_PORT = String(await availablePort());
  context.after(async () => {
    await stop(root);
    if (originalPort === undefined) delete process.env.PALACE_PORT; else process.env.PALACE_PORT = originalPort;
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('palace-launcher-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('launcher reuses its own process and stops it without removing saved data in a Unicode path', async context => {
  const root = await fixture(context);
  await launch(root, { noBrowser: true });
  const first = JSON.parse(await readFile(join(root, '.palace-runtime', 'server-session.json'), 'utf8'));
  assert.equal(projectServerRunning(root), true);
  await launch(root, { noBrowser: true });
  const second = JSON.parse(await readFile(join(root, '.palace-runtime', 'server-session.json'), 'utf8'));
  assert.equal(first.pid, second.pid);
  await stop(root);
  assert.equal(projectServerRunning(root), false);
  assert.equal(await readFile(join(root, '.palace-data', 'saved.txt'), 'utf8'), 'keep this saved data');
});

test('stop refuses a PID whose command does not carry this project and owner token', async context => {
  const root = await fixture(context);
  await mkdir(join(root, '.palace-runtime'));
  await writeFile(join(root, '.palace-runtime', 'server-session.json'), JSON.stringify({ root, pid: process.pid, port: Number(process.env.PALACE_PORT), owner: '00000000-0000-0000-0000-000000000000' }));
  await stop(root);
  assert.equal(process.kill(process.pid, 0), true);
});

test('session validation rejects other project paths, invalid PIDs and ports', () => {
  const root = resolve('fixture');
  const good = { root, pid: 123, port: 5173, owner: '00000000-0000-0000-0000-000000000000' };
  assert.equal(validSession(good, root), true);
  for (const change of [{ root: resolve('other') }, { pid: -1 }, { port: 0 }, { port: 70000 }, { owner: 'invalid' }]) assert.equal(validSession({ ...good, ...change }, root), false);
});

test('failed session recording stops the process created by this launch', async context => {
  const root = await fixture(context);
  await mkdir(join(root, '.palace-runtime', 'server-session.json'), { recursive: true });
  await assert.rejects(launch(root, { noBrowser: true }), /EISDIR|EPERM/);
  await assert.rejects(fetch(`http://127.0.0.1:${process.env.PALACE_PORT}/api/health`, { signal: AbortSignal.timeout(1000) }));
});

test('a different instance identity cannot satisfy startup health checks', async context => {
  const root = await fixture(context);
  const fixtureFile = join(root, 'scripts', 'serve-local.mjs');
  const code = await readFile(fixtureFile, 'utf8');
  await writeFile(fixtureFile, code.replace('instance:owner', "instance:'another-instance'"));
  await assert.rejects(launch(root, { noBrowser: true }), /another Palace instance/);
  assert.equal(projectServerRunning(root), false);
});
