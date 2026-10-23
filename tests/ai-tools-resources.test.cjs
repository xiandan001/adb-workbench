const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const jsonc = require('jsonc-parser');
const toml = require('smol-toml');
const { createAiToolsResources } = require('../electron/lib/ai-tools-resources.cjs');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-resources-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  const options = {
    directory: path.join(root, 'library'), home: path.join(root, 'home'), backupDirectory: path.join(root, 'backups'),
    canEncrypt: () => true,
    encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decrypt(value) { const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]).toString('utf8'); },
    ...overrides,
  };
  const service = createAiToolsResources(options);
  return { root, options, service, write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); } };
}
const mcpInput = extra => ({ name: 'Local tools', type: 'stdio', command: 'node', args: ['server.js'], ...extra });
const promptInput = extra => ({ name: 'Review guidance', content: 'Review carefully.\n保留中文。', ...extra });
const code = expected => error => error.code === expected;

test('constructor and empty snapshot do not inspect CLI/auth files or create anything', t => {
  const { service, root } = fixture(t);
  assert.equal(fs.readdirSync(root).length, 0);
  const snapshot = service.snapshot();
  assert.deepEqual(snapshot.mcpServers, []); assert.deepEqual(snapshot.prompts, []);
  assert.equal(snapshot.tools.filter(row => row.mcpSupported).length, 4);
  assert.equal(snapshot.tools.filter(row => row.promptSupported).length, 11);
  assert.equal(fs.readdirSync(root).length, 0);
});

test('encrypted CRUD returns no env/header values, preserves omitted secrets and separates library from targets', t => {
  const { service, options } = fixture(t);
  const row = service.saveMcp(mcpInput({ env: { PRIVATE_KEY: 'fixture-env-secret' } }));
  assert.match(row.key, /^awb_[a-f0-9]{32}$/); assert.deepEqual(row.envKeys, ['PRIVATE_KEY']);
  assert.equal(row.hasSecrets, true); assert.equal(row.env, undefined);
  const file = path.join(options.directory, 'ai-tools-resources.v1.json');
  assert.equal(fs.readFileSync(file, 'utf8').includes('fixture-env-secret'), false);
  assert.equal(fs.existsSync(options.home), false);
  const updated = service.saveMcp(mcpInput({ id: row.id, name: 'Renamed' }));
  assert.equal(updated.hasSecrets, true);
  const reopened = createAiToolsResources(options);
  assert.equal(reopened.snapshot().mcpServers[0].name, 'Renamed');
  assert.equal(JSON.stringify(reopened.snapshot()).includes('fixture-env-secret'), false);
  const cleared = service.saveMcp(mcpInput({ id: row.id, env: null })); assert.equal(cleared.hasSecrets, false);
  service.removeMcp({ id: row.id }); assert.deepEqual(service.snapshot().mcpServers, []);
  const prompt = service.savePrompt(promptInput()); assert.equal(prompt.content, promptInput().content);
  service.removePrompt({ id: prompt.id }); assert.deepEqual(service.snapshot().prompts, []);
});

