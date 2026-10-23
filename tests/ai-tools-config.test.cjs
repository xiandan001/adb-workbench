const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const toml = require('smol-toml');
const jsonc = require('jsonc-parser');
const yaml = require('yaml');
const JSON5 = require('json5');
const { createAiToolsConfig } = require('../electron/lib/ai-tools-config.cjs');

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const backupDirectory = path.join(root, 'backups');
  fs.mkdirSync(home);
  const providers = new Map(); let clock = 1000;
  const encryptionKey = crypto.randomBytes(32);
  const options = {
    home, localAppData: path.join(root, 'local'), backupDirectory, getProvider: id => { if (!providers.has(id)) throw new Error('missing'); return structuredClone(providers.get(id)); }, now: () => clock,
    canEncrypt: () => true,
    encrypt(plain) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv); return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
    decrypt(bytes) { const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'); },
    ...extra,
  };
  const write = (relative, bytes) => { const file = path.join(home, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const add = (protocol, toolId) => {
    const row = { id: crypto.randomUUID(), name: 'Fixture', protocol, model: 'fixture-model', baseUrl: 'https://api.example.test/v1', apiKey: 'new-fixture-secret', targetApps: [toolId] };
    providers.set(row.id, row); return row;
  };
  return { root, home, backupDirectory, providers, options, write, add, service: createAiToolsConfig(options), setClock: value => { clock = value; } };
}

test('Claude preview is read-only, hides both secrets and preserves JSONC comments/unmanaged values', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'claude');
  const source = '{\n // keep this comment\n "env": {"ANTHROPIC_AUTH_TOKEN":"old-fixture-secret","KEEP":"stay"},\n "permissions": {"allow":["Read"]}\n}\n';
  const file = f.write('.claude/settings.json', source);
  const preview = f.service.preview({ toolId: 'claude', providerId: p.id });
  assert.equal(fs.readFileSync(file, 'utf8'), source); assert.equal(fs.existsSync(f.backupDirectory), false);
  assert.equal(JSON.stringify(preview).includes('old-fixture-secret'), false); assert.equal(JSON.stringify(preview).includes(p.apiKey), false);
  assert.ok(preview.files[0].changes.some(change => change.secret && change.after === '******'));
  const applied = f.service.apply({ token: preview.token });
  const result = fs.readFileSync(file, 'utf8'); const parsed = jsonc.parse(result);
  assert.ok(result.includes('// keep this comment')); assert.equal(parsed.env.KEEP, 'stay');
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, p.apiKey); assert.deepEqual(parsed.permissions, { allow: ['Read'] });
  assert.equal(f.service.listBackups()[0].id, applied.backupId);
  const disk = fs.readFileSync(path.join(f.backupDirectory, `${applied.backupId}.json`), 'utf8');
  assert.equal(disk.includes('old-fixture-secret'), false);
});

test('Codex changes only managed config.toml fields and never reads or writes auth.json', (t) => {
  const f = fixture(t); const p = f.add('openai-responses', 'codex');
  const original = '# retain comment\nmodel = "old" # model note\napproval_policy = "on-request"\n\n[projects."/sample"]\ntrust_level = "trusted"\n';
  const file = f.write('.codex/config.toml', original); const auth = f.write('.codex/auth.json', 'not even valid JSON; never inspect');
  const preview = f.service.preview({ toolId: 'codex', providerId: p.id });
  assert.equal(preview.files.length, 1); f.service.apply({ token: preview.token });
  const output = fs.readFileSync(file, 'utf8'); const value = toml.parse(output);
  assert.ok(output.includes('# retain comment')); assert.ok(output.includes('# model note'));
  assert.equal(value.approval_policy, 'on-request'); assert.equal(value.projects['/sample'].trust_level, 'trusted');
  assert.equal(value.model, p.model); assert.equal(value.model_providers[value.model_provider].experimental_bearer_token, p.apiKey);
  assert.equal(value.model_providers[value.model_provider].wire_api, 'responses'); assert.equal(value.model_providers[value.model_provider].requires_openai_auth, false);
  assert.equal(fs.readFileSync(auth, 'utf8'), 'not even valid JSON; never inspect');
});

