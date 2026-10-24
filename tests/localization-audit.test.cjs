const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { auditSource, identity, placeholders, loadCatalog, auditHtml, auditJson } = require('../scripts/i18n-audit.cjs');
const catalog = new Map([['保存', 'Save'], ['共 {0} 项', '{0} items']]);
const audit = (source, exclusions = []) => auditSource({ file: 'src/Fixture.jsx', source, catalog, exclusions });
const domains = ['core', 'workspace', 'tools', 'backend'];
const translations = {
  en: { 保存: 'Save', '共 {0} 项': '{0} items' },
  tw: { 保存: '儲存', '共 {0} 项': '共 {0} 項' },
  ja: { 保存: '保存', '共 {0} 项': '{0} 件' },
  ko: { 保存: '저장', '共 {0} 项': '{0}개 항목' },
};
const localeNames = { en: 'en-US', tw: 'zh-TW', ja: 'ja-JP', ko: 'ko-KR' };
function catalogsFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-i18n-gate-'));
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const directory = path.join(root, 'electron/locales'); fs.mkdirSync(directory, { recursive: true });
  const write = (prefix, domain, entries) => fs.writeFileSync(path.join(directory, `${prefix}-${domain}.json`), JSON.stringify(entries));
  for (const prefix of Object.keys(translations)) for (const domain of domains) write(prefix, domain, domain === 'core' ? translations[prefix] : {});
  const command = () => cp.spawnSync(process.execPath, [path.resolve('scripts/check-i18n.cjs'), '--root', root], { encoding: 'utf8', windowsHide: true });
  return { root, directory, write, command };
}

