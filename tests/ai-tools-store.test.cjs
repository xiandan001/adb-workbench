const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAiToolsStore } = require('../electron/lib/ai-tools-store.cjs');
const { getAiToolsCatalog } = require('../electron/lib/ai-tools-catalog.cjs');

function context(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const encrypt = plain => {
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  };
  const decrypt = bytes => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  };
  return { directory, canEncrypt: () => true, encrypt, decrypt };
}
const input = () => ({ name: 'Personal fixture', protocol: 'openai-responses', baseUrl: 'https://api.example.test/v1', model: 'fixture-model', targetApps: ['codex'], apiKey: 'fixture-secret-not-real' });

test('portable provider hooks validate exact schema, merge IDs and guard commit/rollback leases', t => {
  const options = context(t); const store = createAiToolsStore(options); const source = createAiToolsStore(context(t));
  const row = source.saveProvider(input()); const payload = source.exportPortable();
  assert.equal(payload.providers[0].apiKey, input().apiKey); assert.equal(payload.providers[0].hasCredential, undefined);
  assert.throws(() => store.preparePortableImport({ ...payload, localPath: 'not allowed' }));
  assert.throws(() => store.preparePortableImport({ version: 1, providers: [payload.providers[0], payload.providers[0]] }));
  const tx = store.preparePortableImport(payload); assert.deepEqual(tx.counts, { added: 1, skipped: 0 });
  assert.equal(store.snapshot().providers.length, 0); tx.commit(); assert.equal(store.getProvider(row.id).apiKey, input().apiKey);
  tx.rollback(); assert.equal(store.snapshot().providers.length, 0); assert.equal(fs.existsSync(path.join(options.directory, 'ai-tools-store.v1.json')), false);
  const second = store.preparePortableImport(payload); second.commit(); store.saveProvider({ ...input(), id: row.id, name: 'Later edit' });
  assert.throws(() => second.rollback(), error => error.code === 'AI_TOOLS_PORTABLE_CHANGED'); assert.equal(store.getProvider(row.id).name, 'Later edit');
  const skipped = store.preparePortableImport(payload); assert.deepEqual(skipped.counts, { added: 0, skipped: 1 });
  fs.appendFileSync(path.join(options.directory, 'ai-tools-store.v1.json'), '\n');
  assert.throws(() => skipped.commit(), error => error.code === 'AI_TOOLS_CONFIG_CHANGED');
});

test('portable import cannot persist with unavailable system encryption', t => {
  let available = true; const options = context(t); const store = createAiToolsStore({ ...options, canEncrypt: () => available });
  const source = createAiToolsStore(context(t)); source.saveProvider(input());
  const tx = store.preparePortableImport(source.exportPortable()); available = false;
  assert.throws(() => tx.commit(), error => error.code === 'AI_TOOLS_ENCRYPTION_UNAVAILABLE');
  assert.deepEqual(fs.readdirSync(options.directory), []);
});

test('whole provider state is encrypted and public snapshots never contain credentials', (t) => {
  const options = context(t); const store = createAiToolsStore(options);
  const publicRow = store.saveProvider({ ...input(), quotaKey: 'quota-fixture-secret' });
  assert.equal(publicRow.hasCredential, true); assert.equal(publicRow.hasQuotaCredential, true);
  assert.equal(publicRow.apiKey, undefined); assert.equal(publicRow.quotaKey, undefined);
  const raw = fs.readFileSync(path.join(options.directory, 'ai-tools-store.v1.json'), 'utf8');
  for (const hidden of ['Personal fixture', 'fixture-secret-not-real', 'quota-fixture-secret', 'api.example.test']) assert.equal(raw.includes(hidden), false);
  const reloaded = createAiToolsStore(options);
  assert.equal(reloaded.getProvider(publicRow.id).apiKey, input().apiKey);
  assert.equal(reloaded.snapshot().providers.length, 1);
  const copy = reloaded.getProvider(publicRow.id); copy.name = 'changed without save';
  assert.equal(reloaded.getProvider(publicRow.id).name, input().name);
});

test('credential omission preserves, null removes, and endpoint origin changes do not forward an old secret', (t) => {
  const store = createAiToolsStore(context(t)); const row = store.saveProvider(input());
  const edit = input(); delete edit.apiKey;
  store.saveProvider({ ...edit, id: row.id, name: 'Edited' });
  assert.equal(store.getProvider(row.id).apiKey, input().apiKey);
  assert.throws(() => store.saveProvider({ ...edit, id: row.id, baseUrl: 'https://other.test/v1' }), /凭据|地址/);
  assert.throws(() => store.saveProvider({ ...edit, id: row.id, apiKey: '' }), /凭据/);
  const removed = store.saveProvider({ ...edit, id: row.id, apiKey: null });
  assert.equal(removed.hasCredential, false);
  store.removeProvider(row.id);
  assert.deepEqual(store.snapshot().providers, []);
});

