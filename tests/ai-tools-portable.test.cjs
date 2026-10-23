const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { createAiToolsStore } = require('../electron/lib/ai-tools-store.cjs');
const { createAiToolsResources } = require('../electron/lib/ai-tools-resources.cjs');
const { createAiToolsPortable } = require('../electron/lib/ai-tools-portable.cjs');

const PASSWORD = 'fixture-password-123';
const code = expected => error => error.code === expected;
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-portable-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  const encryption = { canEncrypt: () => true,
    encrypt(value) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(value, 'utf8'), c.final(), c.getAuthTag()]); },
    decrypt(value) { const d = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); d.setAuthTag(value.subarray(-16)); return Buffer.concat([d.update(value.subarray(12, -16)), d.final()]).toString('utf8'); },
  };
  function stores(prefix) {
    const base = path.join(root, prefix);
    const providers = createAiToolsStore({ directory: path.join(base, 'providers'), ...encryption });
    const resources = createAiToolsResources({ directory: path.join(base, 'resources'), home: path.join(base, 'home'), backupDirectory: path.join(base, 'resource-backups'), ...encryption });
    const portable = createAiToolsPortable({ directory: path.join(base, 'portable'), providers, resources, ...extra });
    return { base, providers, resources, portable };
  }
  return { root, stores, encryption };
}
function seed(stores) {
  const provider = stores.providers.saveProvider({ name: 'Fixture', protocol: 'openai-chat', baseUrl: 'https://fixture.invalid/v1', model: 'm', targetApps: ['claude'], apiKey: 'private-provider-key', quotaKey: 'private-quota-key', quota: { adapter: 'deepseek' } });
  const mcp = stores.resources.saveMcp({ name: 'MCP', type: 'stdio', command: 'node', args: ['fixture.js'], env: { TOKEN: 'private-mcp-value' } });
  const prompt = stores.resources.savePrompt({ name: 'Prompt', content: 'private-prompt-text' });
  return { provider, mcp, prompt };
}

test('portable export is password encrypted, contains only definitions, and performs no automatic I/O', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); seed(source);
  assert.equal(fs.existsSync(path.join(source.base, 'portable')), false);
  const file = path.join(root, 'portable.awbai'); const result = await source.portable.exportBundle({ path: file, password: PASSWORD });
  assert.deepEqual(result.counts, { providers: 1, mcpServers: 1, prompts: 1 });
  const bytes = fs.readFileSync(file, 'utf8'); for (const secret of ['private-provider-key', 'private-quota-key', 'private-mcp-value', 'private-prompt-text', source.base]) assert.equal(bytes.includes(secret), false);
  const envelope = JSON.parse(bytes); assert.equal(envelope.version, 1); assert.equal(envelope.cipher, 'aes-256-gcm'); assert.equal(envelope.kdf.name, 'scrypt');
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('preview reveals counts only, import reencrypts definitions and never copies local applications', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); const rows = seed(source); const target = stores('target');
  source.resources.apply({ token: source.resources.previewPrompt({ toolId: 'claude', promptId: rows.prompt.id, enabled: true }).token });
  const file = path.join(root, 'portable.awbai'); await source.portable.exportBundle({ path: file, password: PASSWORD });
  const preview = await target.portable.previewImport({ path: file, password: PASSWORD });
  assert.deepEqual(preview.counts, { providers: { added: 1, skipped: 0 }, mcpServers: { added: 1, skipped: 0 }, prompts: { added: 1, skipped: 0 } });
  assert.equal(JSON.stringify(preview).includes('private-'), false); assert.equal(target.providers.snapshot().providers.length, 0);
  const result = target.portable.applyImport({ token: preview.token }); assert.ok(result.backupId);
  assert.equal(target.providers.getProvider(rows.provider.id).apiKey, 'private-provider-key');
  assert.equal(target.resources.snapshot().mcpServers[0].hasSecrets, true); assert.deepEqual(target.resources.snapshot().prompts[0].applications, []);
  assert.equal(fs.existsSync(path.join(target.base, 'home')), false);
  assert.throws(() => target.portable.applyImport({ token: preview.token }), code('AI_TOOLS_PORTABLE_EXPIRED'));
  for (const filename of ['providers/ai-tools-store.v1.json', 'resources/ai-tools-resources.v1.json']) assert.equal(fs.readFileSync(path.join(target.base, filename), 'utf8').includes('private-'), false);
});

test('wrong password, tampered cipher/header, weak password and oversized input never mutate libraries', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); seed(source); const target = stores('target'); const file = path.join(root, 'portable.awbai');
  await source.portable.exportBundle({ path: file, password: PASSWORD });
  await assert.rejects(target.portable.previewImport({ path: file, password: 'wrong-password' }), code('AI_TOOLS_PORTABLE_DECRYPT'));
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8')); envelope.kdf.N = 1048576; fs.writeFileSync(file, JSON.stringify(envelope));
  await assert.rejects(target.portable.previewImport({ path: file, password: PASSWORD }), code('AI_TOOLS_PORTABLE_FORMAT'));
  await assert.rejects(source.portable.exportBundle({ path: file, password: 'short' }), code('AI_TOOLS_PORTABLE_PASSWORD'));
  fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(target.portable.previewImport({ path: file, password: PASSWORD }));
  assert.deepEqual(target.providers.snapshot().providers, []); assert.deepEqual(target.resources.snapshot().mcpServers, []);
});