for (const toolId of ['claude', 'codex', 'gemini', 'opencode']) {
  test(`MCP ${toolId} applies one own entry, preserves external fields/comments, disables and restores exact bytes`, t => {
    const { service, write } = fixture(t);
    const row = service.saveMcp(mcpInput({ env: { SECRET: 'not-in-preview' } }));
    const target = service.snapshot().tools.find(tool => tool.id === toolId).mcpPath;
    const original = toolId === 'codex' ? '# user comment\nmodel = "mine"\n[mcp_servers.external]\ncommand = "keep"\n' : '{\n // user comment\n "model":"mine", "unrelated":{"x":1}, "mcpServers":{"external":{"command":"keep"}}, "mcp":{"external":{"type":"local","command":["keep"]}}\n}\n';
    write(target, original);
    const preview = service.previewMcp({ toolId, mcpId: row.id, enabled: true });
    assert.equal(JSON.stringify(preview).includes('not-in-preview'), false);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    const applied = service.apply({ token: preview.token });
    const content = fs.readFileSync(target, 'utf8'); assert.match(content, /user comment/);
    const parsed = toolId === 'codex' ? toml.parse(content) : jsonc.parse(content);
    const map = toolId === 'codex' ? parsed.mcp_servers : toolId === 'opencode' ? parsed.mcp : parsed.mcpServers;
    assert.ok(map.external); assert.ok(map[row.key]); assert.equal(parsed.model, 'mine');
    if (toolId === 'opencode') { assert.equal(map[row.key].type, 'local'); assert.equal(map[row.key].environment.SECRET, 'not-in-preview'); }
    else { assert.equal(map[row.key].env.SECRET, 'not-in-preview'); if (toolId === 'codex') assert.equal(map[row.key].type, undefined); }
    assert.throws(() => service.removeMcp({ id: row.id }), code('AI_TOOLS_RESOURCE_IN_USE'));
    assert.throws(() => service.apply({ token: preview.token }), code('AI_TOOLS_PREVIEW_EXPIRED'));
    const restore = service.previewRestore({ backupId: applied.backupId }); service.apply({ token: restore.token });
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    service.apply({ token: service.previewMcp({ toolId, mcpId: row.id, enabled: true }).token });
    service.apply({ token: service.previewMcp({ toolId, mcpId: row.id, enabled: false }).token });
    const afterDisable = toolId === 'codex' ? toml.parse(fs.readFileSync(target, 'utf8')) : jsonc.parse(fs.readFileSync(target, 'utf8'));
    assert.equal((toolId === 'codex' ? afterDisable.mcp_servers : toolId === 'opencode' ? afterDisable.mcp : afterDisable.mcpServers)[row.key], undefined);
    service.removeMcp({ id: row.id });
  });
}

test('remote MCP transports use verified native fields and never expose header values', t => {
  const { service } = fixture(t);
  const row = service.saveMcp({ name: 'Remote', type: 'http', url: 'https://fixture.invalid/mcp', headers: { Authorization: 'Bearer fixture-secret' } });
  assert.deepEqual(row.headerKeys, ['Authorization']);
  for (const toolId of ['claude', 'codex', 'gemini', 'opencode']) {
    const preview = service.previewMcp({ toolId, mcpId: row.id, enabled: true }); service.apply({ token: preview.token });
    const content = fs.readFileSync(preview.files[0].path, 'utf8');
    const parsed = toolId === 'codex' ? toml.parse(content) : jsonc.parse(content);
    const entry = (toolId === 'codex' ? parsed.mcp_servers : toolId === 'opencode' ? parsed.mcp : parsed.mcpServers)[row.key];
    assert.equal(entry[toolId === 'gemini' ? 'httpUrl' : 'url'], 'https://fixture.invalid/mcp');
    assert.equal(entry[toolId === 'codex' ? 'http_headers' : 'headers'].Authorization, 'Bearer fixture-secret');
  }
});

test('all verified prompt tools preserve outside bytes, replace only managed block and disable safely', t => {
  const { service, write } = fixture(t);
  const first = service.savePrompt(promptInput()); const second = service.savePrompt(promptInput({ name: 'Second', content: 'new text' }));
  for (const tool of service.snapshot().tools.filter(row => row.promptSupported)) {
    const original = '\uFEFF# User instructions\r\nDo not remove.\r\n'; write(tool.promptPath, original);
    service.apply({ token: service.previewPrompt({ toolId: tool.id, promptId: first.id, enabled: true }).token });
    let content = fs.readFileSync(tool.promptPath, 'utf8'); assert.ok(content.startsWith(original)); assert.ok(content.includes(first.content));
    service.apply({ token: service.previewPrompt({ toolId: tool.id, promptId: second.id, enabled: true }).token });
    content = fs.readFileSync(tool.promptPath, 'utf8'); assert.ok(content.startsWith(original)); assert.ok(content.includes(second.content)); assert.equal(content.includes(first.content), false);
    service.apply({ token: service.previewPrompt({ toolId: tool.id, promptId: second.id, enabled: false }).token });
    assert.equal(fs.readFileSync(tool.promptPath, 'utf8'), original);
  }
});

