import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from '@babel/parser';
import { tr } from '../src/shared/i18n.js';

const file = new URL('../src/components/ai-tools/AiPortablePanel.jsx', import.meta.url);
const source = fs.readFileSync(file, 'utf8');
const ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
function pure(name) {
  const node = ast.program.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name);
  assert.ok(node, `missing ${name}`);
  return vm.runInNewContext(`(${source.slice(node.start, node.end)})`, { TextEncoder, Date, tr });
}

test('portable password validation uses UTF-8 byte limits and requires exact confirmation only on export', () => {
  const validate = pure('passwordProblem');
  assert.match(validate('short', 'short', 'export'), /8/);
  assert.match(validate('password-123', 'different', 'export'), /一致/);
  assert.equal(validate('password-123', '', 'import'), '');
  assert.equal(validate('中文密码', '中文密码', 'export'), '');
  assert.match(validate('x'.repeat(1025), '', 'import'), /1024/);
});

test('portable preview validation refuses missing/negative/noninteger counts and expired tokens', () => {
  const validate = pure('previewProblem');
  const preview = { token: 'fixture-token', expiresAt: Date.now() + 60000, counts: { providers: { added: 1, skipped: 0 }, mcpServers: { added: 2, skipped: 1 }, prompts: { added: 0, skipped: 0 } } };
  assert.equal(validate(preview, 'import'), '');
  assert.match(validate({ ...preview, expiresAt: 1 }, 'import'), /过期/);
  assert.match(validate({ ...preview, counts: {} }, 'import'), /格式/);
  assert.match(validate({ ...preview, warnings: 'malformed' }, 'import'), /格式/);
  assert.match(validate({ ...preview, counts: { ...preview.counts, providers: { added: -1, skipped: 0 } } }, 'import'), /格式/);
  assert.equal(validate({ token: 'recovery', expiresAt: Date.now() + 60000, counts: { restore: 1, unchanged: 1 } }, 'recovery'), '');
  assert.match(validate({ token: 'recovery', expiresAt: Date.now() + 60000, counts: { restore: 100, unchanged: 1 } }, 'recovery'), /格式/);
});

test('migration UI declares scope and never persists passwords or accepts renderer file paths', () => {
  assert.match(source, /供应商、MCP 和提示词/);
  assert.match(source, /不包含.*登录.*会员/);
  assert.match(source, /不会自动上传/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|console\./);
  assert.doesNotMatch(source, /type="file"|<select[\s>]/);
  assert.match(source, /type="password"/);
  assert.match(source, /setPassword\(''\)/);
  assert.match(source, /onRequest\(.*\{ password: secret \}/);
  assert.match(source, /portable_recovery_apply/);
  assert.match(source, /recoveryOnly = false/);
  assert.match(source, /!recoveryOnly &&/);
  assert.match(source, /await onImported\?\.\(\)/);
});
