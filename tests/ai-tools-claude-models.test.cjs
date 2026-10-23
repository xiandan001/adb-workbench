const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeClaudeModels, claudeModelAssignments } = require('../electron/lib/ai-tools-claude-models.cjs');
const { createAiToolsStore, validateProvider } = require('../electron/lib/ai-tools-store.cjs');
const { createAiToolsConfig } = require('../electron/lib/ai-tools-config.cjs');
const { projectConfig, parseJsonc } = require('../electron/lib/ai-tools-config-adapters.cjs');
const { createAiToolsResources } = require('../electron/lib/ai-tools-resources.cjs');
const { createAiToolsPortable } = require('../electron/lib/ai-tools-portable.cjs');
const { createAiToolsMigration } = require('../electron/lib/ai-tools-migration-state.cjs');
const migrationCodec = require('../electron/lib/data-migration-v2.cjs');

const input = () => ({ name: 'Claude fixture', protocol: 'anthropic', baseUrl: 'https://fixture.invalid/anthropic', model: 'fixture-default', targetApps: ['claude'], apiKey: 'claude-fixture-secret' });
const mappings = () => ({
  sonnet: { model: 'fixture-sonnet', displayName: 'Daily model', supports1m: true },
  opus: { model: 'fixture-opus[1m]', displayName: 'Reasoning model', supports1m: true },
  fable: { model: 'fixture-fable', displayName: 'Balanced model', supports1m: false },
  haiku: { model: 'fixture-haiku', displayName: 'Fast model' },
  subagent: { model: 'fixture-subagent', supports1m: false },
});
const invalid = error => error.code === 'AI_TOOLS_PROVIDER_INVALID';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-claude-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const directory = path.join(root, 'data', 'ai-tools'); fs.mkdirSync(home);
  const key = crypto.randomBytes(32);
  const options = { home, directory, canEncrypt: () => true,
    encrypt(value) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]); },
    decrypt(value) { const d = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); d.setAuthTag(value.subarray(-16)); return Buffer.concat([d.update(value.subarray(12, -16)), d.final()]).toString('utf8'); },
  };
  const store = createAiToolsStore(options); const backupDirectory = path.join(directory, 'config-backups');
  const config = createAiToolsConfig({ ...options, backupDirectory, getProvider: store.getProvider }); t.after(() => config.dispose());
  const resources = createAiToolsResources({ ...options, backupDirectory: path.join(directory, 'resource-backups') }); t.after(() => resources.dispose());
  const portable = createAiToolsPortable({ directory: path.join(directory, 'portable'), providers: store, resources }); t.after(() => portable.dispose());
  const migration = createAiToolsMigration(options); t.after(() => migration.dispose());
  return { root, home, directory, options, store, config, portable, migration };
}

test('Claude role schema trims bounded values and never adds implicit aliases or context declarations', () => {
  const source = { sonnet: { model: ' model-id ', displayName: ' Friendly name ', supports1m: false }, subagent: { model: '' } };
  assert.deepEqual(normalizeClaudeModels(source), { sonnet: { model: 'model-id', displayName: 'Friendly name', supports1m: false }, subagent: { model: '' } });
  assert.equal(source.sonnet.model, ' model-id ');
  const maximum = { sonnet: { model: 'm'.repeat(256), displayName: 'N'.repeat(120), supports1m: true } };
  assert.deepEqual(normalizeClaudeModels(maximum), maximum);
  assert.deepEqual(normalizeClaudeModels({}), {});
  assert.deepEqual(normalizeClaudeModels(Object.assign(Object.create(null), source)).subagent, { model: '' });
});

test('Claude role schema rejects unknown fields, malformed rows, control characters and reserved IDs', t => {
  const f = fixture(t);
  const badValues = [
    null, [], 'sonnet', { unknown: { model: 'm' } }, { sonnet: null }, { sonnet: [] }, { sonnet: {} },
    { sonnet: { model: 42 } }, { sonnet: { model: 'm', unknown: 'not allowed' } }, { subagent: { model: 'm', displayName: '' } },
    { sonnet: { model: 'm', supports1m: 'true' } }, { sonnet: { model: 'm', supports1m: 1 } }, { sonnet: { model: 'm', displayName: null } },
    { sonnet: { model: 'm'.repeat(257) } }, { sonnet: { model: 'm', displayName: 'N'.repeat(121) } },
    { sonnet: { model: 'bad\nmodel' } }, { sonnet: { model: 'm', displayName: 'bad\tname' } }, { sonnet: { model: 'bad\u0085model' } },
    ...['__proto__', 'constructor', 'prototype', 'constructor[1m]'].map(model => ({ sonnet: { model } })),
    JSON.parse('{"__proto__":{"model":"m"}}'), Object.create({ sonnet: { model: 'm' } }),
  ];
  for (const claudeModels of badValues) assert.throws(() => f.store.saveProvider({ ...input(), claudeModels }), invalid);
  assert.deepEqual(f.store.snapshot().providers, []); assert.equal(fs.existsSync(f.directory), false);
});

