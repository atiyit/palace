import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  decryptApiKey, encryptApiKey, maskProviderConfig, normalizeBaseUrl,
  prepareProviderUpdate, providerDefaults, validateApiKey, validateModel,
  imageProviderOptions, defaultReferenceModel, providerConnectionOptions,
  type EffectiveProviderConfig,
} from '../lib/server/provider-config-core.ts';
import { providerSettingsRepository } from '../lib/server/provider-settings-repository.ts';

// These are synthetic test fixtures, never read from local or hosted secrets.
const secret = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');
const current: EffectiveProviderConfig = {
  baseUrl: 'https://text.example.com/v1', model: 'text-fixture',
  apiKey: 'unit-test-old-text-api-key', source: 'default',
};

test('provider base URLs normalize bare domains, standard ports, endpoint suffixes and trailing slashes', () => {
  assert.equal(normalizeBaseUrl('  api.example.com  '), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://API.EXAMPLE.com:443/v1/'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/images/generations/'), 'https://api.example.com/v1');
  assert.equal(normalizeBaseUrl('https://api.example.com/custom/openai/'), 'https://api.example.com/custom/openai');
});

test('provider URLs reject local addresses and unsafe URL components before any request can use a key', () => {
  const unsafe = [
    'http://api.example.com/v1', 'file:///etc/passwd',
    'https://localhost/v1', 'https://sub.localhost/v1', 'https://service.local/v1',
    'https://127.0.0.1/v1', 'https://127.1/v1', 'https://2130706433/v1',
    'https://0x7f000001/v1', 'https://0.0.0.0/v1',
    'https://10.0.0.8/v1', 'https://172.16.5.4/v1', 'https://192.168.0.1/v1',
    'https://169.254.169.254/v1', 'https://[::1]/v1', 'https://[fc00::1]/v1',
    'https://[fe80::1]/v1', 'https://[::ffff:127.0.0.1]/v1',
    'https://name:password@api.example.com/v1',
    'https://api.example.com/v1?api_key=fixture', 'https://api.example.com/v1#fragment',
  ];
  for (const url of unsafe) assert.throws(() => normalizeBaseUrl(url), `must reject ${url}`);
});

test('model and key validation preserve custom Unicode model names but reject header injection', () => {
  const model = '[自定义路由]claude-opus-4-6';
  assert.equal(validateModel(`  ${model}  `), model);
  assert.throws(() => validateModel('   '));
  assert.equal(validateApiKey(''), '');
  assert.equal(validateApiKey('  unit-test-new-api-key  '), 'unit-test-new-api-key');
  assert.throws(() => validateApiKey('unit-test-key\r\nAuthorization: injected'));
});

test('blank key preserves the current credential for a same-origin model or path update without mutating input', () => {
  const before = structuredClone(current);
  const updated = prepareProviderUpdate(current, {
    baseUrl: 'https://TEXT.example.com:443/compatible/v1/', model: 'next-text-fixture', apiKey: '  ',
  });
  assert.equal(updated.apiKey, current.apiKey);
  assert.equal(updated.model, 'next-text-fixture');
  assert.equal(updated.baseUrl, 'https://text.example.com/compatible/v1');
  assert.deepEqual(current, before);
  assert.equal(prepareProviderUpdate(current, { model: 'another-fixture' }).apiKey, current.apiKey);
});

test('switching origin requires an explicit new key and cannot forward a default credential', () => {
  for (const source of ['default', 'custom'] as const) {
    const config = { ...current, source };
    for (const baseUrl of ['https://other.example.com/v1', 'https://text.example.com:8443/v1']) {
      assert.throws(() => prepareProviderUpdate(config, { baseUrl }));
      assert.throws(() => prepareProviderUpdate(config, { baseUrl, apiKey: '   ' }));
    }
    const updated = prepareProviderUpdate(config, {
      baseUrl: 'https://other.example.com/v1', apiKey: 'unit-test-key-for-new-origin',
    });
    assert.equal(updated.apiKey, 'unit-test-key-for-new-origin');
    assert.notEqual(updated.apiKey, current.apiKey);
  }
});

test('text and image server defaults remain independent of user text overrides', () => {
  const defaults = providerDefaults({
    LLM_BASE_URL: 'https://text.example.com/v1', LLM_MODEL: 'default-text', LLM_API_KEY: 'test-default-text-key',
    IMAGE_BASE_URL: 'https://image.example.com/v1', IMAGE_MODEL: 'default-image', IMAGE_API_KEY: 'test-default-image-key',
  });
  const imageBefore = structuredClone(defaults.image);
  const updatedText = prepareProviderUpdate(defaults.text, { baseUrl: 'https://custom.example.com/v1', apiKey: 'test-custom-text-key' });
  assert.equal(updatedText.apiKey, 'test-custom-text-key');
  assert.deepEqual(defaults.image, imageBefore);
  assert.equal(defaults.image.apiKey, 'test-default-image-key');
  const sharedDefaults = providerDefaults({ LLM_BASE_URL: 'https://shared.example.com/v1', LLM_API_KEY: 'test-server-fallback-key', IMAGE_MODEL: 'default-image' });
  prepareProviderUpdate(sharedDefaults.text, { apiKey: 'test-personal-text-key' });
  assert.equal(sharedDefaults.image.apiKey, 'test-server-fallback-key');
  assert.equal(sharedDefaults.image.baseUrl, 'https://shared.example.com/v1');
});

test('image defaults migrate only missing reference models and preserve explicit independent model and prompt settings', () => {
  const defaults = providerDefaults({});
  assert.equal(defaults.image.model, 'nai-diffusion-5-full');
  assert.equal(defaults.image.referenceModel, 'nai-diffusion-4-5-full');
  assert.equal(defaults.image.promptStyle, 'default'); assert.equal(defaults.image.customPrompt, '');
  assert.equal(defaultReferenceModel('nai-diffusion-5-curated'), 'nai-diffusion-4-5-curated');
  assert.equal(defaultReferenceModel('gpt-image-1'), 'gpt-image-1');
  const custom = prepareProviderUpdate(defaults.image, { model: 'gpt-image-1', referenceModel: 'nai-diffusion-5-full', promptStyle: 'custom', customPrompt: '保持{{appearance}}，场景为{{request}}' });
  assert.equal(custom.referenceModel, 'nai-diffusion-5-full', 'explicit models are never remapped');
  const next = prepareProviderUpdate({ ...custom, source: 'custom' }, { model: 'another-text-image-model', apiKey: '' });
  assert.equal(next.referenceModel, custom.referenceModel); assert.equal(next.customPrompt, custom.customPrompt); assert.equal(next.promptStyle, 'custom');
  const publicImage = maskProviderConfig({ ...next, source: 'custom' });
  assert.equal(publicImage.referenceModel, custom.referenceModel); assert.equal(publicImage.promptStyle, 'custom'); assert.equal(publicImage.customPrompt, custom.customPrompt);
  assert.equal(defaults.text.referenceModel, undefined);
});

test('image-only prompt settings reject invalid styles, control characters and oversized custom prompts', () => {
  assert.throws(() => imageProviderOptions('model', { referenceModel: ' ' }));
  assert.throws(() => imageProviderOptions('model', { promptStyle: 'unexpected' as 'default' }));
  assert.throws(() => imageProviderOptions('model', { customPrompt: 'x'.repeat(6001) }));
  assert.throws(() => imageProviderOptions('model', { customPrompt: 'bad\x00prompt' }));
  assert.equal(imageProviderOptions('model', { customPrompt: '保留换行\n第二行' }).customPrompt, '保留换行\n第二行');
  assert.equal(normalizeBaseUrl('https://api.example.com/v1/images/edits/'), 'https://api.example.com/v1');
});

test('public provider configuration includes only display fields and never returns the credential', () => {
  const publicConfig = maskProviderConfig(current);
  assert.deepEqual(Object.keys(publicConfig).sort(), ['baseUrl', 'keyConfigured', 'keyHint', 'model', 'source', 'protocol', 'local'].sort());
  assert.equal(publicConfig.keyConfigured, true);
  assert.equal(publicConfig.source, 'default');
  assert.equal(JSON.stringify(publicConfig).includes(current.apiKey), false);
  assert.equal('apiKey' in publicConfig, false);
  assert.equal('encryptedApiKey' in publicConfig, false);
  const unconfigured = maskProviderConfig({ ...current, apiKey: '' });
  assert.equal(unconfigured.keyConfigured, false);
  assert.equal(maskProviderConfig({ ...current, apiKey: 'tiny' }).keyHint.includes('tiny'), false);
});

test('AES-GCM credentials round-trip only for the original user and provider channel', async () => {
  const encrypted = await encryptApiKey(current.apiKey, secret, 'alice', 'text');
  assert.equal(encrypted.includes(current.apiKey), false);
  assert.equal(await decryptApiKey(encrypted, secret, 'alice', 'text'), current.apiKey);
  await assert.rejects(decryptApiKey(encrypted, secret, 'bob', 'text'));
  await assert.rejects(decryptApiKey(encrypted, secret, 'alice', 'image'));
  await assert.rejects(decryptApiKey(encrypted, Buffer.alloc(32, 9).toString('base64'), 'alice', 'text'));
});

test('credential persistence requires a valid deployment encryption secret', async () => {
  for (const invalidSecret of ['', 'not-base64', Buffer.alloc(16).toString('base64')]) {
    await assert.rejects(encryptApiKey(current.apiKey, invalidSecret, 'alice', 'text'));
  }
});

test('credential encryption uses fresh nonces and rejects changed ciphertext', async () => {
  const first = await encryptApiKey(current.apiKey, secret, 'alice', 'text');
  const second = await encryptApiKey(current.apiKey, secret, 'alice', 'text');
  assert.notEqual(first, second);
  const offset = Math.floor(first.length / 2);
  const corrupted = first.slice(0, offset) + (first[offset] === 'A' ? 'B' : 'A') + first.slice(offset + 1);
  await assert.rejects(decryptApiKey(corrupted, secret, 'alice', 'text'));
  assert.equal(await decryptApiKey(second, secret, 'alice', 'text'), current.apiKey);
});

function sqliteSettingsRepository() {
  const db = new DatabaseSync(':memory:');
  const migrationFolder = new URL('../drizzle/', import.meta.url);
  for (const file of readdirSync(migrationFolder).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrationFolder), 'utf8'));
  }
  const adapter = { prepare(sql: string) {
    const statement = db.prepare(sql);
    let parameters: SQLInputValue[] = [];
    const bound = {
      bind(...values: SQLInputValue[]) { parameters = values; return bound; },
      async run() { const result = statement.run(...parameters); return { meta: { changes: Number(result.changes) } }; },
      async first() { return statement.get(...parameters) || null; },
      async all() { return { results: statement.all(...parameters), success: true, meta: {} }; },
    };
    return bound;
  } } as unknown as D1Database;
  return { db, repo: providerSettingsRepository(adapter) };
}