test('new hardcoded Chinese, English, Japanese and Korean UI text fails with source locations', () => {
  for (const source of ['const A = () => <button>新增按钮</button>;', 'const A = () => <input placeholder="New field" />;', 'const A = () => <span>New label</span>;', 'const A = () => <button title="新增提示" />;', 'const options = [{label: "New option"}];', 'document.title = "New window";', 'const A = () => <button>キャンセル</button>;', 'const A = () => <input placeholder="새 항목" />;']) {
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

test('placeholder comparison allows reordering but rejects missing or repeated parameters', () => {
  assert.equal(placeholders('{0} + {1}'), placeholders('{1} then {0}'));
  assert.notEqual(placeholders('{0} + {1}'), placeholders('{0}'));
  assert.notEqual(placeholders('{0} + {0}'), placeholders('{0}'));
});

test('all five fixed display locales are rejected without treating locale identifiers as UI copy', () => {
  for (const locale of ['zh-CN', ...Object.values(localeNames)]) for (const source of [
    `new Date().toLocaleString('${locale}')`, `new Intl.DateTimeFormat('${locale}')`, `Intl.NumberFormat('${locale}')`,
  ]) assert.ok(audit(source).diagnostics.some(item => item.kind === 'fixed-locale'), source);
  assert.deepEqual(audit('new Date().toLocaleString(getLocale())').diagnostics, []);
  assert.deepEqual(audit("const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'];").diagnostics, []);
});

test('the actual build gate exits nonzero for new unlocalized text and invalid catalogs', t => {
  const { root, directory, command } = catalogsFixture(t);
  const source = path.join(root, 'src/Fixture.jsx');
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

test('all sixteen domain catalogs are required and every target language has the same domain keys', t => {
  const f = catalogsFixture(t);
  assert.deepEqual(loadCatalog(f.directory).diagnostics, []);
  for (const prefix of Object.keys(translations)) {
    f.write(prefix, 'core', { 保存: translations[prefix].保存 });
    const result = loadCatalog(f.directory);
    assert.ok(result.diagnostics.some(item => item.kind === 'missing-translation' && item.locale === localeNames[prefix] && item.source === '共 {0} 项'), prefix);
    assert.equal(f.command().status, 1, prefix);
    f.write(prefix, 'core', translations[prefix]);
  }
  fs.unlinkSync(path.join(f.directory, 'ko-backend.json'));
  assert.ok(loadCatalog(f.directory).diagnostics.some(item => item.kind === 'catalog' && item.locale === 'ko-KR'));
  assert.equal(f.command().status, 1);
});

test('another language or domain cannot conceal a missing translation', t => {
  const f = catalogsFixture(t);
  f.write('tw', 'core', {}); f.write('tw', 'workspace', translations.tw);
  const result = loadCatalog(f.directory);
  assert.ok(result.diagnostics.some(item => item.kind === 'missing-translation' && item.file.endsWith('tw-core.json') && item.source === '保存'));
  assert.equal(f.command().status, 1);
});

test('every target language rejects blank, non-text and mismatched placeholder values', t => {
  const f = catalogsFixture(t);
  for (const prefix of Object.keys(translations)) {
    for (const value of ['', '   ', null, { fallback: 'Save' }]) {
      f.write(prefix, 'core', { ...translations[prefix], 保存: value });
      assert.ok(loadCatalog(f.directory).diagnostics.some(item => item.kind === 'empty-translation' && item.locale === localeNames[prefix]), `${prefix}: ${JSON.stringify(value)}`);
    }
    f.write(prefix, 'core', { ...translations[prefix], '共 {0} 项': 'No argument' });
    assert.ok(loadCatalog(f.directory).diagnostics.some(item => item.kind === 'placeholders' && item.locale === localeNames[prefix]));
    assert.equal(f.command().status, 1);
    f.write(prefix, 'core', translations[prefix]);
  }
});

test('catalog roots and duplicate JSON keys fail closed while metadata is not a translation catalog', t => {
  const f = catalogsFixture(t);
  fs.writeFileSync(path.join(f.directory, 'locale-config.json'), JSON.stringify({ supportedLocales: ['zh-CN', ...Object.values(localeNames)] }));
  assert.equal(f.command().status, 0);
  for (const content of ['null', '[]', '"not a catalog"', '{"保存":"First","保存":"Second"}']) {
    fs.writeFileSync(path.join(f.directory, 'en-core.json'), content);
    assert.ok(loadCatalog(f.directory).diagnostics.some(item => item.kind === 'catalog'));
    assert.equal(f.command().status, 1);
  }
});

test('autonyms are allowed only as exact self-names, not as a general untranslated-text escape', t => {
  const f = catalogsFixture(t);
  const autonyms = Object.fromEntries(['简体中文', '繁體中文', 'English', '日本語', '한국어'].map(name => [name, name]));
  for (const prefix of Object.keys(translations)) for (const domain of domains) f.write(prefix, domain, { ...(domain === 'core' ? translations[prefix] : {}), ...autonyms });
  assert.deepEqual(loadCatalog(f.directory).diagnostics, []);
  f.write('en', 'core', { ...translations.en, ...autonyms, '普通按钮': '请使用日本語' });
  assert.ok(loadCatalog(f.directory).diagnostics.some(item => item.kind === 'untranslated-catalog'));
  const file = 'src/components/LanguagePreferences.jsx';
  for (const label of Object.keys(autonyms)) {
    const source = `const options = [{label: ${JSON.stringify(label)}}];`;
    assert.ok(auditSource({ file, source, catalog }).diagnostics.length, label);
    const exclusions = [{ file, id: identity(file, 'unlocalized-literal', label), kind: 'raw', reason: 'This exact language selector option is intentionally a native-language self-name.' }];
    assert.deepEqual(auditSource({ file, source, catalog, exclusions }).diagnostics, []);
    assert.ok(auditSource({ file: 'src/Other.jsx', source, catalog, exclusions }).diagnostics.length);
  }
});

test('the old visible brand has no automatic or brand-exclusion bypass; machine identifiers remain exact', () => {
  const oldBrand = { file: 'src/Fixture.jsx', id: identity('src/Fixture.jsx', 'unlocalized-literal', '卓控台'), kind: 'brand', reason: 'An old brand exclusion must not bypass the new display-brand requirement.' };
  assert.equal(audit('const A = () => <h1>卓控台</h1>', [oldBrand]).diagnostics.length, 1);
  assert.equal(auditHtml({ file: 'index.html', source: '<h1>卓控台</h1>', catalog }).length, 1);
  const markupBrand = { ...oldBrand, file: 'index.html', id: identity('index.html', 'unlocalized-markup', '卓控台') };
  assert.equal(auditHtml({ file: 'index.html', source: '<h1>卓控台</h1>', catalog, exclusions: [markupBrand] }).length, 1);
  const exact = { ...oldBrand, kind: 'machine', reason: 'Existing Windows startup ownership identifier; changing it would orphan the registration.' };
  assert.deepEqual(audit('const startupOwner = "卓控台";', [exact]).diagnostics, []);
});

test('English catalogs no longer silently permit the old visible product brand', t => {
  const f = catalogsFixture(t);
  f.write('en', 'core', { ...translations.en, 保存: '保存到卓控台' });
  assert.ok(loadCatalog(f.directory).diagnostics.some(item => item.kind === 'untranslated-catalog'));
  f.write('en', 'core', { ...translations.en, 保存: '卓控台' });
  assert.ok(loadCatalog(f.directory).diagnostics.some(item => item.kind === 'untranslated-catalog'));
});

test('Japanese and Korean ordinary messages cannot masquerade as translated English or Chinese fallback', t => {
  const f = catalogsFixture(t);
  for (const prefix of ['ja', 'ko']) {
    f.write(prefix, 'core', { ...translations[prefix], 保存: 'Save changes' });
    assert.ok(loadCatalog(f.directory).diagnostics.some(item => item.kind === 'untranslated-catalog' && item.locale === localeNames[prefix]));
    assert.equal(f.command().status, 1);
    f.write(prefix, 'core', translations[prefix]);
  }
  f.write('ko', 'core', { ...translations.ko, 保存: '保存' });
  assert.ok(loadCatalog(f.directory).diagnostics.some(item => item.kind === 'untranslated-catalog' && item.locale === 'ko-KR'));
});

test('ordinary English source keys also require real Japanese and Korean translations', t => {
  const f = catalogsFixture(t);
  for (const prefix of Object.keys(translations)) f.write(prefix, 'core', { ...translations[prefix], 'Save current session': 'Save current session' });
  const errors = loadCatalog(f.directory).diagnostics;
  for (const locale of ['ja-JP', 'ko-KR']) assert.ok(errors.some(item => item.kind === 'untranslated-catalog' && item.locale === locale && item.source === 'Save current session'));
  assert.equal(f.command().status, 1);
  for (const prefix of Object.keys(translations)) f.write(prefix, 'core', { ...translations[prefix], 'MCP:': 'MCP:', 'ANR ×': 'ANR ×', 'OOM ×': 'OOM ×' });
  assert.deepEqual(loadCatalog(f.directory).diagnostics, []);
});

test('legacy exact internal exclusions remain compatible without restoring the old brand exemption', () => {
  const file = 'src/Example.jsx';
  const exclusions = [{ file, id: identity(file, 'unlocalized-literal', 'internal failure'), reason: 'Internal failure is caught and replaced with a translated application message.' }];
  assert.deepEqual(auditSource({ file, source: "throw new Error('internal failure');", catalog, exclusions }).diagnostics, []);
  const oldBrand = [{ file, id: identity(file, 'unlocalized-literal', '卓控台'), reason: 'Fixed product brand/logo, identical in both supported languages.' }];
  assert.ok(auditSource({ file, source: '<h1>卓控台</h1>', catalog, exclusions: oldBrand }).diagnostics.length);
});

test('startup inline values are accepted only in two exact files and only when equal to their locale catalog', () => {
  const catalogs = new Map(Object.entries(localeNames).map(([prefix, locale]) => [locale, new Map(Object.entries(translations[prefix]))]));
  const table = 'const messagesByLocale = ' + JSON.stringify(Object.fromEntries([...catalogs].map(([locale, values]) => [locale, Object.fromEntries(values)]))) + ';';
  for (const file of ['public/startup.js', 'electron/startup/particles.js']) {
    assert.deepEqual(auditSource({ file, source: table, catalog, catalogs }).diagnostics, []);
    const frozen = table.replace('= {', '= Object.freeze({').replace(/};$/, '});');
    assert.deepEqual(auditSource({ file, source: frozen, catalog, catalogs }).diagnostics, []);
    const wrong = table.replace('저장', '다른 번역');
    assert.ok(auditSource({ file, source: wrong, catalog, catalogs }).diagnostics.some(item => item.kind === 'inline-catalog'));
    assert.ok(auditSource({ file, source: table + 'document.title = "Unregistered title";', catalog, catalogs }).diagnostics.some(item => item.kind === 'unlocalized-literal'));
    for (const source of ["const messagesByLocale = {'fr-FR': {'保存': 'Save'}};", "const messagesByLocale = {'ja-JP': {'保存': getText()}};", "const messagesByLocale = {'ja-JP': {...other}};"]) {
      assert.ok(auditSource({ file, source, catalog, catalogs }).diagnostics.some(item => item.kind === 'inline-catalog'));
    }
  }
  assert.ok(auditSource({ file: 'public/other.js', source: table, catalog, catalogs }).diagnostics.length);
});

test('the CLI rejects an inline bootstrap table that drifts from a supported locale', t => {
  const f = catalogsFixture(t); fs.mkdirSync(path.join(f.root, 'public'));
  const file = path.join(f.root, 'public/startup.js');
  const table = Object.fromEntries(Object.entries(localeNames).map(([prefix, locale]) => [locale, { ...translations[prefix] }]));
  fs.writeFileSync(file, 'const messagesByLocale = ' + JSON.stringify(table) + ';');
  assert.equal(f.command().status, 0);
  table['ja-JP'].保存 = '未登録';
  fs.writeFileSync(file, 'const messagesByLocale = ' + JSON.stringify(table) + ';');
  const failed = f.command();
  assert.equal(failed.status, 1); assert.match(failed.stderr, /inline-catalog\/ja-JP/);
  assert.match(failed.stderr, /public\/startup\.js/);
});

test('startup markup and built-in JSON cannot introduce uncatalogued copy', () => {
  assert.equal(auditHtml({ file: 'index.html', source: '<p>New startup message</p>', catalog }).length, 1);
  assert.equal(auditHtml({ file: 'index.html', source: '<p data-i18n="保存">保存</p>', catalog }).length, 0);
  assert.equal(auditHtml({ file: 'index.html', source: '<p data-i18n="新增">新增</p>', catalog }).length, 1);
  assert.equal(auditJson({ file: 'spec.json', source: JSON.stringify({ label: '新标签', command: 'echo 原始命令' }), catalog }).length, 1);
  assert.equal(auditJson({ file: 'spec.json', source: JSON.stringify({ label: '保存', command: 'echo 原始命令' }), catalog }).length, 0);
  assert.equal(auditJson({ file: 'spec.json', source: JSON.stringify({ label: 'New label', command: 'echo 原始命令' }), catalog }).length, 1);
  assert.equal(auditHtml({ file: 'index.html', source: '<p>キャンセル</p>', catalog }).length, 1);
  assert.equal(auditHtml({ file: 'index.html', source: '<p>취소</p>', catalog }).length, 1);
});
