const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const toml = require('smol-toml');
const { normalizeCliConfig } = require('../electron/lib/ai-tools-cli-config.cjs');
const { createAiToolsStore } = require('../electron/lib/ai-tools-store.cjs');
const { createAiToolsConfig } = require('../electron/lib/ai-tools-config.cjs');
const { createAiToolsMigration } = require('../electron/lib/ai-tools-migration-state.cjs');
const { createAiToolsResources } = require('../electron/lib/ai-tools-resources.cjs');
const { createAiToolsPortable } = require('../electron/lib/ai-tools-portable.cjs');
const { projectConfig, parseJsonc } = require('../electron/lib/ai-tools-config-adapters.cjs');
const codec = require('../electron/lib/data-migration-v2.cjs');

const provider = (tool = 'claude', cliConfig) => ({ name: 'Native fixture', protocol: tool === 'claude' ? 'anthropic' : 'openai-responses', baseUrl: tool === 'claude' ? 'https://fixture.invalid/anthropic' : 'https://fixture.invalid/v1', model: 'fixture-model', targetApps: [tool], apiKey: 'fixture-native-private-key', ...(cliConfig ? { cliConfig } : {}) });
const settings = () => ({ claude: { authField: 'ANTHROPIC_API_KEY', timeoutMs: 120000, maxOutputTokens: 12000, maxThinkingTokens: 2000, contextTokens: 128000, autoCompactPercent: 70, effort: 'high', agentTeams: false, toolSearch: 'auto:5', disableAutoupdater: false, settingsJson: '{"language":"简体中文","showTurnDuration":true,"attribution":{"commit":"Custom attribution"}}' },
  codex: { reasoningEffort: 'high', reasoningSummary: 'concise', contextWindow: 128000, autoCompactTokenLimit: 100000, personality: 'none', verbosity: 'low', httpHeaders: { 'User-Agent': 'fixture-client', 'OpenAI-Project': 'fixture-project' }, extraToml: 'hide_agent_reasoning = false\n[tui]\nanimations = false\nalternate_screen = "never"\n[history]\npersistence = "save-all"\n' } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-cli-config-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const directory = path.join(root, 'data', 'ai-tools'); fs.mkdirSync(home);
  const key = crypto.randomBytes(32);
  const options = { home, directory, canEncrypt: () => true,
    encrypt(value) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(value), c.final(), c.getAuthTag()]); },
    decrypt(value) { const d = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); d.setAuthTag(value.subarray(-16)); return Buffer.concat([d.update(value.subarray(12, -16)), d.final()]).toString('utf8'); },
  };
  const store = createAiToolsStore(options); const config = createAiToolsConfig({ ...options, backupDirectory: path.join(directory, 'config-backups'), getProvider: store.getProvider }); t.after(() => config.dispose());
  const migration = createAiToolsMigration(options); t.after(() => migration.dispose());
  const resources = createAiToolsResources({ ...options, backupDirectory: path.join(directory, 'resource-backups') }); t.after(() => resources.dispose());
  const portable = createAiToolsPortable({ directory: path.join(directory, 'portable'), providers: store, resources }); t.after(() => portable.dispose());
  const write = (name, content) => { const file = path.join(home, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  return { root, home, directory, options, store, config, migration, portable, write };
}

test('native advanced schema is optional, bounded and rejects credentials, commands, managed duplicates and unsafe supplements', () => {
  assert.deepEqual(normalizeCliConfig(settings()), settings()); assert.deepEqual(normalizeCliConfig({}), {});
  const bad = [null, [], { other: {} }, { claude: { timeoutMs: -1 } }, { claude: { timeoutMs: 1.2 } }, { claude: { agentTeams: 'true' } }, { claude: { authField: 'Authorization' } },
    { codex: { reasoningEffort: 'unlimited' } }, { codex: { contextWindow: 2147483648 } }, { claude: { settingsJson: '{"language":"en","language":"cn"}' } },
    ...['env', 'model', 'permissions', 'hooks', 'mcpServers', 'apiKeyHelper', 'enabledPlugins', '__proto__'].map(key => ({ claude: { settingsJson: JSON.stringify({ [key]: {} }) } })),
    ...['model="other"', 'model_provider="other"', 'approval_policy="never"', 'sandbox_mode="danger-full-access"', '[mcp_servers.test]\ncommand="run"', '[model_providers.private]\nexperimental_bearer_token="private"', 'hide_agent_reasoning=true\nhide_agent_reasoning=false'].map(extraToml => ({ codex: { extraToml } })),
    { codex: { httpHeaders: { Authorization: 'private' } } }, { codex: { httpHeaders: { 'User-Agent': 'Bearer private-fixture' } } }, { codex: { httpHeaders: { 'User-Agent': 'a', 'user-agent': 'b' } } },
    { codex: { httpHeaders: { 'HTTP-Referer': 'https://site.invalid/?token=private' } } }, { claude: { settingsJson: '{"language":"sk-12345678901234567890"}' } },
  ];
  for (const value of bad) assert.throws(() => normalizeCliConfig(value), error => { assert.equal(error.code, 'AI_TOOLS_CLI_CONFIG_INVALID'); assert.equal(error.message.includes('private-fixture'), false); return true; });
  assert.deepEqual(normalizeCliConfig({ codex: { httpHeaders: { 'user-agent': 'client', 'X-Title': null } } }).codex.httpHeaders, { 'User-Agent': 'client', 'X-Title': null });
});

test('Claude settings write real env and supplemental keys, select auth explicitly, preserve native safety and restore exact bytes', t => {
  const f = fixture(t); const row = f.store.saveProvider(provider('claude', settings()));
  const original = '// keep this comment\n{"env":{"ANTHROPIC_AUTH_TOKEN":"old-private","KEEP":"yes"},"permissions":{"defaultMode":"default"},"hooks":{"SessionStart":[]},"mcpServers":{"owned":{"command":"never-executed"}}}\n';
  const file = f.write('.claude/settings.json', original); const auth = f.write('.claude/.credentials.json', 'DO-NOT-READ-OR-CHANGE');
  const preview = f.config.preview({ toolId: 'claude', providerId: row.id });
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(JSON.stringify(preview).includes('old-private'), false); assert.equal(JSON.stringify(preview).includes(provider().apiKey), false);
  const applied = f.config.apply({ token: preview.token }); const actual = parseJsonc(fs.readFileSync(file, 'utf8'));
  assert.equal(actual.env.ANTHROPIC_API_KEY, provider().apiKey); assert.equal(actual.env.ANTHROPIC_AUTH_TOKEN, undefined);
  for (const [name, value] of Object.entries({ API_TIMEOUT_MS: '120000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '12000', MAX_THINKING_TOKENS: '2000', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '128000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70', CLAUDE_CODE_EFFORT_LEVEL: 'high', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0', ENABLE_TOOL_SEARCH: 'auto:5', DISABLE_AUTOUPDATER: '0' })) assert.equal(actual.env[name], value);
  assert.equal(actual.language, '简体中文'); assert.equal(actual.showTurnDuration, true); assert.equal(actual.attribution.commit, 'Custom attribution'); assert.equal(actual.env.KEEP, 'yes');
  assert.deepEqual(structuredClone(actual.permissions), { defaultMode: 'default' }); assert.deepEqual(structuredClone(actual.hooks), { SessionStart: [] }); assert.equal(actual.mcpServers.owned.command, 'never-executed');
  f.config.apply({ token: f.config.previewRestore({ backupId: applied.backupId }).token }); assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(fs.readFileSync(auth, 'utf8'), 'DO-NOT-READ-OR-CHANGE');
});

test('native optional omission preserves existing advanced settings and explicit null removes only selected keys', t => {
  const f = fixture(t); const row = f.store.saveProvider(provider());
  const file = f.write('.claude/settings.json', '{"env":{"API_TIMEOUT_MS":"9000","MAX_THINKING_TOKENS":"5000","KEEP":"yes"},"language":"en"}\n');
  f.config.apply({ token: f.config.preview({ toolId: 'claude', providerId: row.id }).token }); assert.equal(parseJsonc(fs.readFileSync(file, 'utf8')).env.API_TIMEOUT_MS, '9000');
  f.store.saveProvider({ ...provider(), id: row.id, cliConfig: { claude: { timeoutMs: null, settingsJson: '{"language":null}' } } });
  f.config.apply({ token: f.config.preview({ toolId: 'claude', providerId: row.id }).token }); const actual = parseJsonc(fs.readFileSync(file, 'utf8'));
  assert.equal(actual.env.API_TIMEOUT_MS, undefined); assert.equal(actual.env.MAX_THINKING_TOKENS, '5000'); assert.equal(actual.language, undefined); assert.equal(actual.env.KEEP, 'yes');
});

test('Codex advanced settings and headers apply to real TOML while preserving other providers, MCP, hooks and auth file', t => {
  const f = fixture(t); const row = f.store.saveProvider(provider('codex', settings()));
  const original = '# keep comment\napproval_policy = "on-request"\n[model_providers.other]\nbase_url = "https://other.invalid"\n[mcp_servers.keep]\ncommand = "never-executed"\n[tui]\nnotifications = true\n';
  const file = f.write('.codex/config.toml', original); const auth = f.write('.codex/auth.json', 'NEVER-READ-LOGIN-TOKEN');
  const applied = f.config.apply({ token: f.config.preview({ toolId: 'codex', providerId: row.id }).token }); const raw = fs.readFileSync(file, 'utf8'); const actual = toml.parse(raw);
  assert.equal(actual.model_reasoning_effort, 'high'); assert.equal(actual.model_reasoning_summary, 'concise'); assert.equal(actual.model_context_window, 128000); assert.equal(actual.model_auto_compact_token_limit, 100000); assert.equal(actual.personality, 'none'); assert.equal(actual.model_verbosity, 'low');
  assert.equal(actual.model_providers[actual.model_provider].http_headers['User-Agent'], 'fixture-client'); assert.equal(actual.tui.animations, false); assert.equal(actual.tui.notifications, true); assert.equal(actual.history.persistence, 'save-all');
  assert.equal(actual.approval_policy, 'on-request'); assert.equal(actual.mcp_servers.keep.command, 'never-executed'); assert.equal(actual.model_providers.other.base_url, 'https://other.invalid'); assert.ok(raw.includes('# keep comment'));
  assert.equal(projectConfig('codex', 'settings', raw, f.store.getProvider(row.id)).content, raw);
  f.config.apply({ token: f.config.previewRestore({ backupId: applied.backupId }).token }); assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(fs.readFileSync(auth, 'utf8'), 'NEVER-READ-LOGIN-TOKEN');
});

test('Codex clears selected scalar fields and merges or clears both inline and table-style native headers', t => {
  for (const format of ['inline', 'table']) {
    const f = fixture(t); const row = f.store.saveProvider(provider('codex')); const id = `awb_${row.id.replaceAll('-', '')}`;
    const headers = format === 'inline' ? 'http_headers = { "user-agent" = "old", "X-Owned" = "keep" }\n' : `[model_providers.${id}.http_headers]\nuser-agent = "old"\nX-Owned = "keep"\n`;
    const file = f.write('.codex/config.toml', `model_reasoning_effort = "high" # keep note\nmodel_context_window = 128000\n[model_providers.${id}]\nname = "old"\n${headers}`);
    f.store.saveProvider({ ...provider('codex'), id: row.id, cliConfig: { codex: { reasoningEffort: null, httpHeaders: { 'User-Agent': 'new', 'OpenAI-Project': 'project' } } } });
    f.config.apply({ token: f.config.preview({ toolId: 'codex', providerId: row.id }).token }); let actual = toml.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(actual.model_reasoning_effort, undefined); assert.equal(actual.model_context_window, 128000); assert.equal(actual.model_providers[id].http_headers['X-Owned'], 'keep'); assert.equal(actual.model_providers[id].http_headers['User-Agent'], 'new'); assert.equal(actual.model_providers[id].http_headers['user-agent'], undefined);
    assert.ok(fs.readFileSync(file, 'utf8').includes('# keep note'));
    f.store.saveProvider({ ...provider('codex'), id: row.id, cliConfig: { codex: { httpHeaders: null } } });
    f.config.apply({ token: f.config.preview({ toolId: 'codex', providerId: row.id }).token }); actual = toml.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.keys(actual.model_providers[id].http_headers || {}).length, 0);
  }
});