test('saving and restoring one provider channel leaves the other channel and other users untouched', async () => {
  const { db, repo } = sqliteSettingsRepository();
  try {
    const image = { userId: 'alice', kind: 'image' as const, baseUrl: 'https://image.example.com/v1', model: 'image-one', encryptedApiKey: await encryptApiKey('test-image-key', secret, 'alice', 'image'), updatedAt: '2026-10-12T04:00:00.000Z' };
    const text = { userId: 'alice', kind: 'text' as const, baseUrl: current.baseUrl, model: 'text-one', encryptedApiKey: await encryptApiKey('test-text-key', secret, 'alice', 'text'), updatedAt: image.updatedAt };
    const otherUser = { ...text, userId: 'bob', model: 'bob-text', encryptedApiKey: await encryptApiKey('test-bob-key', secret, 'bob', 'text') };
    await repo.upsert(image);
    await repo.upsert(text);
    await repo.upsert(otherUser);
    await repo.upsert({ ...text, model: 'text-two' });
    assert.equal((await repo.get('alice', 'text'))?.model, 'text-two');
    assert.deepEqual(await repo.get('alice', 'image'), image);
    assert.deepEqual(await repo.get('bob', 'text'), otherUser);
    assert.equal((await repo.list('alice')).length, 2);
    await repo.remove('alice', 'text');
    assert.ok(!(await repo.get('alice', 'text')));
    assert.deepEqual(await repo.get('alice', 'image'), image);
    assert.deepEqual(await repo.get('bob', 'text'), otherUser);
    assert.deepEqual((await repo.list('alice')).map(row => row.kind), ['image']);
    await repo.remove('alice', 'text');
    assert.deepEqual(await repo.get('alice', 'image'), image);
  } finally { db.close(); }
});