test('Gemini updates explicit API-key fields in two files without touching OAuth credential files', (t) => {
  const f = fixture(t); const p = f.add('gemini', 'gemini');
  const env = f.write('.gemini/.env', '# env comment\nOTHER=keep\nGEMINI_API_KEY=old-key\n');
  const settings = f.write('.gemini/settings.json', '{"theme":"dark","security":{"auth":{"selectedType":"oauth-personal"}}}\n');
  const oauth = f.write('.gemini/oauth_creds.json', 'leave untouched');
  const preview = f.service.preview({ toolId: 'gemini', providerId: p.id }); assert.equal(preview.files.length, 2);
  f.service.apply({ token: preview.token });
  assert.ok(fs.readFileSync(env, 'utf8').includes('# env comment\nOTHER=keep'));
  assert.ok(fs.readFileSync(env, 'utf8').includes(p.apiKey));
  const value = jsonc.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(value.security.auth.selectedType, 'gemini-api-key'); assert.equal(value.theme, 'dark');
  assert.equal(fs.readFileSync(oauth, 'utf8'), 'leave untouched');
});

test('OpenCode v1/v2 use separate native schema fields and preserve other providers', (t) => {
  for (const v2 of [false, true]) {
    const f = fixture(t); const p = f.add('openai-chat', 'opencode'); const key = v2 ? 'providers' : 'provider';
    const file = f.write('.config/opencode/opencode.jsonc', `{\n // keep\n "${key}": {"existing":{"name":"Keep"}}, "theme":"dark"\n}\n`);
    f.service.apply({ token: f.service.preview({ toolId: 'opencode', providerId: p.id }).token });
    const result = jsonc.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(result[key].existing.name, 'Keep'); assert.equal(result.theme, 'dark');
    const providerId = result.model.split('/')[0];
    assert.equal(result[key][providerId][v2 ? 'settings' : 'options'].apiKey, p.apiKey);
    assert.equal(result[key][providerId][v2 ? 'package' : 'npm'], '@ai-sdk/openai-compatible');
  }
});

test('one-use preview rejects file/provider change and expires without filesystem changes', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'claude'); const file = f.write('.claude/settings.json', '{}\n');
  let preview = f.service.preview({ toolId: 'claude', providerId: p.id });
  fs.writeFileSync(file, '{"external":true}');
  assert.throws(() => f.service.apply({ token: preview.token }), /变化/);
  assert.throws(() => f.service.apply({ token: preview.token }), /失效|不存在/);
  preview = f.service.preview({ toolId: 'claude', providerId: p.id }); f.providers.get(p.id).apiKey = 'changed-provider-key';
  assert.throws(() => f.service.apply({ token: preview.token }), /供应商.*变化/);
  preview = f.service.preview({ toolId: 'claude', providerId: p.id }); f.setClock(1000 + 6 * 60 * 1000);
  assert.throws(() => f.service.apply({ token: preview.token }), /过期|失效/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"external":true}');
});

test('backup restore has its own preview and conflict check, preserving exact original bytes', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'claude'); const original = Buffer.from('{\n  "keep": true\n}\n');
  const file = f.write('.claude/settings.json', original);
  const result = f.service.apply({ token: f.service.preview({ toolId: 'claude', providerId: p.id }).token });
  const fresh = createAiToolsConfig(f.options);
  const restore = fresh.previewRestore({ backupId: result.backupId });
  assert.notDeepEqual(fs.readFileSync(file), original);
  fresh.apply({ token: restore.token }); assert.deepEqual(fs.readFileSync(file), original);
});

test('unsupported tool/protocol, duplicate JSON keys, malformed TOML and ambiguous dotenv are rejected', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'claude');
  assert.throws(() => f.service.preview({ toolId: 'agy', providerId: p.id }), /尚未|不支持/);
  assert.throws(() => f.service.preview({ toolId: 'codex', providerId: p.id }), /协议|目标/);
  f.write('.claude/settings.json', '{"env":{},"env":{}}');
  assert.throws(() => f.service.preview({ toolId: 'claude', providerId: p.id }), /重复|格式/);
  const codex = f.add('openai-responses', 'codex'); f.write('.codex/config.toml', 'model = [');
  assert.throws(() => f.service.preview({ toolId: 'codex', providerId: codex.id }), /TOML|格式/);
  const gemini = f.add('gemini', 'gemini'); f.write('.gemini/.env', 'GEMINI_API_KEY=one\nGEMINI_API_KEY=two\n');
  assert.throws(() => f.service.preview({ toolId: 'gemini', providerId: gemini.id }), /重复|格式/);
});

