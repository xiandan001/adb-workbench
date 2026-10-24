const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { auditSource, identity, placeholders, loadCatalog, auditHtml, auditJson } = require('../scripts/i18n-audit.cjs');
const catalog = new Map([['保存', 'Save'], ['共 {0} 项', '{0} items']]);
const audit = (source, exclusions = []) => auditSource({ file: 'src/Fixture.jsx', source, catalog, exclusions });

test('new hardcoded Chinese and English UI text fails with source locations', () => {
  for (const source of ['const A = () => <button>新增按钮</button>;', 'const A = () => <input placeholder="New field" />;', 'const A = () => <span>New label</span>;', 'const A = () => <button title="新增提示" />;', 'const options = [{label: "New option"}];', 'document.title = "New window";']) {
    const result = audit(source);
    assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].kind, 'unlocalized-literal');
    assert.equal(result.diagnostics[0].file, 'src/Fixture.jsx'); assert.equal(result.diagnostics[0].line, 1);
  }
});

test('registered translated text passes and a missing key fails', () => {
  assert.deepEqual(audit("const A = () => <button>{tr('保存')}</button>;").diagnostics, []);
  assert.equal(audit("tr('词典没有的文案')").diagnostics[0].kind, 'missing-translation');
  assert.equal(audit('tr(`共 ${count} 项`)').diagnostics[0].kind, 'dynamic-key');
  assert.deepEqual(audit("tr('共 {0} 项', {0: count})").diagnostics, []);
});

test('user data and protocol identifiers are not treated as displayed application text', () => {
  assert.deepEqual(audit('const A = ({log}) => <pre>{log}</pre>; const x = {"字段": value}; console.warn("开发日志");').diagnostics, []);
});

test('reviewed exclusions are exact and cannot hide later text changes', () => {
  const exclusion = { file: 'src/Fixture.jsx', id: identity('src/Fixture.jsx', 'unlocalized-literal', '产品品牌'), kind: 'brand', reason: 'A fixed product brand, not a translated interface label.' };
  assert.deepEqual(audit('const A = () => <h1>产品品牌</h1>', [exclusion]).diagnostics, []);
  assert.equal(audit('const A = () => <h1>新的产品介绍</h1>', [exclusion]).diagnostics.length, 1);
});

test('placeholder comparison allows reordering but not a missing parameter', () => {
  assert.equal(placeholders('{0} + {1}'), placeholders('{1} then {0}'));
  assert.notEqual(placeholders('{0} + {1}'), placeholders('{0}'));
});

test('fixed Chinese display locale is rejected', () => {
  assert.equal(audit("new Date().toLocaleString('zh-CN')").diagnostics[0].kind, 'fixed-locale');
  assert.deepEqual(audit('new Date().toLocaleString(getLocale())').diagnostics, []);
});

test('the actual build gate exits nonzero for new unlocalized text and invalid catalogs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-i18n-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const directory = path.join(root, 'electron/locales'); fs.mkdirSync(directory, { recursive: true });
  for (const name of ['core', 'workspace', 'tools', 'backend']) fs.writeFileSync(path.join(directory, `en-${name}.json`), JSON.stringify(name === 'core' ? { 保存: 'Save' } : {}));
  const source = path.join(root, 'src/Fixture.jsx');
  const command = () => cp.spawnSync(process.execPath, [path.resolve('scripts/check-i18n.cjs'), '--root', root], { encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(source, "const Button = () => <button>{tr('保存')}</button>;");
  assert.equal(command().status, 0);
  fs.writeFileSync(source, 'const Button = () => <button>新增文本没有多语言</button>;');
  const failed = command(); assert.equal(failed.status, 1); assert.match(failed.stderr, /src\/Fixture\.jsx:1/);
  fs.writeFileSync(source, "tr('共 {0} 项', {0: 3});");
  fs.writeFileSync(path.join(directory, 'en-core.json'), JSON.stringify({ '共 {0} 项': 'Items', 保存: '' }));
  const broken = loadCatalog(directory);
  assert.ok(broken.diagnostics.some(item => item.kind === 'placeholders'));
  assert.ok(broken.diagnostics.some(item => item.kind === 'empty-translation'));
  assert.equal(command().status, 1);
});

test('startup markup and built-in JSON cannot introduce uncatalogued copy', () => {
  assert.equal(auditHtml({ file: 'index.html', source: '<p>New startup message</p>', catalog }).length, 1);
  assert.equal(auditHtml({ file: 'index.html', source: '<p data-i18n="保存">保存</p>', catalog }).length, 0);
  assert.equal(auditHtml({ file: 'index.html', source: '<p data-i18n="新增">新增</p>', catalog }).length, 1);
  assert.equal(auditJson({ file: 'spec.json', source: JSON.stringify({ label: '新标签', command: 'echo 原始命令' }), catalog }).length, 1);
  assert.equal(auditJson({ file: 'spec.json', source: JSON.stringify({ label: '保存', command: 'echo 原始命令' }), catalog }).length, 0);
});