test('preview is bound to resource fingerprint, file hash, lifetime and original target', t => {
  let clock = 100; const { service, write } = fixture(t, { now: () => clock });
  const row = service.savePrompt(promptInput());
  const old = service.previewPrompt({ toolId: 'claude', promptId: row.id, enabled: true });
  service.savePrompt(promptInput({ id: row.id, content: 'changed' }));
  assert.throws(() => service.apply({ token: old.token }), code('AI_TOOLS_RESOURCE_CHANGED'));
  const changed = service.previewPrompt({ toolId: 'claude', promptId: row.id, enabled: true });
  write(changed.files[0].path, 'external');
  assert.throws(() => service.apply({ token: changed.token }), code('AI_TOOLS_CONFIG_CHANGED'));
  const expired = service.previewPrompt({ toolId: 'claude', promptId: row.id, enabled: true }); clock += 300001;
  assert.throws(() => service.apply({ token: expired.token }), code('AI_TOOLS_PREVIEW_EXPIRED'));
});

test('missing files restore to missing, changed files and unknown managed blocks are never overwritten', t => {
  const { service, write } = fixture(t);
  const prompt = service.savePrompt(promptInput());
  const preview = service.previewPrompt({ toolId: 'claude', promptId: prompt.id, enabled: true });
  const applied = service.apply({ token: preview.token });
  service.apply({ token: service.previewRestore({ backupId: applied.backupId }).token });
  assert.equal(fs.existsSync(preview.files[0].path), false);
  write(preview.files[0].path, '<!-- adb-workbench:prompt:start -->\nforeign\n<!-- adb-workbench:prompt:end -->');
  assert.throws(() => service.previewPrompt({ toolId: 'claude', promptId: prompt.id, enabled: true }), code('AI_TOOLS_RESOURCE_CONFLICT'));
  const mcp = service.saveMcp(mcpInput()); const target = service.snapshot().tools.find(tool => tool.id === 'claude').mcpPath;
  write(target, JSON.stringify({ mcpServers: { [mcp.key]: { command: 'external' } } }));
  assert.throws(() => service.previewMcp({ toolId: 'claude', mcpId: mcp.id, enabled: true }), code('AI_TOOLS_RESOURCE_CONFLICT'));
});

test('invalid schemas, command secrets in URL, prompt marker injection and over-limit content are refused', t => {
  const { service } = fixture(t);
  for (const value of [mcpInput({ type: 'other' }), mcpInput({ args: [1] }), mcpInput({ env: JSON.parse('{"__proto__":"bad"}') }), { name: 'bad', type: 'http', url: 'https://user:pass@fixture.invalid/mcp' }, { name: 'bad', type: 'http', url: 'https://fixture.invalid/mcp?token=secret' }]) assert.throws(() => service.saveMcp(value));
  assert.throws(() => service.savePrompt(promptInput({ content: '<!-- adb-workbench:prompt:start -->' })));
  assert.throws(() => service.savePrompt(promptInput({ content: 'a'.repeat(128 * 1024 + 1) })));
  const large = service.savePrompt(promptInput({ content: '中'.repeat(12000) }));
  assert.throws(() => service.previewPrompt({ toolId: 'mcode', promptId: large.id, enabled: true }), code('AI_TOOLS_RESOURCE_LIMIT'));
  assert.throws(() => service.previewMcp({ toolId: 'claudedesktop', mcpId: 'x', enabled: true }), code('AI_TOOLS_RESOURCE_UNSUPPORTED'));
});

test('memory-only library reports persistence truthfully and cannot modify native files without encrypted backup', t => {
  const { service, options } = fixture(t, { canEncrypt: () => false });
  const row = service.saveMcp(mcpInput());
  assert.equal(service.snapshot().persistent, false); assert.ok(service.snapshot().warning);
  assert.equal(fs.existsSync(options.directory), false);
  assert.throws(() => service.apply({ token: service.previewMcp({ toolId: 'claude', mcpId: row.id, enabled: true }).token }), code('AI_TOOLS_ENCRYPTION_UNAVAILABLE'));
  assert.equal(fs.existsSync(options.home), false);
});