test('multi-file failure compensates earlier writes and retains encrypted original backup', (t) => {
  let rejectSettings = false;
  const filesystem = Object.create(fs);
  filesystem.renameSync = (source, target) => {
    if (rejectSettings && target.endsWith('settings.json')) { rejectSettings = false; throw Object.assign(new Error('fixture fault'), { code: 'EIO' }); }
    return fs.renameSync(source, target);
  };
  const f = fixture(t, { filesystem }); const p = f.add('gemini', 'gemini');
  const env = f.write('.gemini/.env', 'OTHER=keep\n'); const settings = f.write('.gemini/settings.json', '{}\n');
  const preview = f.service.preview({ toolId: 'gemini', providerId: p.id }); rejectSettings = true;
  assert.throws(() => f.service.apply({ token: preview.token }), /失败|恢复/);
  assert.equal(fs.readFileSync(env, 'utf8'), 'OTHER=keep\n'); assert.equal(fs.readFileSync(settings, 'utf8'), '{}\n');
  assert.equal(f.service.listBackups().length, 1);
});

test('config or parent symlinks are rejected and explicit paths may not target login credential files', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'claude');
  const actual = path.join(f.root, 'elsewhere'); fs.mkdirSync(actual);
  fs.symlinkSync(actual, path.join(f.home, '.claude'), 'junction');
  assert.throws(() => f.service.preview({ toolId: 'claude', providerId: p.id }), /链接|目录/);
  assert.throws(() => createAiToolsConfig({ ...f.options, paths: { claude: path.join(f.home, 'auth.json') } }), /登录|路径/);
  assert.deepEqual(fs.readdirSync(actual), []);
});

test('restore removes only a newly created exact applied file and encryption failure leaves CLI untouched', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'claude');
  const applied = f.service.apply({ token: f.service.preview({ toolId: 'claude', providerId: p.id }).token });
  const file = path.join(f.home, '.claude/settings.json'); assert.equal(fs.existsSync(file), true);
  f.service.apply({ token: f.service.previewRestore({ backupId: applied.backupId }).token });
  assert.equal(fs.existsSync(file), false);
  const locked = createAiToolsConfig({ ...f.options, canEncrypt: () => false });
  assert.throws(() => locked.apply({ token: locked.preview({ toolId: 'claude', providerId: p.id }).token }), /加密/);
  assert.equal(fs.existsSync(file), false);
});

test('Codex preserves multiline unmanaged TOML values and no-newline input; active overriding profile is refused', (t) => {
  const f = fixture(t); const p = f.add('openai-responses', 'codex');
  const original = 'note = """\n[pretend]\nmodel = "must not edit this"\n"""\napproval_policy = "on-request"';
  const file = f.write('.codex/config.toml', original);
  f.service.apply({ token: f.service.preview({ toolId: 'codex', providerId: p.id }).token });
  assert.equal(toml.parse(fs.readFileSync(file, 'utf8')).note, toml.parse(original).note);
  fs.writeFileSync(file, 'profile="work"\n[profiles.work]\nmodel_provider="other"\n');
  assert.throws(() => f.service.preview({ toolId: 'codex', providerId: p.id }), /profile|配置档/);
});

test('Gemini does not modify a fake managed key embedded in an unrelated multiline dotenv string', (t) => {
  const f = fixture(t); const p = f.add('gemini', 'gemini');
  const keep = 'OTHER="multiple\nGEMINI_API_KEY=keep-this-literal\nlines"\n';
  const file = f.write('.gemini/.env', keep);
  f.service.apply({ token: f.service.preview({ toolId: 'gemini', providerId: p.id }).token });
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(keep));
});