test('encrypted provider reload and public/internal snapshots retain role mappings without exposing credentials', t => {
  const f = fixture(t); const expected = mappings(); const saved = f.store.saveProvider({ ...input(), claudeModels: expected });
  assert.deepEqual(saved.claudeModels, expected); assert.equal(saved.apiKey, undefined); assert.equal(saved.hasCredential, true);
  const disk = fs.readFileSync(path.join(f.directory, 'ai-tools-store.v1.json'), 'utf8');
  for (const hidden of ['fixture-sonnet', 'Daily model', input().apiKey]) assert.equal(disk.includes(hidden), false);
  const reloaded = createAiToolsStore(f.options);
  assert.deepEqual(reloaded.snapshot().providers[0].claudeModels, expected);
  assert.deepEqual(reloaded.getProvider(saved.id).claudeModels, expected); assert.equal(reloaded.getProvider(saved.id).apiKey, input().apiKey);
  saved.claudeModels.sonnet.model = 'public mutation';
  assert.deepEqual(reloaded.getProvider(saved.id).claudeModels, expected);
  const edit = input(); delete edit.apiKey;
  const kept = reloaded.saveProvider({ ...edit, id: saved.id, name: 'Changed label' });
  assert.deepEqual(kept.claudeModels, expected);
  assert.deepEqual(reloaded.saveProvider({ ...edit, id: saved.id, claudeModels: {} }).claudeModels, {});
});

test('legacy providers remain valid and mapping metadata survives a protocol change', t => {
  const f = fixture(t); const legacy = f.store.saveProvider(input());
  assert.equal(Object.hasOwn(legacy, 'claudeModels'), false);
  assert.equal(Object.hasOwn(createAiToolsStore(f.options).getProvider(legacy.id), 'claudeModels'), false);
  f.store.saveProvider({ ...input(), id: legacy.id, claudeModels: mappings() });
  const changed = f.store.saveProvider({ ...input(), id: legacy.id, baseUrl: 'https://fixture.invalid/v1', protocol: 'openai-responses', targetApps: ['codex'] });
  assert.deepEqual(changed.claudeModels, mappings());
  assert.deepEqual(validateProvider({ ...input(), protocol: 'gemini', targetApps: ['gemini'], claudeModels: mappings() }).claudeModels, mappings());
});

test('native Claude assignments map five roles and names while preserving the default model', () => {
  const provider = { ...input(), claudeModels: mappings() };
  const { env } = parseJsonc(projectConfig('claude', 'settings', '{}', provider).content);
  assert.equal(env.ANTHROPIC_MODEL, provider.model);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'fixture-sonnet[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'fixture-opus[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'fixture-fable');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'fixture-haiku');
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'fixture-subagent');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, 'Daily model');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, 'Reasoning model');
  assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME, 'Balanced model');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME, 'Fast model');
  assert.equal(Object.hasOwn(env, 'CLAUDE_CODE_SUBAGENT_MODEL_NAME'), false);
  const suffix = claudeModelAssignments({ sonnet: { model: 'm[1m][1m]', supports1m: true }, haiku: { model: 'm[1m]' } });
  assert.equal(suffix[0].value, 'm[1m]'); assert.equal(suffix[2].value, 'm[1m]');
});

test('absent or empty mappings keep native aliases; explicit empty rows clear only their managed role', () => {
  const source = JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'old-sonnet', ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'Old name', ANTHROPIC_DEFAULT_OPUS_MODEL: 'external-opus', CLAUDE_CODE_SUBAGENT_MODEL: 'old-subagent', KEEP: 'untouched' } });
  for (const claudeModels of [undefined, {}]) {
    const result = projectConfig('claude', 'settings', source, { ...input(), claudeModels });
    assert.equal(parseJsonc(result.content).env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'old-sonnet');
    assert.equal(result.changes.some(row => row.field.includes('DEFAULT_')), false);
  }
  const explicit = { sonnet: { model: '', displayName: '', supports1m: false }, subagent: { model: '' } };
  const result = projectConfig('claude', 'settings', source, { ...input(), claudeModels: explicit }); const env = parseJsonc(result.content).env;
  assert.equal(Object.hasOwn(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL'), false); assert.equal(Object.hasOwn(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME'), false);
  assert.equal(Object.hasOwn(env, 'CLAUDE_CODE_SUBAGENT_MODEL'), false); assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'external-opus'); assert.equal(env.KEEP, 'untouched');
  assert.equal(result.changes.find(row => row.field === 'env.ANTHROPIC_DEFAULT_SONNET_MODEL').after, null);
});