test('corrupt or externally changed encrypted library is preserved instead of silently overwritten', t => {
  const { service, options, write } = fixture(t);
  service.savePrompt(promptInput()); const file = path.join(options.directory, 'ai-tools-resources.v1.json');
  write(file, 'corrupt original');
  assert.throws(() => service.savePrompt(promptInput({ name: 'Next' })), code('AI_TOOLS_RESOURCE_STORE_CHANGED'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt original');
  assert.throws(() => createAiToolsResources(options).snapshot(), code('AI_TOOLS_RESOURCE_STORE_READ'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt original');
});

test('MCP URL changes require explicit replacement or removal of existing secret headers', t => {
  const { service } = fixture(t);
  const row = service.saveMcp({ name: 'Remote', type: 'http', url: 'https://first.invalid/mcp', headers: { Authorization: 'fixture-secret' } });
  assert.throws(() => service.saveMcp({ id: row.id, name: row.name, type: 'http', url: 'https://second.invalid/mcp' }), code('AI_TOOLS_CREDENTIAL_ORIGIN'));
  const updated = service.saveMcp({ id: row.id, name: row.name, type: 'http', url: 'https://second.invalid/mcp', headers: null });
  assert.equal(updated.hasSecrets, false);
});

test('JSONC preference, TOML dates and outside prompt suffix are preserved exactly', t => {
  const { service, options, write } = fixture(t);
  const mcp = service.saveMcp(mcpInput());
  const json = path.join(options.home, '.config', 'opencode', 'opencode.json'); const preferred = `${json}c`;
  write(json, '{"leave":"alone"}'); write(preferred, '{ // active\n "theme":"dark"\n}');
  const preview = service.previewMcp({ toolId: 'opencode', mcpId: mcp.id, enabled: true });
  assert.equal(preview.files[0].path, preferred); service.apply({ token: preview.token }); assert.equal(fs.readFileSync(json, 'utf8'), '{"leave":"alone"}');
  const codex = service.snapshot().tools.find(tool => tool.id === 'codex').mcpPath;
  const original = 'stamp = 1979-05-27T07:32:00Z\nlocal = 07:32:00\n# preserve date types\n'; write(codex, original);
  service.apply({ token: service.previewMcp({ toolId: 'codex', mcpId: mcp.id, enabled: true }).token });
  assert.ok(fs.readFileSync(codex, 'utf8').startsWith(original));
  const prompt = service.savePrompt(promptInput()); const promptPath = service.snapshot().tools.find(tool => tool.id === 'claude').promptPath;
  write(promptPath, 'prefix'); service.apply({ token: service.previewPrompt({ toolId: 'claude', promptId: prompt.id, enabled: true }).token });
  fs.appendFileSync(promptPath, 'user suffix\r\n');
  service.apply({ token: service.previewPrompt({ toolId: 'claude', promptId: prompt.id, enabled: false }).token });
  assert.equal(fs.readFileSync(promptPath, 'utf8'), 'prefixuser suffix\r\n');
});

test('MCP managed entry external edits and malformed duplicate prompt markers fail closed', t => {
  const { service, write } = fixture(t); const row = service.saveMcp(mcpInput());
  const preview = service.previewMcp({ toolId: 'claude', mcpId: row.id, enabled: true }); service.apply({ token: preview.token });
  const parsed = jsonc.parse(fs.readFileSync(preview.files[0].path, 'utf8')); parsed.mcpServers[row.key].command = 'external'; write(preview.files[0].path, JSON.stringify(parsed));
  assert.throws(() => service.previewMcp({ toolId: 'claude', mcpId: row.id, enabled: false }), code('AI_TOOLS_RESOURCE_CONFLICT'));
  const prompt = service.savePrompt(promptInput()); const file = service.snapshot().tools.find(tool => tool.id === 'claude').promptPath;
  write(file, '\n<!-- adb-workbench:prompt:start -->\n<!-- adb-workbench:prompt:start -->\n<!-- adb-workbench:prompt:end -->\n');
  assert.throws(() => service.previewPrompt({ toolId: 'claude', promptId: prompt.id, enabled: true }), code('AI_TOOLS_RESOURCE_CONFLICT'));
});

test('apply rolls target back when application metadata cannot persist and exposes only backup ID', t => {
  let failLibrary = false; const io = Object.create(fs);
  io.renameSync = (from, to) => { if (failLibrary && path.basename(to) === 'ai-tools-resources.v1.json') throw Object.assign(new Error('fixture only'), { code: 'EIO' }); return fs.renameSync(from, to); };
  const { service, write } = fixture(t, { filesystem: io }); const row = service.savePrompt(promptInput());
  const file = service.snapshot().tools.find(tool => tool.id === 'claude').promptPath; write(file, 'original');
  const preview = service.previewPrompt({ toolId: 'claude', promptId: row.id, enabled: true }); failLibrary = true;
  let failure; try { service.apply({ token: preview.token }); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'AI_TOOLS_RESOURCE_APPLY_FAILED'); assert.match(failure.backupId, /^[a-f0-9-]{36}$/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original'); assert.deepEqual(service.snapshot().prompts[0].applications, []);
  assert.equal(service.listBackups().length, 1);
});

test('backup is encrypted, restore detects changed target and cannot restore a deleted library resource', t => {
  const { service, write, options } = fixture(t); const row = service.savePrompt(promptInput());
  const file = service.snapshot().tools.find(tool => tool.id === 'claude').promptPath; write(file, 'private-original');
  const applied = service.apply({ token: service.previewPrompt({ toolId: 'claude', promptId: row.id, enabled: true }).token });
  assert.equal(fs.readFileSync(path.join(options.backupDirectory, `${applied.backupId}.json`), 'utf8').includes('private-original'), false);
  fs.appendFileSync(file, 'changed'); assert.throws(() => service.previewRestore({ backupId: applied.backupId }), code('AI_TOOLS_CONFIG_CHANGED'));
  const disabled = service.apply({ token: service.previewPrompt({ toolId: 'claude', promptId: row.id, enabled: false }).token }); service.removePrompt({ id: row.id });
  assert.throws(() => service.previewRestore({ backupId: disabled.backupId }), code('AI_TOOLS_RESOURCE_MISSING'));
});

test('link targets, login path overrides and unsafe getters are refused without side effects', t => {
  const { service, options, root, write } = fixture(t); const row = service.saveMcp(mcpInput());
  const target = service.snapshot().tools.find(tool => tool.id === 'claude').mcpPath; const original = path.join(root, 'external'); write(original, '{}'); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.linkSync(original, target);
  assert.throws(() => service.previewMcp({ toolId: 'claude', mcpId: row.id, enabled: true }), code('AI_TOOLS_CONFIG_FILE'));
  assert.throws(() => createAiToolsResources({ ...options, paths: { 'claude.mcp': path.join(root, 'auth.json') } }), code('AI_TOOLS_RESOURCE_PATH'));
  let accessed = false; const unsafe = mcpInput(); Object.defineProperty(unsafe, 'id', { get() { accessed = true; return row.id; }, enumerable: true });
  assert.throws(() => service.saveMcp(unsafe)); assert.equal(accessed, false);
});

test('encrypted library and applications reopen without target scanning; dispose blocks reuse', t => {
  const { service, options } = fixture(t); const row = service.savePrompt(promptInput());
  service.apply({ token: service.previewPrompt({ toolId: 'pi', promptId: row.id, enabled: true }).token });
  const reopened = createAiToolsResources(options); assert.deepEqual(reopened.snapshot().prompts[0].applications, ['pi']);
  reopened.apply({ token: reopened.previewPrompt({ toolId: 'pi', promptId: row.id, enabled: false }).token });
  assert.deepEqual(reopened.snapshot().prompts[0].applications, []); reopened.dispose();
  assert.throws(() => reopened.snapshot(), code('AI_TOOLS_RESOURCE_DISPOSED'));
});

test('duplicate JSONC property names cannot hide an external MCP entry from ownership validation', t => {
  const { service, write } = fixture(t); const row = service.saveMcp(mcpInput());
  const preview = service.previewMcp({ toolId: 'claude', mcpId: row.id, enabled: true }); service.apply({ token: preview.token });
  const file = preview.files[0].path; const native = jsonc.parse(fs.readFileSync(file, 'utf8')).mcpServers[row.key];
  const duplicate = `{"mcpServers":{"${row.key}":{"command":"foreign-preserve"},"${row.key}":${JSON.stringify(native)}}}`;
  write(file, duplicate);
  assert.throws(() => service.previewMcp({ toolId: 'claude', mcpId: row.id, enabled: true }), code('AI_TOOLS_RESOURCE_FORMAT'));
  assert.equal(fs.readFileSync(file, 'utf8'), duplicate);
  write(file, `{"mcpServers":{"${row.key}":${JSON.stringify(native)}},"unrelated":{"nested":1,"nested":2}}`);
  assert.throws(() => service.previewMcp({ toolId: 'claude', mcpId: row.id, enabled: false }), code('AI_TOOLS_RESOURCE_FORMAT'));
});