test('new image settings persist separately while migrated legacy records remain readable', async () => {
  const { db, repo } = sqliteSettingsRepository();
  try {
    const row = { userId: 'alice', kind: 'image' as const, baseUrl: 'https://image.example.com/v1', model: 'nai-diffusion-5-full', encryptedApiKey: 'encrypted-test-placeholder', updatedAt: '2026-10-12T00:00:00Z' };
    await repo.upsert(row); const legacy = await repo.get('alice', 'image');
    assert.equal(imageProviderOptions(legacy!.model, legacy!.imageOptions).referenceModel, 'nai-diffusion-4-5-full'); assert.deepEqual(legacy, row);
    const updated = { ...row, imageOptions: { referenceModel: 'gpt-image-1', promptStyle: 'gpt-image' as const, customPrompt: 'Do not erase a previously saved custom template.' } };
    await repo.upsert(updated); assert.deepEqual(await repo.get('alice', 'image'), updated);
    assert.equal((await repo.list('alice'))[0].imageOptions!.referenceModel, 'gpt-image-1');
  } finally { db.close(); }
});

test('protocol-aware URLs normalize native messages, responses, Ollama and explicit local ports', () => {
  assert.equal(normalizeBaseUrl('api.anthropic.com/v1/messages', { protocol: 'anthropic' }), 'https://api.anthropic.com/v1');
  assert.equal(normalizeBaseUrl('https://gateway.example.com/proxy/v1/responses/', { protocol: 'openai-responses' }), 'https://gateway.example.com/proxy/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1234/v1/chat/completions', { local: true }), 'http://127.0.0.1:1234/v1');
  assert.equal(normalizeBaseUrl('localhost:11434/api/chat', { local: true, protocol: 'ollama' }), 'http://localhost:11434');
  assert.equal(normalizeBaseUrl('http://[::1]:11434/api', { local: true, protocol: 'ollama' }), 'http://[::1]:11434');
  assert.equal(normalizeBaseUrl('https://gateway.example.com/proxy/api/chat', { protocol: 'ollama' }), 'https://gateway.example.com/proxy');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:5678/custom', { local: true }), 'http://127.0.0.1:5678/custom');
  for (const url of ['http://127.0.0.1:80/v1', 'https://[::1]:443/v1']) {
    const canonical = normalizeBaseUrl(url, { local: true }); assert.equal(canonical, url); assert.equal(normalizeBaseUrl(canonical, { local: true }), canonical);
  }
});