test('Claude role preview/apply/clear/restore is transactional, redacted and preserves unrelated JSONC', t => {
  const f = fixture(t); const provider = f.store.saveProvider({ ...input(), claudeModels: mappings() });
  const file = path.join(f.home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(file));
  const original = '{\n// keep comment\n"env":{"ANTHROPIC_AUTH_TOKEN":"old-fixture-secret","KEEP":"stay"},"permissions":{"allow":["Read"]}\n}\n';
  fs.writeFileSync(file, original);
  const preview = f.config.preview({ toolId: 'claude', providerId: provider.id });
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(JSON.stringify(preview).includes(input().apiKey), false); assert.equal(JSON.stringify(preview).includes('old-fixture-secret'), false);
  assert.ok(preview.files[0].changes.some(row => row.field === 'env.ANTHROPIC_DEFAULT_SONNET_MODEL' && row.after === 'fixture-sonnet[1m]'));
  const applied = f.config.apply({ token: preview.token }); const mapped = fs.readFileSync(file, 'utf8');
  assert.ok(mapped.includes('// keep comment')); assert.equal(parseJsonc(mapped).env.KEEP, 'stay');
  assert.deepEqual(structuredClone(parseJsonc(mapped).permissions), { allow: ['Read'] });
  const cleared = Object.fromEntries(Object.keys(mappings()).map(role => [role, { model: '' }]));
  f.store.saveProvider({ ...input(), id: provider.id, claudeModels: cleared });
  const clear = f.config.apply({ token: f.config.preview({ toolId: 'claude', providerId: provider.id }).token });
  assert.equal(Object.keys(parseJsonc(fs.readFileSync(file, 'utf8')).env).some(key => key.startsWith('ANTHROPIC_DEFAULT_') || key === 'CLAUDE_CODE_SUBAGENT_MODEL'), false);
  f.config.apply({ token: f.config.previewRestore({ backupId: clear.backupId }).token }); assert.equal(fs.readFileSync(file, 'utf8'), mapped);
  f.config.apply({ token: f.config.previewRestore({ backupId: applied.backupId }).token }); assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('a role edit invalidates an existing apply preview without writing native files', t => {
  const f = fixture(t); const provider = f.store.saveProvider({ ...input(), claudeModels: mappings() });
  const preview = f.config.preview({ toolId: 'claude', providerId: provider.id });
  f.store.saveProvider({ ...input(), id: provider.id, claudeModels: { sonnet: { model: 'changed' } } });
  assert.throws(() => f.config.apply({ token: preview.token }), error => error.code === 'AI_TOOLS_PROVIDER_CHANGED');
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('portable password backup rewraps Claude mappings and credentials with a different machine key', async t => {
  const source = fixture(t); const target = fixture(t); const provider = source.store.saveProvider({ ...input(), claudeModels: mappings() });
  const file = path.join(source.root, 'roles.awbai'); const password = 'fixture-password-123';
  await source.portable.exportBundle({ path: file, password });
  const bytes = fs.readFileSync(file); for (const hidden of ['fixture-sonnet', input().apiKey]) assert.equal(bytes.includes(Buffer.from(hidden)), false);
  const preview = await target.portable.previewImport({ path: file, password });
  assert.equal(JSON.stringify(preview).includes(input().apiKey), false); assert.equal(target.store.snapshot().providers.length, 0);
  target.portable.applyImport({ token: preview.token });
  assert.deepEqual(createAiToolsStore(target.options).getProvider(provider.id).claudeModels, mappings());
  assert.equal(target.store.getProvider(provider.id).apiKey, input().apiKey); assert.deepEqual(fs.readdirSync(target.home), []);
});

test('unified encrypted migration preserves role values and explicit clears without applying client configuration', async t => {
  const source = fixture(t); const target = fixture(t); const claudeModels = { ...mappings(), haiku: { model: '', displayName: '', supports1m: false } };
  const provider = source.store.saveProvider({ ...input(), claudeModels }); const legacy = source.store.saveProvider({ ...input(), name: 'Legacy provider' });
  const ai = await source.migration.exportState({ includeSessions: false });
  const payload = { schemaVersion: 1, appVersion: '4.6.5', createdAt: '2026-10-23T00:00:00.000Z', files: [], preferences: {} };
  const bytes = await migrationCodec.encode({ payload, ai }, 'fixture-password-123');
  assert.equal(bytes.includes(Buffer.from(input().apiKey)), false); assert.equal(bytes.includes(Buffer.from('fixture-sonnet')), false);
  const decoded = await migrationCodec.decode(bytes, 'fixture-password-123');
  const plan = await target.migration.previewImport(decoded.ai);
  assert.equal(plan.summary.providers.added, 2); assert.equal(fs.existsSync(target.directory), false);
  for (const row of plan.writes) {
    assert.equal(row.bytes.includes(Buffer.from(input().apiKey)), false); assert.ok(row.name.startsWith('ai-tools/'));
    const file = path.join(path.dirname(target.directory), ...row.name.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, row.bytes);
  }
  const reloaded = createAiToolsStore(target.options);
  assert.deepEqual(reloaded.getProvider(provider.id).claudeModels, claudeModels); assert.equal(Object.hasOwn(reloaded.getProvider(legacy.id), 'claudeModels'), false);
  assert.deepEqual(fs.readdirSync(target.home), []);
});
