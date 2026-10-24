import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from '@babel/parser';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import traverseModule from '@babel/traverse';
import catalog from '../electron/locales/en-tools.json' with { type: 'json' };
import fields from '../electron/assets/ai-cli-config-fields.json' with { type: 'json' };
import { tr, setLanguage } from '../src/shared/i18n.js';
import { providerDraft, providerInput, quotaMetricText } from '../src/components/ai-tools/aiToolsModel.js';
import { promptInput, mcpDraft, mcpInput } from '../src/components/ai-tools/aiResourcesModel.js';
import { AI_PROVIDER_PRESETS, applyProviderPreset } from '../src/components/ai-tools/aiProviderPresets.js';
import { CLAUDE_MODEL_ROLES } from '../src/components/ai-tools/aiClaudeModelsModel.js';
import { cliConfigInput } from '../src/components/ai-tools/aiCliConfigModel.js';

const traverse = traverseModule.default;
const root = new URL('../', import.meta.url);
const source = file => readFileSync(new URL(file, root), 'utf8');
const placeholders = text => [...text.matchAll(/\{(\d+)\}/g)].map(match => match[1]).sort();

test('every tools and SSH literal translation has an English entry with identical interpolation slots', () => {
  let count = 0;
  for (const directory of ['src/components/ai-tools/', 'src/components/ssh/']) {
    for (const file of readdirSync(new URL(directory, root)).filter(name => /\.(?:js|jsx)$/.test(name))) {
      const text = source(directory + file);
      assert.equal(text.includes('\r'), false, file);
      traverse(parse(text, { sourceType: 'module', plugins: ['jsx'] }), {
        CallExpression(path) {
          const node = path.node;
          if (node.callee.name !== 'tr' || node.arguments[0]?.type !== 'StringLiteral') return;
          const key = node.arguments[0].value;
          assert.equal(typeof catalog[key], 'string', `${file}: ${key}`);
          assert.deepEqual(placeholders(catalog[key]), placeholders(key), key);
          assert.equal(/[\u3400-\u9fff]/u.test(catalog[key]), false, key);
          count++;
        },
      });
    }
  }
  assert.ok(count > 1000);
});

test('canonical CLI and provider descriptors are translated at consumption without mutating configuration data', () => {
  for (const descriptor of Object.values(fields).flat()) {
    assert.ok(catalog[descriptor.label], descriptor.label);
    if (descriptor.hint) assert.ok(catalog[descriptor.hint], descriptor.hint);
    if (descriptor.type === 'integer') assert.ok(catalog[`${descriptor.label}需要 {0}–{1} 的整数`], descriptor.key);
  }
  for (const preset of AI_PROVIDER_PRESETS.filter(row => /[\u3400-\u9fff]/u.test(row.label))) assert.ok(catalog[preset.label]);
  for (const role of CLAUDE_MODEL_ROLES.filter(row => row.description)) assert.ok(catalog[role.description]);
  assert.match(source('src/components/ai-tools/AiProviderForm.jsx'), /label: tr\(item\.label\)/);
  assert.match(source('src/components/ai-tools/AiCliConfigEditor.jsx'), /const label = tr\(descriptor\.label\)/);
  assert.match(source('src/components/ai-tools/AiClaudeModelsEditor.jsx'), /tr\(role\.description\)/);
});

test('locale switching changes new and retained app errors but never rewrites provider, prompt or command data', async () => {
  const saved = { id: 'fixture', name: '保存', protocol: 'anthropic', baseUrl: 'https://fixture.invalid', model: '模型-raw', targetApps: ['claude'] };
  await setLanguage('zh-CN');
  const before = providerInput(providerDraft(saved), saved);
  const prompt = { name: '取消', description: '刷新', content: '保存\n原始提示词' };
  const mcp = { name: '关闭', type: 'stdio', command: '打印-原始命令', args: ['取消', '保存'] };
  const presetBefore = applyProviderPreset(providerDraft(), 'zhipu-claude');
  try {
    await setLanguage('en-US');
    assert.deepEqual(providerInput(providerDraft(saved), saved), before);
    assert.deepEqual(promptInput(prompt), prompt);
    assert.equal(mcpInput(mcpDraft(mcp)).command, mcp.command);
    assert.deepEqual(mcpInput(mcpDraft(mcp)).args, mcp.args);
    assert.equal(applyProviderPreset(providerDraft(), 'zhipu-claude').name, presetBefore.name);
    assert.throws(() => providerInput({ ...providerDraft(saved), name: '' }), /provider name/i);
    let retainedFieldError;
    try { cliConfigInput({ claude: { timeoutMs: '-1' } }); } catch (error) { retainedFieldError = error.message; }
    assert.match(retainedFieldError, /Request timeout/);
    assert.equal(tr('已连接'), catalog['已连接']);
    assert.equal(quotaMetricText({ quota: { adapter: 'custom' } }, '余额'), '余额');
    assert.equal(quotaMetricText({ quota: { adapter: 'zhipu' } }, '余额'), catalog['余额']);
    const retained = tr('默认模型：{0}', { 0: saved.model });
    assert.ok(retained.includes(saved.model));
    await setLanguage('zh-CN');
    assert.equal(tr(retained), `默认模型：${saved.model}`);
    assert.equal(tr(retainedFieldError), '请求超时（毫秒）需要 0–2147483647 的整数');
  } finally { await setLanguage('zh-CN'); }
});