test('encryption unavailable is explicit memory-only and never writes plaintext', (t) => {
  const options = context(t); const store = createAiToolsStore({ ...options, canEncrypt: () => false });
  store.saveProvider(input());
  assert.equal(store.snapshot().persistent, false); assert.match(store.snapshot().warning, /内存|加密/);
  assert.deepEqual(fs.readdirSync(options.directory), []);
});

test('corrupt or externally changed encrypted storage is preserved on failure', (t) => {
  const options = context(t); const store = createAiToolsStore(options); const row = store.saveProvider(input());
  const file = path.join(options.directory, 'ai-tools-store.v1.json');
  const original = fs.readFileSync(file); const corrupt = Buffer.from('not encrypted store');
  fs.writeFileSync(file, corrupt);
  assert.throws(() => store.removeProvider(row.id), /变化|保存/);
  assert.deepEqual(fs.readFileSync(file), corrupt);
  assert.throws(() => createAiToolsStore(options).snapshot(), /读取/);
  fs.writeFileSync(file, original);
  assert.equal(createAiToolsStore(options).snapshot().providers.length, 1);
});

test('malformed input and secret-bearing quota fields are rejected without persisting', (t) => {
  const options = context(t); const store = createAiToolsStore(options);
  for (const override of [
    { baseUrl: 'https://user:pass@example.test' }, { baseUrl: 'https://example.test?api_key=secret' },
    { protocol: 'unsupported' }, { targetApps: ['unknown'] }, { apiKey: 'bad\nsecret' },
    { quota: { adapter: 'deepseek', headers: { Authorization: 'secret' } } },
  ]) assert.throws(() => store.saveProvider({ ...input(), ...override }));
  assert.deepEqual(store.snapshot().providers, []);
});

test('catalog advertises only implemented configuration adapters', () => {
  const catalog = getAiToolsCatalog();
  assert.equal(catalog.length, 12);
  assert.deepEqual(catalog.filter(tool => tool.configSupported).map(tool => tool.id), ['claude', 'codex', 'gemini', 'opencode', 'claude-desktop', 'grokbuild', 'openclaw', 'hermes', 'pi', 'mcode', 'kimi']);
  assert.ok(catalog.filter(tool => !tool.configSupported).every(tool => tool.reason));
});

test('contextWindow is validated, preserved on omission and removed only by explicit null', (t) => {
  const store = createAiToolsStore(context(t)); const row = store.saveProvider({ ...input(), contextWindow: 128000 });
  assert.equal(row.contextWindow, 128000);
  assert.equal(store.saveProvider({ ...input(), id: row.id }).contextWindow, 128000);
  assert.equal(store.saveProvider({ ...input(), id: row.id, contextWindow: null }).contextWindow, undefined);
  for (const contextWindow of [0, -1, 1.5, '128000', 2147483648]) assert.throws(() => store.saveProvider({ ...input(), contextWindow }), /上下文/);
});

test('quota metadata shares the network schema and quota-key identity cannot silently change', (t) => {
  const store = createAiToolsStore(context(t));
  const row = store.saveProvider({ ...input(), quota: { adapter: 'deepseek', credentialOrigin: 'https://api.deepseek.com' }, quotaKey: 'independent-fixture-key' });
  assert.deepEqual(row.quota, { adapter: 'deepseek', credentialOrigin: 'https://api.deepseek.com' });
  const edit = input(); delete edit.apiKey;
  const kept = store.saveProvider({ ...edit, id: row.id });
  assert.deepEqual(kept.quota, row.quota);
  assert.throws(() => store.saveProvider({ ...edit, id: row.id, quota: { adapter: 'openrouter', credentialOrigin: 'https://openrouter.ai' } }), /额度.*凭据/);
  store.saveProvider({ ...edit, id: row.id, quota: null, quotaKey: null });
  assert.equal(store.getProvider(row.id).quotaKey, undefined);
  assert.throws(() => store.saveProvider({ ...input(), quota: { adapter: 'custom', request: { path: '/credits', method: 'POST', body: { token: 'no-secret-in-metadata' } }, extract: { metrics: [{ label: 'Balance', unit: 'USD', remaining: 'data.balance' }] } } }), /凭据/);
});