test('Codex native command auth and extra auth headers are not silently mixed with saved API credentials', t => {
  const f = fixture(t); const row = f.store.saveProvider(provider('codex')); const id = `awb_${row.id.replaceAll('-', '')}`;
  const file = f.write('.codex/config.toml', `[model_providers.${id}]\nhttp_headers = { Authorization = "OLD-SECRET" }\n`);
  assert.throws(() => f.config.preview({ toolId: 'codex', providerId: row.id }), /认证/);
  f.store.saveProvider({ ...provider('codex'), id: row.id, cliConfig: { codex: { httpHeaders: null } } });
  const preview = f.config.preview({ toolId: 'codex', providerId: row.id }); assert.equal(JSON.stringify(preview).includes('OLD-SECRET'), false); f.config.apply({ token: preview.token });
  fs.writeFileSync(file, `[model_providers.${id}.auth]\ncommand = "never-executed"\n`); assert.throws(() => f.config.preview({ toolId: 'codex', providerId: row.id }), /命令式/);
});

test('obvious Responses/Anthropic address mistakes cannot be newly saved or applied, while legacy wrong rows remain editable', t => {
  const f = fixture(t); const wrong = { ...provider('codex'), id: crypto.randomUUID(), baseUrl: 'https://fixture.invalid/api/anthropic' };
  assert.throws(() => f.store.saveProvider(wrong), /Responses/);
  fs.mkdirSync(f.directory, { recursive: true }); fs.writeFileSync(path.join(f.directory, 'ai-tools-store.v1.json'), JSON.stringify({ version: 1, encrypted: f.options.encrypt(JSON.stringify({ version: 1, providers: [wrong] })).toString('base64') }));
  const reloaded = createAiToolsStore(f.options); assert.equal(reloaded.snapshot().providers[0].id, wrong.id);
  assert.throws(() => projectConfig('codex', 'settings', '', wrong), /Responses/);
  reloaded.saveProvider({ ...wrong, baseUrl: 'https://fixture.invalid/v1' }); assert.equal(reloaded.getProvider(wrong.id).baseUrl, 'https://fixture.invalid/v1');
});