test('rollback never overwrites a concurrent external edit and exposes the retained backup id', (t) => {
  let active = false; let envFile;
  const filesystem = Object.create(fs);
  filesystem.renameSync = (source, target) => {
    if (active && target.endsWith('settings.json')) {
      active = false; fs.writeFileSync(envFile, 'external-change-must-survive\n'); throw new Error('simulated second-write failure');
    }
    return fs.renameSync(source, target);
  };
  const f = fixture(t, { filesystem }); const p = f.add('gemini', 'gemini');
  envFile = f.write('.gemini/.env', 'ORIGINAL=yes\n'); f.write('.gemini/settings.json', '{}\n');
  const preview = f.service.preview({ toolId: 'gemini', providerId: p.id }); active = true;
  assert.throws(() => f.service.apply({ token: preview.token }), error => /外部变化/.test(error.message) && /^[a-f0-9-]{36}$/.test(error.backupId));
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'external-change-must-survive\n');
});

test('reapplying a managed Codex provider preserves custom fields in its own table', (t) => {
  const f = fixture(t); const p = f.add('openai-responses', 'codex');
  const file = f.write('.codex/config.toml', '');
  f.service.apply({ token: f.service.preview({ toolId: 'codex', providerId: p.id }).token });
  fs.appendFileSync(file, 'stream_max_retries = 4 # custom retained\n');
  f.providers.get(p.id).model = 'next-model';
  f.service.apply({ token: f.service.preview({ toolId: 'codex', providerId: p.id }).token });
  const value = toml.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(value.model, 'next-model'); assert.equal(value.model_providers[value.model_provider].stream_max_retries, 4);
  assert.match(fs.readFileSync(file, 'utf8'), /# custom retained/);
});

test('Grok Build writes its declared native model table, requires explicit context and preserves MCP/comments', (t) => {
  const f = fixture(t); const p = f.add('openai-responses', 'grokbuild');
  const original = '# grok original\n[models]\ndefault = "old"\n[model.old]\nmodel="old"\n[mcp_servers.fixture]\ncommand="keep"\n';
  const file = f.write('.grok/config.toml', original);
  assert.throws(() => f.service.preview({ toolId: 'grokbuild', providerId: p.id }), /上下文/);
  f.providers.get(p.id).contextWindow = 128000;
  const applied = f.service.apply({ token: f.service.preview({ toolId: 'grokbuild', providerId: p.id }).token });
  const value = toml.parse(fs.readFileSync(file, 'utf8')); const row = value.model[value.models.default];
  assert.equal(row.model, p.model); assert.equal(row.api_backend, 'responses'); assert.equal(row.context_window, 128000); assert.equal(row.api_key, p.apiKey);
  assert.equal(value.model.old.model, 'old'); assert.equal(value.mcp_servers.fixture.command, 'keep'); assert.match(fs.readFileSync(file, 'utf8'), /# grok original/);
  f.service.apply({ token: f.service.previewRestore({ backupId: applied.backupId }).token }); assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('Pi registers explicit models without touching settings/auth, preserves other entries and restores', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'pi');
  const original = '{\n // pi original\n "providers":{"existing":{"apiKey":"keep-other-provider","models":[{"id":"other"}]}},"custom":"keep"\n}\n';
  const file = f.write('.pi/agent/models.json', original);
  const settings = f.write('.pi/agent/settings.json', 'must-not-be-read'); const auth = f.write('.pi/agent/auth.json', 'must-not-be-read');
  const preview = f.service.preview({ toolId: 'pi', providerId: p.id }); assert.match(preview.warnings.join(' '), /Pi.*选择/);
  const applied = f.service.apply({ token: preview.token }); const value = jsonc.parse(fs.readFileSync(file, 'utf8'));
  const row = value.providers[`awb_${p.id.replaceAll('-', '')}`];
  assert.equal(row.api, 'anthropic-messages'); assert.equal(row.apiKey, p.apiKey); assert.equal(row.models[0].id, p.model);
  assert.equal(value.providers.existing.apiKey, 'keep-other-provider'); assert.equal(value.custom, 'keep');
  assert.equal(fs.readFileSync(settings, 'utf8'), 'must-not-be-read'); assert.equal(fs.readFileSync(auth, 'utf8'), 'must-not-be-read');
  f.service.apply({ token: f.service.previewRestore({ backupId: applied.backupId }).token }); assert.equal(fs.readFileSync(file, 'utf8'), original);
  f.providers.get(p.id).apiKey = '!echo must-not-be-executed';
  assert.throws(() => f.service.preview({ toolId: 'pi', providerId: p.id }), /命令|凭据/);
});

test('MCode merges YAML comments/native custom provider and leaves default/account selection untouched', (t) => {
  const f = fixture(t); const p = f.add('openai-chat', 'mcode');
  const original = '# mcode original\ndefaultModel: account/model\ncustom_provider:\n  account:\n    kind: account\n    options:\n      apiKey: preserve-account-reference\n';
  const file = f.write('.minimax/config.yaml', original);
  const preview = f.service.preview({ toolId: 'mcode', providerId: p.id }); const applied = f.service.apply({ token: preview.token });
  const result = fs.readFileSync(file, 'utf8'); const value = yaml.parse(result); const row = value.custom_provider[`awb_${p.id.replaceAll('-', '')}`];
  assert.match(result, /# mcode original/); assert.equal(value.defaultModel, 'account/model'); assert.equal(value.custom_provider.account.options.apiKey, 'preserve-account-reference');
  assert.equal(row.kind, 'custom'); assert.equal(row.api, 'openai-completions'); assert.equal(row.options.apiKey, p.apiKey); assert.equal(row.models[p.model].name, p.model);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  f.service.apply({ token: f.service.previewRestore({ backupId: applied.backupId }).token }); assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.mkdirSync(`${file}.lock`);
  assert.throws(() => f.service.apply({ token: f.service.preview({ toolId: 'mcode', providerId: p.id }).token }), /正在|占用|锁/);
  assert.equal(fs.existsSync(`${file}.lock`), true); assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('Kimi Code writes only managed native provider/model while preserving existing default, OAuth references and secondary models', (t) => {
  const f = fixture(t); const p = f.add('gemini', 'kimi'); f.providers.get(p.id).contextWindow = 1000000;
  const original = '# kimi original\ndefault_model="existing"\n[providers.account]\ntype="kimi"\n[providers.account.oauth]\nkey="preserve-reference"\n[models.existing]\nprovider="account"\nmodel="old"\nmax_context_size=128000\n[secondary_model]\ndefault_model="existing"\n';
  const file = f.write('.kimi-code/config.toml', original); const applied = f.service.apply({ token: f.service.preview({ toolId: 'kimi', providerId: p.id }).token });
  const value = toml.parse(fs.readFileSync(file, 'utf8')); const id = `awb_${p.id.replaceAll('-', '')}`;
  assert.equal(value.providers[id].type, 'google-genai'); assert.equal(value.providers[id].api_key, p.apiKey);
  assert.equal(value.models[id].provider, id); assert.equal(value.models[id].max_context_size, 1000000);
  assert.equal(value.default_model, 'existing'); assert.equal(value.secondary_model.default_model, 'existing'); assert.equal(value.providers.account.oauth.key, 'preserve-reference');
  f.service.apply({ token: f.service.previewRestore({ backupId: applied.backupId }).token }); assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('MCode account-owned targets and YAML aliases at managed paths are rejected without mutation', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'mcode'); const id = `awb_${p.id.replaceAll('-', '')}`;
  const file = f.write('.minimax/config.yaml', `custom_provider:\n  ${id}:\n    kind: account\n`);
  assert.throws(() => f.service.preview({ toolId: 'mcode', providerId: p.id }), /账号|account/);
  fs.writeFileSync(file, `shared: &shared\n  kind: custom\ncustom_provider:\n  ${id}: *shared\n`);
  assert.throws(() => f.service.preview({ toolId: 'mcode', providerId: p.id }), /引用|alias|别名/);
});

test('model IDs cannot mutate prototypes when mapped into native config objects', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'mcode');
  for (const model of ['__proto__', 'constructor', 'prototype']) {
    f.providers.get(p.id).model = model;
    assert.throws(() => f.service.preview({ toolId: 'mcode', providerId: p.id }), /保留字段/);
  }
  assert.equal(Object.prototype.name, undefined);
  assert.equal(fs.existsSync(path.join(f.home, '.minimax/config.yaml')), false);
});

test('Hermes uses injected Windows LocalAppData, preserves defaults/account dictionaries, and restores YAML', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'hermes');
  const file = path.join(f.options.localAppData, 'hermes/config.yaml'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = '# hermes keep\nmodel:\n  provider: existing\n  default: existing/model\nproviders:\n  account:\n    api_key: preserve-account\ncustom_providers:\n  - name: existing\n    base_url: https://existing.test\n';
  fs.writeFileSync(file, original);
  const preview = f.service.preview({ toolId: 'hermes', providerId: p.id }); assert.equal(preview.files[0].path, file);
  const applied = f.service.apply({ token: preview.token }); const value = yaml.parse(fs.readFileSync(file, 'utf8'));
  const row = value.custom_providers.find(item => item.name === `awb_${p.id.replaceAll('-', '')}`);
  assert.equal(row.api_mode, 'anthropic_messages'); assert.equal(row.api_key, p.apiKey); assert.equal(row.model, p.model);
  assert.equal(value.model.provider, 'existing'); assert.equal(value.providers.account.api_key, 'preserve-account');
  assert.match(fs.readFileSync(file, 'utf8'), /# hermes keep/);
  f.service.apply({ token: f.service.previewRestore({ backupId: applied.backupId }).token }); assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('OpenClaw supports actual JSON5 and preserves comments, single quotes, unquoted keys and unrelated fields', (t) => {
  const f = fixture(t); const p = f.add('openai-responses', 'openclaw');
  const original = "{\n // top stays exactly\n models: { mode: 'merge', providers: { existing: { apiKey: 'preserve', }, }, },\n agents: { defaults: { model: { primary: 'existing/model' } } },\n odd: [Infinity, NaN, 0x10], // still JSON5\n}\n";
  const file = f.write('.openclaw/openclaw.json', original); const applied = f.service.apply({ token: f.service.preview({ toolId: 'openclaw', providerId: p.id }).token });
  const text = fs.readFileSync(file, 'utf8'); const value = JSON5.parse(text); const row = value.models.providers[`awb_${p.id.replaceAll('-', '')}`];
  assert.equal(row.api, 'openai-responses'); assert.equal(row.apiKey, p.apiKey); assert.equal(row.models[0].id, p.model);
  assert.equal(value.models.providers.existing.apiKey, 'preserve'); assert.equal(value.agents.defaults.model.primary, 'existing/model');
  assert.ok(text.includes("// top stays exactly")); assert.ok(text.includes("odd: [Infinity, NaN, 0x10], // still JSON5")); assert.ok(text.includes("mode: 'merge'"));
  f.service.apply({ token: f.service.previewRestore({ backupId: applied.backupId }).token }); assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.writeFileSync(file, '{models:{},models:{}}'); assert.throws(() => f.service.preview({ toolId: 'openclaw', providerId: p.id }), /重复/);
});

test('Claude Desktop preview covers four exact local files, safe gateway only, preserving deployment policies and unrelated profiles', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'claude-desktop'); f.providers.get(p.id).model = 'claude-sonnet-5';
  const normal = path.join(f.options.localAppData, 'Claude/claude_desktop_config.json');
  const third = path.join(f.options.localAppData, 'Claude-3p/claude_desktop_config.json');
  const meta = path.join(f.options.localAppData, 'Claude-3p/configLibrary/_meta.json');
  for (const file of [normal, third, meta]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(normal, '{"deploymentMode":"1p","mcpServers":{"keep":{}}}\n');
  fs.writeFileSync(third, '{"deploymentMode":"1p","theme":"keep"}\n');
  fs.writeFileSync(meta, '{"appliedId":"other","entries":[{"id":"other","name":"Keep"}]}\n');
  const preview = f.service.preview({ toolId: 'claude-desktop', providerId: p.id }); assert.equal(preview.files.length, 4);
  const applied = f.service.apply({ token: preview.token });
  const metadata = jsonc.parse(fs.readFileSync(meta, 'utf8')); const profileFile = path.join(path.dirname(meta), `${metadata.appliedId}.json`); const profile = jsonc.parse(fs.readFileSync(profileFile, 'utf8'));
  assert.notEqual(metadata.appliedId, '00000000-0000-4000-8000-000000157210');
  assert.equal(profile.inferenceGatewayApiKey, p.apiKey); assert.equal(profile.inferenceProvider, 'gateway');
  assert.deepEqual(profile.inferenceModels, ['claude-sonnet-5']); assert.equal(profile.coworkEgressAllowedHosts, undefined);
  assert.equal(jsonc.parse(fs.readFileSync(normal, 'utf8')).deploymentMode, '3p'); assert.deepEqual(metadata.entries[0], { id: 'other', name: 'Keep' });
  f.service.apply({ token: f.service.previewRestore({ backupId: applied.backupId }).token });
  assert.equal(jsonc.parse(fs.readFileSync(normal, 'utf8')).deploymentMode, '1p'); assert.equal(fs.existsSync(profileFile), false);
});

test('Claude Desktop four-file write failure rolls all earlier files back and rejects arbitrary model IDs', (t) => {
  let rejectMeta = false; const filesystem = Object.create(fs);
  filesystem.renameSync = (source, target) => { if (rejectMeta && target.endsWith('_meta.json')) { rejectMeta = false; throw new Error('fixture'); } return fs.renameSync(source, target); };
  const f = fixture(t, { filesystem }); const p = f.add('anthropic', 'claude-desktop');
  assert.throws(() => f.service.preview({ toolId: 'claude-desktop', providerId: p.id }), /Claude|模型/);
  f.providers.get(p.id).model = 'claude-haiku-4-5';
  const preview = f.service.preview({ toolId: 'claude-desktop', providerId: p.id }); rejectMeta = true;
  assert.throws(() => f.service.apply({ token: preview.token }), /失败/);
  assert.ok(preview.files.every(file => !fs.existsSync(file.path)));
  assert.equal(f.service.listBackups().length, 1);
});

test('OpenClaw range edits handle escaped keys/comments/delimiters without evaluating source', (t) => {
  const f = fixture(t); const p = f.add('gemini', 'openclaw');
  const id = `awb_${p.id.replaceAll('-', '')}`;
  const original = `{ 'models': { providers: { '${id}': {apiKey:'old', models:[], unknown: 'keep } // /* \\' delimiter', special: NaN} /* retained trailing comment */ } }, '非ASCII': 'literal', n:+Infinity }`;
  const file = f.write('.openclaw/openclaw.json', original);
  const originalValue = JSON5.parse(original);
  f.service.apply({ token: f.service.preview({ toolId: 'openclaw', providerId: p.id }).token });
  const current = JSON5.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(current.models.providers[id].unknown, originalValue.models.providers[id].unknown);
  assert.ok(Number.isNaN(current.models.providers[id].special)); assert.equal(current.n, Infinity);
  assert.ok(fs.readFileSync(file, 'utf8').includes('/* retained trailing comment */'));
  fs.writeFileSync(file, '{models: {providers: getSecret()}}');
  assert.throws(() => f.service.preview({ toolId: 'openclaw', providerId: p.id }), /JSON5/);
});

test('Desktop refuses pre-existing unowned profile and preserves unrelated safe policy values on reapply', (t) => {
  const f = fixture(t); const p = f.add('anthropic', 'claude-desktop'); f.providers.get(p.id).model = 'claude-sonnet-5';
  let preview = f.service.preview({ toolId: 'claude-desktop', providerId: p.id });
  const profileFile = preview.files.find(row => /f56ec0a3/.test(row.path)).path;
  fs.mkdirSync(path.dirname(profileFile), { recursive: true }); fs.writeFileSync(profileFile, '{"other":"keep"}');
  assert.throws(() => f.service.preview({ toolId: 'claude-desktop', providerId: p.id }), /属于|占用/);
  assert.equal(fs.readFileSync(profileFile, 'utf8'), '{"other":"keep"}');
  fs.unlinkSync(profileFile);
  preview = f.service.preview({ toolId: 'claude-desktop', providerId: p.id }); f.service.apply({ token: preview.token });
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8')); profile.coworkEgressAllowedHosts = ['safe.example.test']; profile.disableDeploymentModeChooser = false;
  fs.writeFileSync(profileFile, JSON.stringify(profile));
  f.service.apply({ token: f.service.preview({ toolId: 'claude-desktop', providerId: p.id }).token });
  assert.deepEqual(JSON.parse(fs.readFileSync(profileFile, 'utf8')).coworkEgressAllowedHosts, ['safe.example.test']);
  assert.equal(JSON.parse(fs.readFileSync(profileFile, 'utf8')).disableDeploymentModeChooser, false);
});