test('same IDs are explicitly skipped, no existing secret or record is overwritten', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); const rows = seed(source); const target = stores('target');
  target.providers.saveProvider({ ...source.providers.getProvider(rows.provider.id), id: undefined });
  const initial = target.providers.preparePortableImport(source.providers.exportPortable()); initial.commit();
  target.providers.saveProvider({ ...source.providers.getProvider(rows.provider.id), name: 'Keep local', apiKey: 'keep-local-secret' });
  const file = path.join(root, 'portable.awbai'); await source.portable.exportBundle({ path: file, password: PASSWORD });
  const preview = await target.portable.previewImport({ path: file, password: PASSWORD }); assert.deepEqual(preview.counts.providers, { added: 0, skipped: 1 });
  target.portable.applyImport({ token: preview.token }); assert.equal(target.providers.getProvider(rows.provider.id).apiKey, 'keep-local-secret'); assert.equal(target.providers.snapshot().providers.length, 2);
});

test('preview leases reject store edits, source changes and expired tokens', async t => {
  let clock = 100; const { root, stores } = fixture(t, { now: () => clock }); const source = stores('source'); seed(source); const target = stores('target'); const file = path.join(root, 'portable.awbai');
  await source.portable.exportBundle({ path: file, password: PASSWORD });
  const edited = await target.portable.previewImport({ path: file, password: PASSWORD }); target.resources.savePrompt({ name: 'Local', content: 'keep' });
  assert.throws(() => target.portable.applyImport({ token: edited.token }), code('AI_TOOLS_PORTABLE_CHANGED'));
  const changed = await target.portable.previewImport({ path: file, password: PASSWORD }); fs.appendFileSync(file, '\n');
  assert.throws(() => target.portable.applyImport({ token: changed.token }), code('AI_TOOLS_CONFIG_CHANGED'));
  const expired = await target.portable.previewImport({ path: file, password: PASSWORD }); clock += 300001;
  assert.throws(() => target.portable.applyImport({ token: expired.token }), code('AI_TOOLS_PORTABLE_EXPIRED'));
  assert.equal(target.providers.snapshot().providers.length, 0);
});

test('failed second-store commit rolls back first and keeps only encrypted recovery files', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); seed(source); const target = stores('target'); const file = path.join(root, 'portable.awbai');
  await source.portable.exportBundle({ path: file, password: PASSWORD });
  const originalPrepare = target.resources.preparePortableImport;
  target.resources.preparePortableImport = payload => { const tx = originalPrepare(payload); return { ...tx, commit() { throw new Error('fixture failure'); } }; };
  const preview = await target.portable.previewImport({ path: file, password: PASSWORD });
  let failure; try { target.portable.applyImport({ token: preview.token }); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'AI_TOOLS_PORTABLE_IMPORT_FAILED'); assert.ok(failure.backupId);
  assert.equal(target.providers.snapshot().providers.length, 0); assert.equal(target.resources.snapshot().mcpServers.length, 0);
  const recovery = path.join(target.base, 'portable', failure.backupId);
  for (const entry of fs.readdirSync(recovery)) assert.equal(fs.readFileSync(path.join(recovery, entry), 'utf8').includes('private-'), false);
});

test('export never clobbers an existing file without a verified overwrite lease', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); seed(source); const file = path.join(root, 'portable.awbai'); fs.writeFileSync(file, 'keep');
  await assert.rejects(source.portable.exportBundle({ path: file, password: PASSWORD }), code('AI_TOOLS_PORTABLE_EXISTS'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  const hash = require('node:crypto').createHash('sha256').update('keep').digest('hex');
  await source.portable.exportBundle({ path: file, password: PASSWORD, expectedHash: hash }); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
});

test('tampered authenticated ciphertext is rejected and dispose during scrypt prevents late export', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); seed(source); const file = path.join(root, 'portable.awbai');
  await source.portable.exportBundle({ path: file, password: PASSWORD });
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8')); const cipher = Buffer.from(envelope.ciphertext, 'base64'); cipher[0] ^= 1; envelope.ciphertext = cipher.toString('base64'); fs.writeFileSync(file, JSON.stringify(envelope));
  await assert.rejects(source.portable.previewImport({ path: file, password: PASSWORD }), code('AI_TOOLS_PORTABLE_DECRYPT'));
  const output = path.join(root, 'late.awbai'); const writing = source.portable.exportBundle({ path: output, password: PASSWORD });
  source.portable.dispose(); await assert.rejects(writing, code('AI_TOOLS_PORTABLE_DISPOSED')); assert.equal(fs.existsSync(output), false);
});