test('local opt-in never allows public hosts, LAN machines, local aliases or implicit ports', () => {
  for (const url of ['http://localhost', 'http://127.0.0.1', 'http://[::1]', 'http://192.168.1.5:1234', 'http://10.0.0.2:11434', 'http://model.local:1234', 'http://evil.example.com:1234', 'http://localhost.evil.example.com:1234', 'http://127.0.0.1:0', 'http://localhost:1234?token=private', 'file://localhost:1234/model']) {
    assert.throws(() => normalizeBaseUrl(url, { local: true }), url);
  }
  for (const url of ['http://127.0.0.1:1234', 'https://127.0.0.1:1234', 'https://localhost:11434', 'http://api.example.com:8080']) assert.throws(() => normalizeBaseUrl(url));
  assert.throws(() => providerConnectionOptions({ protocol: 'unknown' as 'openai-chat' }));
  assert.throws(() => providerConnectionOptions({ local: 'true' as unknown as boolean }));
  assert.throws(() => providerConnectionOptions({ visionEnabled: 'true' as unknown as boolean }));
});

test('switching to local clears cloud credentials, while returning to remote requires an explicit new key', () => {
  const local = prepareProviderUpdate(current, { baseUrl: 'http://127.0.0.1:1234/v1', local: true, apiKey: '' });
  assert.equal(local.apiKey, ''); assert.equal(local.local, true); assert.equal(local.protocol, 'openai-chat');
  const noKeyField = prepareProviderUpdate(current, { baseUrl: 'http://localhost:11434/api/chat', protocol: 'ollama', local: true });
  assert.equal(noKeyField.apiKey, ''); assert.equal(noKeyField.baseUrl, 'http://localhost:11434');
  assert.throws(() => prepareProviderUpdate({ ...local, source: 'custom' }, { baseUrl: 'https://text.example.com/v1', local: false, apiKey: '' }));
  const remote = prepareProviderUpdate({ ...local, source: 'custom' }, { baseUrl: 'https://text.example.com/v1', local: false, apiKey: 'explicit-new-cloud-key' });
  assert.equal(remote.apiKey, 'explicit-new-cloud-key');
  const securedLocal = { ...local, apiKey: 'local-server-only-key', source: 'custom' as const };
  assert.equal(prepareProviderUpdate(securedLocal, { model: 'another' }).apiKey, securedLocal.apiKey);
  assert.equal(prepareProviderUpdate(securedLocal, { apiKey: '' }).apiKey, securedLocal.apiKey, 'blank keys retain same-service local authentication just as the settings UI promises');
  assert.equal(prepareProviderUpdate(securedLocal, { baseUrl: 'http://localhost:4444/v1' }).apiKey, '', 'local credentials are not forwarded to another service automatically');
});

test('connection protocol and explicit vision capability persist without altering image options or other providers', async () => {
  const { db, repo } = sqliteSettingsRepository();
  try {
    const row = { userId: 'alice', kind: 'text' as const, baseUrl: 'http://localhost:11434', model: 'local-vision-model', encryptedApiKey: 'empty-key-encrypted', updatedAt: '2026-10-12T00:00:00Z', connectionOptions: { protocol: 'ollama' as const, local: true, visionEnabled: true } };
    await repo.upsert(row); assert.deepEqual(await repo.get('alice', 'text'), row);
    assert.equal(providerDefaults({}).text.visionEnabled, false); assert.equal(providerDefaults({}).image.visionEnabled, undefined);
    const publicConfig = maskProviderConfig({ ...current, ...row.connectionOptions });
    assert.equal(publicConfig.protocol, 'ollama'); assert.equal(publicConfig.local, true); assert.equal(publicConfig.visionEnabled, true);
  } finally { db.close(); }
});