test('language changes update terminal accessibility but cannot recreate terminal transport or request identity', () => {
  const terminal = source('src/components/ssh/SshTerminal.jsx');
  let creation = 0;
  traverse(parse(terminal, { sourceType: 'module', plugins: ['jsx'] }), {
    CallExpression(path) {
      if (path.node.callee.name !== 'useEffect') return;
      const body = terminal.slice(path.node.arguments[0].start, path.node.arguments[0].end);
      if (!body.includes('new Terminal(')) return;
      creation++;
      assert.equal(terminal.slice(path.node.arguments[1].start, path.node.arguments[1].end), '[session.id, terminal.id]');
    },
  });
  assert.equal(creation, 1);
  assert.match(terminal, /termRef\.current\?\.textarea\?\.setAttribute\('aria-label', tr\('SSH 终端输入'\)\);\s*\}, \[locale\]\)/);
  const home = source('src/components/ai-tools/AiProviderHome.jsx');
  assert.match(home, /const context = useMemo\(\(\) => \(\{ active, ready, key \}\), \[active, ready, key\]\)/);
  for (const file of ['SshTerminal.jsx', 'SshEditorTabs.jsx', 'SshFileTree.jsx', 'SshHistoryPanel.jsx']) {
    assert.doesNotMatch(source(`src/components/ssh/${file}`), /tr\((?:document\.(?:content|path)|item\.(?:name|path)|entry\.command)\)/);
  }
});

test('real session-generated terminal titles relocalize without changing session identity or user names', async () => {
  const require = createRequire(import.meta.url);
  const native = require('../electron/lib/localization.cjs');
  const { createSshSessionService } = require('../electron/lib/ssh-session.cjs');
  class Channel extends EventEmitter {
    constructor() { super(); this.stderr = new EventEmitter(); }
    setWindow() {}
    end() { this.close(); }
    close() { if (!this.closed) { this.closed = true; queueMicrotask(() => this.emit('close')); } }
    destroy() { this.close(); }
  }
  class Client extends EventEmitter {
    connect(options) { queueMicrotask(() => options.hostVerifier(Buffer.from([0, 0, 0, 1, 65]), accepted => { if (accepted) this.emit('ready'); })); }
    shell(_options, callback) { queueMicrotask(() => callback(null, new Channel())); }
    end() { this.destroy(); }
    destroy() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  }
  const service = createSshSessionService({ createClient: () => new Client(), resolveProfile: async () => ({ name: '终端 1', host: 'fixture.invalid', port: 22, username: 'fixture' }), verifyHostKey: async () => true, closeTimeoutMs: 20 });
  try {
    native.setLocale('zh-CN'); await setLanguage('zh-CN');
    const connected = await service.connect(); const first = service.snapshot().sessions[0].terminals[0];
    assert.equal(first.title, '终端 1');
    await setLanguage('en-US'); assert.equal(tr(first.title), 'Terminal 1');
    native.setLocale('en-US'); await service.openTerminal({ sessionId: connected.sessionId });
    const second = service.snapshot().sessions[0].terminals[1]; assert.equal(second.title, 'Terminal 2');
    await setLanguage('zh-CN'); assert.equal(tr(second.title), '终端 2');
    const saved = service.snapshot().sessions[0]; assert.equal(saved.id, connected.sessionId); assert.equal(saved.name, '终端 1'); assert.equal(saved.terminals[0].title, first.title);
    assert.match(source('src/components/ssh/SshSessionWorkspace.jsx'), /tr\(item\.title\) \|\| tr\("终端"\)/);
    assert.match(source('src/components/ssh/SshTerminal.jsx'), /0: tr\(terminal\.title\) \|\| terminal\.id/);
  } finally { await service.dispose(); native.setLocale('zh-CN'); await setLanguage('zh-CN'); }
});
