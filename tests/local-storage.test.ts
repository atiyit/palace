import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { stateRepository } from '../lib/server/repository.ts';
import { providerSettingsRepository } from '../lib/server/provider-settings-repository.ts';
import { decryptApiKey, encryptApiKey } from '../lib/server/provider-config-core.ts';
import { clearAllData } from '../lib/member-lifecycle.ts';
import { createInitialState } from '../lib/seeds.ts';
import { runPendingCleanup } from '../lib/server/data-cleanup.ts';
import type { AppState } from '../lib/types.ts';

// Import only after choosing a new isolated directory. Never read a user's vault.
const prefix = 'palace-local-storage-test-';
const temporaryRoot = mkdtempSync(join(tmpdir(), prefix));
const originalDataDirectory = process.env.PALACE_DATA_DIR;
process.env.PALACE_DATA_DIR = join(temporaryRoot, 'private-data');
const storage = await import('../local/storage.ts');
if (originalDataDirectory === undefined) delete process.env.PALACE_DATA_DIR;
else process.env.PALACE_DATA_DIR = originalDataDirectory;

after(context => {
  if (!existsSync(temporaryRoot)) return;
  const target = realpathSync(temporaryRoot);
  // The only recursive cleanup target is the exact directory created above.
  assert.equal(dirname(target), realpathSync(tmpdir()));
  assert.ok(basename(target).startsWith(prefix));
  assert.equal(target, realpathSync(resolve(temporaryRoot)));
  try { rmSync(target, { recursive: true, force: true }); }
  catch (error) {
    // The production adapter deliberately retains its SQLite connection. On
    // Windows its open database may remain locked until this worker exits.
    if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    if ('diagnostic' in context) context.diagnostic('Windows retained an open SQLite fixture; only the newly created test directory remains for OS cleanup.');
  }
});

test('real local migrations are repeatable and reopening preserves repository state', async () => {
  const path = join(temporaryRoot, 'persistence', 'palace.sqlite');
  const first = storage.localDatabase(path);
  const initial = () => ({ count: 0, memories: [] as string[] });
  await stateRepository(first).mutateState('fixture-owner', 'first-request', initial, async state => {
    state.count = 7;
    state.memories.push('持久化的共同经历');
  });
  const migrationNames = readdirSync(join(storage.PROJECT_DIRECTORY, 'drizzle')).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  const appliedBefore = await first.prepare('SELECT name,applied_at FROM _local_migrations ORDER BY name').all<{ name: string; applied_at: string }>();
  assert.deepEqual(appliedBefore.results.map(row => row.name), migrationNames);

  const reopened = storage.localDatabase(path);
  assert.deepEqual(await stateRepository(reopened).readState('fixture-owner', initial), { count: 7, memories: ['持久化的共同经历'] });
  assert.deepEqual((await reopened.prepare('SELECT name,applied_at FROM _local_migrations ORDER BY name').all()).results, appliedBefore.results);
  assert.equal(await reopened.prepare('SELECT version FROM palace_states WHERE user_id=?').bind('fixture-owner').first('version'), 1);
  const replay = await stateRepository(reopened).mutateState('fixture-owner', 'first-request', initial, async () => assert.fail('a persisted request must not be repeated after reopening'));
  assert.equal(replay.replayed, true);
  assert.equal(replay.state.count, 7);
});

test('separate real SQLite connections enforce one state lease and release it after commit', async () => {
  const path = join(temporaryRoot, 'leases', 'palace.sqlite');
  const first = stateRepository(storage.localDatabase(path));
  const second = stateRepository(storage.localDatabase(path));
  const initial = () => ({ count: 0 });
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pending = first.mutateState('fixture-owner', 'held-request', initial, async state => {
    entered();
    await gate;
    state.count++;
  });
  await enteredPromise;
  try {
    await assert.rejects(second.mutateState('fixture-owner', 'competing-request', initial, async () => assert.fail('competing connection must not reach the model operation')), { code: 'BUSY' });
    assert.equal((await second.readState('fixture-owner', initial)).count, 0);
  } finally { release(); }
  await pending;
  await second.mutateState('fixture-owner', 'after-release', initial, async state => { state.count++; });
  assert.equal((await first.readState('fixture-owner', initial)).count, 2);
});