test('rollback never erases a later provider edit and advertises retained recovery backup', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); const rows = seed(source); const target = stores('target'); const file = path.join(root, 'portable.awbai');
  await source.portable.exportBundle({ path: file, password: PASSWORD });
  const originalPrepare = target.resources.preparePortableImport;
  target.resources.preparePortableImport = payload => { const tx = originalPrepare(payload); return { ...tx, commit() { target.providers.saveProvider({ ...target.providers.getProvider(rows.provider.id), name: 'External later edit' }); throw new Error('fixture failure'); } }; };
  const preview = await target.portable.previewImport({ path: file, password: PASSWORD }); let failure;
  try { target.portable.applyImport({ token: preview.token }); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'AI_TOOLS_PORTABLE_IMPORT_FAILED'); assert.equal(target.providers.getProvider(rows.provider.id).name, 'External later edit');
  const manifest = JSON.parse(fs.readFileSync(path.join(target.base, 'portable', failure.backupId, 'manifest.json'), 'utf8')); assert.equal(manifest.status, 'recovery-required');
});

test('resource import rejects local application state, duplicate IDs and retains existing active resources', t => {
  const { stores } = fixture(t); const source = stores('source'); const rows = seed(source); const target = stores('target');
  const portable = source.resources.exportPortable(); assert.deepEqual(Object.keys(portable).sort(), ['mcpServers', 'prompts', 'version']);
  assert.throws(() => target.resources.preparePortableImport({ ...portable, applications: [] }), code('AI_TOOLS_PORTABLE_FORMAT'));
  assert.throws(() => target.resources.preparePortableImport({ ...portable, prompts: [portable.prompts[0], portable.prompts[0]] }), code('AI_TOOLS_PORTABLE_FORMAT'));
  const tx = target.resources.preparePortableImport(portable); tx.commit();
  target.resources.apply({ token: target.resources.previewPrompt({ toolId: 'codex', promptId: rows.prompt.id, enabled: true }).token });
  assert.throws(() => tx.rollback(), code('AI_TOOLS_PORTABLE_CHANGED'));
  const merged = target.resources.preparePortableImport(portable); assert.deepEqual(merged.counts.prompts, { added: 0, skipped: 1 }); merged.commit();
  assert.deepEqual(target.resources.snapshot().prompts[0].applications, ['codex']);
});

test('explicit recovery after a simulated inter-store process exit restores only matching writes and updates memory', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); seed(source); const target = stores('target'); const file = path.join(root, 'portable.awbai');
  await source.portable.exportBundle({ path: file, password: PASSWORD });
  const imported = target.portable.applyImport({ token: (await target.portable.previewImport({ path: file, password: PASSWORD })).token });
  const manifestPath = path.join(target.base, 'portable', imported.backupId, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.unlinkSync(manifest.files[1].path); manifest.status = 'prepared'; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const restarted = stores('target'); const entries = restarted.portable.listRecoveries(); assert.equal(entries.length, 1); assert.equal(entries[0].id, imported.backupId);
  const preview = restarted.portable.previewRecovery({ backupId: imported.backupId }); assert.deepEqual(preview.counts, { restore: 1, unchanged: 1 });
  assert.equal(restarted.providers.snapshot().providers.length, 1); assert.equal(JSON.stringify(preview).includes('private-'), false);
  restarted.portable.applyRecovery({ token: preview.token });
  assert.deepEqual(restarted.providers.snapshot().providers, []); assert.deepEqual(restarted.resources.snapshot().prompts, []); assert.deepEqual(restarted.portable.listRecoveries(), []);
  assert.equal(fs.existsSync(manifest.files[0].path), false);
});

test('recovery rejects altered target paths and externally changed destination files', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); seed(source); const target = stores('target'); const file = path.join(root, 'portable.awbai');
  await source.portable.exportBundle({ path: file, password: PASSWORD }); const applied = target.portable.applyImport({ token: (await target.portable.previewImport({ path: file, password: PASSWORD })).token });
  const manifestPath = path.join(target.base, 'portable', applied.backupId, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); manifest.status = 'prepared'; fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const changedPath = manifest.files[0].path; fs.appendFileSync(changedPath, '\n');
  assert.throws(() => target.portable.previewRecovery({ backupId: applied.backupId }), code('AI_TOOLS_PORTABLE_CHANGED'));
  manifest.files[0].path = path.join(root, 'forbidden'); fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => target.portable.previewRecovery({ backupId: applied.backupId }), code('AI_TOOLS_PORTABLE_FORMAT'));
  assert.equal(fs.existsSync(path.join(root, 'forbidden')), false);
});

test('sync apply cannot race async password operations and does not consume its retryable token', async t => {
  const { root, stores } = fixture(t); const source = stores('source'); seed(source); const target = stores('target'); const file = path.join(root, 'portable.awbai');
  await source.portable.exportBundle({ path: file, password: PASSWORD }); const preview = await target.portable.previewImport({ path: file, password: PASSWORD });
  const exporting = target.portable.exportBundle({ path: path.join(root, 'other.awbai'), password: PASSWORD });
  assert.throws(() => target.portable.applyImport({ token: preview.token }), code('AI_TOOLS_PORTABLE_BUSY'));
  await exporting; target.portable.applyImport({ token: preview.token }); assert.equal(target.providers.snapshot().providers.length, 1);
});
