import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isPrivatePath, releaseFiles, inspectRelease } from './release-files.mjs';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'palace-release-test-'));
  context.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('palace-release-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('clean source selection excludes local data, hosting metadata, history and arbitrary root files', async context => {
  const root = await fixture(context);
  for (const folder of ['local', '.git', '.openai', '.palace-data', 'node_modules', 'outputs']) {
    await mkdir(join(root, folder));
    await writeFile(join(root, folder, 'fixture.txt'), 'fixture');
  }
  await writeFile(join(root, 'README.md'), 'public');
  await writeFile(join(root, 'private-notes.txt'), 'private');
  assert.deepEqual(await releaseFiles(root), ['README.md', 'local/fixture.txt']);
});

test('private files nested in source directories stop the export', async context => {
  const root = await fixture(context);
  await mkdir(join(root, 'public'));
  await writeFile(join(root, 'public', 'vault.json'), '{}');
  await assert.rejects(releaseFiles(root), /Private file/);
  for (const name of ['a/.env.local', 'private.sqlite-wal', 'a/server-secrets.json', '.openai/hosting.json', 'a/private.key']) assert.equal(isPrivatePath(name), true);
  assert.equal(isPrivatePath('.env.example'), false);
  assert.equal(isPrivatePath('lib/server/provider.ts'), false);
});

test('release scan reports secret categories and paths without returning matched content', async context => {
  const root = await fixture(context);
  const secret = 'sk-' + 'a'.repeat(40);
  const oldProvider = String.fromCharCode(99, 104, 114, 49);
  await writeFile(join(root, 'README.md'), `${secret}\nhttps://api.${oldProvider}.com/v1`);
  const result = await inspectRelease(root, ['README.md']);
  assert.deepEqual(result.findings.map(finding => finding.rule).sort(), ['API key material', 'private provider branding']);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.manifest[0].sha256.length, 64);
});

test('release scan refuses paths outside its source root', async context => {
  const root = await fixture(context);
  await assert.rejects(inspectRelease(root, ['../outside.txt']), /escapes the project/);
});