test('a failed migration rolls back its schema and tracking row while preserving earlier data', async () => {
  const fixtures = join(temporaryRoot, 'migration-fixtures');
  const empty = join(temporaryRoot, 'empty-migrations');
  mkdirSync(fixtures); mkdirSync(empty);
  writeFileSync(join(fixtures, '0000_seed.sql'), "CREATE TABLE kept (value TEXT); INSERT INTO kept VALUES ('existing-data');");
  const failing = join(fixtures, '0001_update.sql');
  writeFileSync(failing, 'CREATE TABLE incomplete (value TEXT); INSERT INTO nonexistent_table VALUES (1);');
  const path = join(temporaryRoot, 'failed-migration', 'palace.sqlite');
  assert.throws(() => storage.localDatabase(path, fixtures), /nonexistent_table/);
  const inspect = storage.localDatabase(path, empty);
  assert.equal(await inspect.prepare('SELECT value FROM kept').first('value'), 'existing-data');
  assert.equal(await inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='incomplete'").first(), null);
  assert.equal(await inspect.prepare('SELECT count(*) AS total FROM _local_migrations').first('total'), 1);

  writeFileSync(failing, "CREATE TABLE complete (value TEXT); INSERT INTO complete VALUES ('recovered');");
  const recovered = storage.localDatabase(path, fixtures);
  assert.equal(await recovered.prepare('SELECT value FROM complete').first('value'), 'recovered');
  assert.equal(await recovered.prepare('SELECT count(*) AS total FROM kept').first('total'), 1);
  assert.equal(await recovered.prepare('SELECT count(*) AS total FROM _local_migrations').first('total'), 2);
});

test('the local portrait bucket round-trips binary bytes and metadata, including overwrite', async () => {
  const root = join(temporaryRoot, 'portrait-fixtures');
  const bucket = storage.localBucket(root);
  const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 13, 10, 0]);
  assert.equal(await bucket.get('fixture-owner/missing'), null);
  await bucket.put('fixture-owner/portrait', bytes, { httpMetadata: { contentType: 'image/webp' } });
  const result = await bucket.get('fixture-owner/portrait');
  assert.ok(result);
  assert.equal(result.httpMetadata?.contentType, 'image/webp');
  assert.deepEqual(new Uint8Array(await new Response(result.body).arrayBuffer()), bytes);
  await bucket.put('fixture-owner/portrait', new Uint8Array([1, 2, 3]));
  const replacement = await bucket.get('fixture-owner/portrait');
  assert.ok(replacement);
  assert.equal(replacement.httpMetadata?.contentType, 'image/png');
  assert.deepEqual(new Uint8Array(await new Response(replacement.body).arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.deepEqual(readdirSync(join(root, 'fixture-owner')), ['portrait.json']);
});

test('portrait get and put reject traversal and absolute paths without creating outside files', async () => {
  const root = join(temporaryRoot, 'bounded-portraits');
  const bucket = storage.localBucket(root);
  for (const key of ['../escape', '/absolute', 'C:/absolute', 'a/../escape', 'a/./image', 'a//image', '..\\escape', '', 'a/'.repeat(160)]) {
    await assert.rejects(bucket.put(key, new Uint8Array([1])), /路径/);
    await assert.rejects(bucket.get(key), /路径/);
  }
  assert.deepEqual(readdirSync(root), []);
  assert.equal(existsSync(join(temporaryRoot, 'escape.json')), false);
});

test('bootstrap encrypts independent defaults, keeps a stable vault and refuses accidental replacement', async () => {
  assert.equal(storage.DATA_DIRECTORY, resolve(temporaryRoot, 'private-data'));
  const secret = storage.localVaultSecret();
  assert.equal(storage.localVaultSecret(), secret);
  assert.equal(Buffer.from(secret, 'base64').length, 32);
  const initialDefaults = await storage.readLocalDefaults(secret);
  for (const kind of ['text', 'image'] as const) {
    assert.equal(initialDefaults[kind].baseUrl, 'https://api.example.com/v1');
    assert.equal(initialDefaults[kind].apiKey, '');
  }
  assert.equal(initialDefaults.text.model, 'claude-opus-4-6');
  const keys = { text: 'test-only-bootstrap-text-key', image: 'test-only-bootstrap-image-key' };
  await storage.bootstrapLocalDefaults({
    text: { baseUrl: 'text.example.com', model: 'fixture-text', apiKey: keys.text },
    image: { baseUrl: 'https://image.example.com/v1/images/generations', model: 'fixture-image', apiKey: keys.image },
  });
  const path = join(storage.DATA_DIRECTORY, 'default-providers.json');
  const serialized = readFileSync(path, 'utf8');
  for (const value of Object.values(keys)) assert.equal(serialized.includes(value), false);
  const stored = JSON.parse(serialized);
  assert.ok(stored.text.encryptedApiKey && stored.image.encryptedApiKey);
  assert.equal(stored.text.apiKey, undefined);
  assert.equal(stored.image.apiKey, undefined);
  const defaults = await storage.readLocalDefaults(secret);
  assert.deepEqual(defaults, {
    text: { baseUrl: 'https://text.example.com/v1', model: 'fixture-text', apiKey: keys.text },
    image: { baseUrl: 'https://image.example.com/v1', model: 'fixture-image', apiKey: keys.image },
  });
  await assert.rejects(storage.bootstrapLocalDefaults({ apiKey: 'test-only-unwanted-replacement' }), /未覆盖/);
  assert.equal(readFileSync(path, 'utf8'), serialized);
  await assert.rejects(storage.bootstrapLocalDefaults({ action: 'replace', text: { baseUrl: 'new-text.example.com' } }), /必须显式/);
  assert.equal(readFileSync(path, 'utf8'), serialized);
  await storage.bootstrapLocalDefaults({ action: 'replace', text: { model: 'fixture-text-v2', apiKey: 'test-only-replaced-text-key' } });
  const updated = await storage.readLocalDefaults(secret);
  assert.equal(updated.text.model, 'fixture-text-v2');
  assert.equal(updated.text.apiKey, 'test-only-replaced-text-key');
  assert.deepEqual(updated.image, defaults.image);
  assert.equal(storage.localVaultSecret(), secret);
  assert.equal(readFileSync(path, 'utf8').includes('test-only-replaced-text-key'), false);
});

test('real local provider storage preserves independent text and image overrides through reopen and reset', async () => {
  const path = join(temporaryRoot, 'providers', 'palace.sqlite');
  const secret = storage.localVaultSecret();
  const owner = 'fixture-owner';
  const first = providerSettingsRepository(storage.localDatabase(path));
  for (const kind of ['text', 'image'] as const) await first.upsert({
    userId: owner, kind, baseUrl: `https://${kind}.example.com/v1`, model: `fixture-${kind}`,
    encryptedApiKey: await encryptApiKey(`test-only-${kind}-override`, secret, owner, kind), updatedAt: '2026-10-12T00:00:00.000Z',
  });
  const reopened = providerSettingsRepository(storage.localDatabase(path));
  const image = await reopened.get(owner, 'image');
  assert.ok(image);
  assert.equal(await decryptApiKey(image.encryptedApiKey, secret, owner, 'image'), 'test-only-image-override');
  await reopened.remove(owner, 'text');
  assert.equal(await first.get(owner, 'text'), null);
  assert.deepEqual(await first.get(owner, 'image'), image);
  assert.equal((await first.list(owner)).length, 1);
});

test('bucket list pagination and idempotent delete are scoped and validate all paths before removing any file', async () => {
  const bucket = storage.localBucket(join(temporaryRoot, 'deletion-bucket'));
  for (const key of ['portraits/owner/a', 'portraits/owner/b', 'portraits/other/c', 'artifacts/owner/result']) await bucket.put(key, new Uint8Array([1]));
  const first = await bucket.list({ prefix: 'portraits/owner/', limit: 1 });
  assert.deepEqual(first.objects.map(item => item.key), ['portraits/owner/a']);
  assert.equal(first.truncated, true);
  await bucket.delete('portraits/owner/a');
  const second = await bucket.list({ prefix: 'portraits/owner/', ...(first.truncated ? { cursor: first.cursor } : {}) });
  assert.deepEqual(second.objects.map(item => item.key), ['portraits/owner/b']);
  assert.equal(second.truncated, false);
  await assert.rejects(bucket.delete(['portraits/owner/b', '../escape']), /路径/);
  assert.ok(await bucket.get('portraits/owner/b'));
  await assert.rejects(bucket.list({ prefix: '../' }), /前缀/);
  await bucket.delete(['portraits/owner/a', 'portraits/owner/b']);
  assert.equal(await bucket.get('portraits/owner/b'), null);
  assert.ok(await bucket.get('portraits/other/c'));
  assert.ok(await bucket.get('artifacts/owner/result'));
});

test('committed clear-all purges local defaults, cached keys, private images and task files without touching another owner', async () => {
  const env = await storage.createRuntimeBindings();
  const owner = storage.LOCAL_OWNER_ID;
  assert.ok(env.LLM_API_KEY, 'the earlier bootstrap fixture supplies isolated defaults');
  const providers = providerSettingsRepository(env.DB!);
  for (const userId of [owner, 'unrelated-owner']) for (const kind of ['text', 'image'] as const) await providers.upsert({
    userId, kind, baseUrl: `https://${kind}.example.com/v1`, model: 'fixture-model', encryptedApiKey: await encryptApiKey('test-only-clear-key', env.PROVIDER_SETTINGS_SECRET!, userId, kind), updatedAt: nowForClear,
  });
  await env.BUCKET!.put(`portraits/${owner}/private-picture`, new Uint8Array([1]));
  await env.BUCKET!.put(`artifacts/${owner}/private-result`, new Uint8Array([2]));
  await env.BUCKET!.put('portraits/unrelated-owner/kept', new Uint8Array([3]));
  const repository = stateRepository(env.DB!);
  const domain = await repository.mutateState<AppState>(owner, 'clear-domain', createInitialState, async state => clearAllData(state, '清除所有数据', nowForClear));
  assert.equal(domain.state.agents.length, 0);
  assert.ok(await env.BUCKET!.get(`portraits/${owner}/private-picture`), 'domain deletion must commit before storage cleanup starts');
  assert.ok(env.LLM_API_KEY);
  const cleanup = await repository.mutateState<AppState>(owner, 'clear-storage', createInitialState, async state => {
    const result = await runPendingCleanup(owner, state, env);
    assert.equal(result.pending, 0);
    assert.equal(result.completed, 1);
  });
  assert.deepEqual(cleanup.state.pendingCleanup, []);
  assert.equal(env.LLM_API_KEY, '');
  assert.equal(env.IMAGE_API_KEY, '');
  assert.equal(existsSync(join(storage.DATA_DIRECTORY, 'default-providers.json')), false);
  assert.deepEqual(await providers.list(owner), []);
  assert.equal((await providers.list('unrelated-owner')).length, 2);
  assert.equal(await env.BUCKET!.get(`portraits/${owner}/private-picture`), null);
  assert.equal(await env.BUCKET!.get(`artifacts/${owner}/private-result`), null);
  assert.ok(await env.BUCKET!.get('portraits/unrelated-owner/kept'));
  const defaults = await storage.readLocalDefaults(storage.localVaultSecret());
  assert.equal(defaults.text.apiKey, '');
  assert.equal(defaults.image.apiKey, '');
  const reopened = stateRepository(storage.localDatabase(join(storage.DATA_DIRECTORY, 'palace.sqlite')));
  assert.equal((await reopened.readState<AppState>(owner, createInitialState)).agents.length, 0);
  await env.CLEAR_LOCAL_DEFAULTS();
});

const nowForClear = '2026-10-12T13:00:00.000Z';
