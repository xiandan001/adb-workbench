const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scratch = path.join(root, '.superpowers');
const keyPrefix = 'Software\\VeyloInstallerHooksFixture\\';

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function run(file, args, timeout = 30000) {
  const result = cp.spawnSync(file, args, { windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${path.basename(file)} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
function locateCacheFolder(base, prefix, file) {
  const matches = fs.readdirSync(base).filter(name => name.startsWith(prefix)).sort().reverse();
  const result = matches.map(name => path.join(base, name, file)).find(candidate => fs.existsSync(candidate));
  assert.ok(result, `Missing cached NSIS component: ${file}`);
  return result;
}
function prepare() {
  assert.equal(process.platform, 'win32', 'NSIS fixture requires Windows');
  fs.mkdirSync(scratch, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(scratch, 'installer-hooks-fixture-'));
  assert.ok(inside(scratch, fixture));
  const id = crypto.randomUUID();
  const receiptKey = keyPrefix + id;
  const installPath = path.join(fixture, 'installed-fixture');
  const exe = path.join(fixture, 'installer-hooks-fixture.exe');
  const userDataSentinel = path.join(fixture, 'user-data-sentinel.txt');
  const sentinel = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(userDataSentinel, sentinel + '\n', 'utf8');
  const resources = path.join(fixture, 'resources');
  const pluginDirectory = path.join(resources, 'generated/installer-ui');
  fs.mkdirSync(pluginDirectory, { recursive: true });
  const dll = path.join(root, 'build/generated/installer-ui/VeyloInstaller.dll');
  fs.copyFileSync(dll, path.join(pluginDirectory, 'VeyloInstaller.dll'));
  const nsisCache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis');
  const makensis = locateCacheFolder(nsisCache, 'nsis-', 'Bin/makensis.exe');
  const stdUtils = locateCacheFolder(nsisCache, 'nsis-resources-', 'plugins/x86-unicode/StdUtils.dll');
  const definitions = { PROJECT_DIR: root, BUILD_RESOURCES_DIR: resources, FIXTURE_EXE: exe,
    FIXTURE_INSTALL_DIR: installPath, FIXTURE_RECEIPT_KEY: receiptKey, FIXTURE_ID: id,
    FIXTURE_STDUTILS_DIR: path.dirname(stdUtils), VEYLO_ICON_FILE: path.join(root, 'assets/brand/icon-256.png') };
  const output = run(makensis, ['/V3', '/INPUTCHARSET', 'UTF8', ...Object.entries(definitions).map(([key, value]) => `/D${key}=${value}`), path.join(__dirname, 'installer-hooks-fixture.nsi')], 60000);
  fs.writeFileSync(path.join(fixture, 'compile.txt'), output, 'utf8');
  const manifest = { fixture, exe, installPath, receiptKey, userDataSentinel, sentinel,
    dllSha256: crypto.createHash('sha256').update(fs.readFileSync(dll)).digest('hex'),
    hooksSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'build/installer-ui.nsh'))).digest('hex'),
    isolation: 'Fixed fixture installation path and unique HKCU key; no production installer.nsh, PATH changes, ADB, app launch or real user data.' };
  fs.writeFileSync(path.join(fixture, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}
function registry(fixture, args, allowMissing = false) {
  assert.ok(fixture.receiptKey.startsWith(keyPrefix) && /^[0-9a-f-]{36}$/.test(fixture.receiptKey.slice(keyPrefix.length)));
  const file = path.join(process.env.SystemRoot, 'System32/reg.exe');
  const result = cp.spawnSync(file, [args[0], `HKCU\\${fixture.receiptKey}`, ...args.slice(1), '/reg:64'], { windowsHide: true, encoding: 'buffer', timeout: 5000 });
  assert.equal(result.error, undefined);
  if (allowMissing && result.status === 1) return null;
  assert.equal(result.status, 0, 'Fixture-only registry operation failed');
  return result.stdout;
}
function assertValue(fixture, name, expected) {
  const bytes = registry(fixture, ['query', '/v', name]);
  const accepted = ['utf-8', 'utf-16le', 'gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252'].some(encoding => {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      const found = text.split(/\r?\n/).find(line => line.trimStart().startsWith(`${name} `));
      return found && found.trim().replace(new RegExp(`^${name}\\s+REG_SZ\\s+`), '') === expected;
    } catch { return false; }
  });
  assert.ok(accepted, `Fixture receipt ${name} did not match expected value`);
}
function assertSentinel(fixture) {
  assert.equal(fs.readFileSync(fixture.userDataSentinel, 'utf8'), fixture.sentinel + '\n');
}
function uninstall(fixture) {
  assert.ok(inside(fixture.fixture, fixture.installPath));
  const source = path.join(fixture.installPath, 'fixture-uninstall.exe');
  if (!fs.existsSync(source)) return;
  const executable = path.join(fixture.fixture, 'fixture-uninstall-copy.exe');
  fs.copyFileSync(source, executable);
  run(executable, ['/S', `_?=${fixture.installPath}`]);
  assert.equal(fs.existsSync(fixture.installPath), false, 'Uninstall should remove only its two payload files and now-empty directory');
  assert.equal(registry(fixture, ['query'], true), null, 'Uninstall should remove only its fixture registry key');
  assertSentinel(fixture);
}
function silentRoundTrip(fixture) {
  const checks = [];
  try {
    run(fixture.exe, ['/S']);
    assert.deepEqual(fs.readdirSync(fixture.installPath).sort(), ['fixture-uninstall.exe', 'fixture.txt']);
    assertValue(fixture, 'Language', 'en-US'); assertValue(fixture, 'DisplayName', 'Veylo');
    assertValue(fixture, 'InstallLocation', fixture.installPath);
    assert.match(fs.readFileSync(path.join(fixture.installPath, 'fixture.txt'), 'utf8'), /generation=1\r\nlanguage=en-US\r\nupdated=0/);
    assertSentinel(fixture); checks.push('silent fresh install defaults to English');
    let generation = 1;
    for (const [locale, brand] of [['zh-CN', '卓控台'], ['zh-TW', '卓控臺'], ['ja-JP', 'Veylo'], ['ko-KR', 'Veylo'], ['en-US', 'Veylo']]) {
      registry(fixture, ['add', '/v', 'Language', '/t', 'REG_SZ', '/d', locale, '/f']);
      run(fixture.exe, ['/S', '--updated']);
      generation++;
      assertValue(fixture, 'Language', locale); assertValue(fixture, 'DisplayName', brand);
      assertValue(fixture, 'InstallLocation', fixture.installPath);
      assert.match(fs.readFileSync(path.join(fixture.installPath, 'fixture.txt'), 'utf8'), new RegExp(`generation=${generation}\\r\\nlanguage=${locale}\\r\\nupdated=1`));
      assertSentinel(fixture); checks.push(`silent update preserves ${locale} and its localized brand`);
    }
    uninstall(fixture); checks.push('uninstall removes fixture payload/key and preserves sibling user-data sentinel');
    return checks;
  } finally {
    if (fs.existsSync(path.join(fixture.installPath, 'fixture-uninstall.exe'))) uninstall(fixture);
    // Exact fixture key only; also cleans a partially failed fixture installation.
    if (registry(fixture, ['query'], true)) registry(fixture, ['delete', '/f']);
    assertSentinel(fixture);
  }
}

if (require.main === module) {
  try {
    assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--prepare'), 'Usage: node tests/run-installer-hooks-fixture.cjs [--prepare]');
    const manifest = prepare();
    const summary = { ...manifest, checks: process.argv[2] === '--prepare' ? [] : silentRoundTrip(manifest) };
    fs.writeFileSync(path.join(manifest.fixture, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
module.exports = { prepare, silentRoundTrip, uninstall, assertValue, assertSentinel };