test('encrypted store and both migration formats round-trip advanced settings without exposing API credentials or applying CLI settings', async t => {
  const source = fixture(t); const target = fixture(t); const third = fixture(t); const expected = settings(); const row = source.store.saveProvider(provider('claude', expected));
  assert.deepEqual(row.cliConfig, expected); assert.equal(row.apiKey, undefined);
  const edited = source.store.saveProvider({ ...provider(), id: row.id, name: 'Renamed' }); assert.deepEqual(edited.cliConfig, expected);
  assert.deepEqual(createAiToolsStore(source.options).getProvider(row.id).cliConfig, expected);
  assert.equal(fs.readFileSync(path.join(source.directory, 'ai-tools-store.v1.json'), 'utf8').includes('fixture-client'), false);
  const file = path.join(source.root, 'native.awbai'); await source.portable.exportBundle({ path: file, password: 'fixture-password' }); target.portable.applyImport({ token: (await target.portable.previewImport({ path: file, password: 'fixture-password' })).token });
  assert.deepEqual(target.store.getProvider(row.id).cliConfig, expected);
  const ai = await source.migration.exportState({ includeSessions: false }); const payload = { schemaVersion: 1, appVersion: '4.6.5', createdAt: '2026-10-23T00:00:00.000Z', files: [], preferences: {} };
  const bytes = await codec.encode({ payload, ai }, 'fixture-password'); assert.equal(bytes.includes(Buffer.from(provider().apiKey)), false);
  const plan = await third.migration.previewImport((await codec.decode(bytes, 'fixture-password')).ai);
  for (const item of plan.writes) { const destination = path.join(path.dirname(third.directory), ...item.name.split('/')); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, item.bytes); }
  assert.deepEqual(createAiToolsStore(third.options).getProvider(row.id).cliConfig, expected);
  assert.deepEqual(fs.readdirSync(target.home), []); assert.deepEqual(fs.readdirSync(third.home), []);
});
