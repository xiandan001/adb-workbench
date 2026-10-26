const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const scratch = path.join(root, '.superpowers');
const keyPrefix = 'Software\\VeyloUninstallFixture\\';
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sourceHashes() {
  const files = ['build/installer-ui.nsh', 'build/installer-uninstall-ui.nsh', 'build/installer.nsh', 'build/installer-language.ps1',
    ...fs.readdirSync(path.join(root, 'build/installer-ui')).filter(name => /\.(cpp|h|def|json)$/.test(name)).map(name => `build/installer-ui/${name}`)];
  return Object.fromEntries(files.sort().map(file => [file, sha256(path.join(root, file))]));
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
function run(file, args, options = {}) {
  const result = cp.spawnSync(file, args, { windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, ...options });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${path.basename(file)}: ${result.stdout || ''}\n${result.stderr || ''}`);
  return result.stdout;
}
function privateBuild() {
  const output = fs.mkdtempSync(path.join(scratch, 'uninstall-private-dll-'));
  const source = path.join(root, 'build/installer-ui');
  const { compileStrings } = require('../scripts/build-installer-ui.cjs');
  fs.writeFileSync(path.join(output, 'installer-strings.generated.h'), compileStrings(JSON.parse(fs.readFileSync(path.join(source, 'strings.json'), 'utf8'))));
  const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
  const visualStudio = run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']).trim();
  assert.ok(visualStudio && fs.existsSync(visualStudio));
  const vcvars = path.join(visualStudio, 'VC/Auxiliary/Build/vcvarsall.bat');
  const command = `call "${vcvars}" x86 >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /LD /DUNICODE /D_UNICODE /I"${output}" /Fo"${path.join(output, 'installer-skin.obj')}" "${path.join(source, 'installer-skin.cpp')}" /link /DEF:"${path.join(source, 'installer-skin.def')}" /OUT:"${path.join(output, 'VeyloInstaller.dll')}" user32.lib gdi32.lib comctl32.lib gdiplus.lib ole32.lib shell32.lib uuid.lib`;
  run(process.env.ComSpec, ['/d', '/s', '/c', `"${command}"`], { cwd: output, windowsVerbatimArguments: true, timeout: 120000 });
  return path.join(output, 'VeyloInstaller.dll');
}
function prepare(dll) {
  const directory = fs.mkdtempSync(path.join(scratch, 'uninstaller-hooks-fixture-'));
  assert.ok(inside(scratch, directory));
  const key = keyPrefix + crypto.randomUUID();
  const resources = path.join(directory, 'resources');
  const plugin = path.join(resources, 'generated/installer-ui');
  fs.mkdirSync(plugin, { recursive: true });
  fs.copyFileSync(dll, path.join(plugin, 'VeyloInstaller.dll'));
  for (const name of ['installer-ui.nsh', 'installer-uninstall-ui.nsh']) fs.copyFileSync(path.join(root, 'build', name), path.join(resources, name));
  const templates = path.join(root, 'node_modules/app-builder-lib/templates/nsis');
  const pages = path.join(resources, 'assistedInstaller.snapshot.nsh');
  fs.copyFileSync(path.join(templates, 'assistedInstaller.nsh'), pages);
  const initSource = fs.readFileSync(path.join(templates, 'uninstaller.nsh'), 'utf8').split('Function un.atomicRMDir')[0];
  assert.ok(initSource.includes('Function un.onInit\n') || initSource.includes('Function un.onInit\r\n'));
  const init = path.join(resources, 'uninstaller-init.snapshot.nsh');
  const guard = 'Function un.onInit\n  StrCmp $INSTDIR "${FIXTURE_INSTALL_DIR}" +3\n    SetErrorLevel 3\n    Quit\n';
  fs.writeFileSync(init, initSource.replace(/\r\n/g, '\n').replace('Function un.onInit\n', guard));
  const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis');
  const nsis = fs.readdirSync(cache).filter(name => name.startsWith('nsis-')).map(name => path.join(cache, name)).find(name => fs.existsSync(path.join(name, 'Bin/makensis.exe')));
  assert.ok(nsis, 'Cached NSIS compiler is required');
  const manifest = { directory, key, installPath: path.join(directory, 'installed-fixture'),
    executable: path.join(directory, 'uninstall-fixture.exe'), generator: path.join(directory, 'uninstall-generator.exe'),
    profile: path.join(directory, 'synthetic-profile/settings.json'), sentinel: path.join(directory, 'user-data-sentinel.txt'),
    audit: path.join(directory, 'audit.txt'), failure: path.join(directory, 'fail-marker'),
    pluginDll: path.join(plugin, 'VeyloInstaller.dll'), dllSha256: sha256(dll), pagesSha256: sha256(pages),
    initSourceSha256: crypto.createHash('sha256').update(initSource).digest('hex'), initSnapshotSha256: sha256(init),
    hooksSha256: sha256(path.join(resources, 'installer-ui.nsh')), uninstallHooksSha256: sha256(path.join(resources, 'installer-uninstall-ui.nsh')) };
  fs.mkdirSync(path.dirname(manifest.profile));
  const defines = { PROJECT_DIR: root, BUILD_RESOURCES_DIR: resources, FIXTURE_GENERATOR: manifest.generator,
    FIXTURE_INSTALL_DIR: manifest.installPath, FIXTURE_RECEIPT_KEY: key, FIXTURE_VERSION: require('../package.json').version,
    FIXTURE_UNINSTALLER: manifest.executable, FIXTURE_UI_HOOKS: path.join(resources, 'installer-ui.nsh'),
    FIXTURE_ASSISTED_PAGES: pages, FIXTURE_UNINSTALL_INIT: init, FIXTURE_AUDIT: manifest.audit,
    FIXTURE_FAIL_MARKER: manifest.failure, VEYLO_PROFILE_SETTINGS_FILE: manifest.profile, VEYLO_ICON_FILE: path.join(root, 'assets/brand/icon-256.png') };
  const compile = run(path.join(nsis, 'Bin/makensis.exe'), ['/V3', '/INPUTCHARSET', 'UTF8', `/X!addincludedir "${resources}"`, `/X!addincludedir "${path.join(templates, 'include')}"`, ...Object.entries(defines).map(([key, value]) => `/D${key}=${value}`), path.join(__dirname, 'uninstaller-hooks-fixture.nsi')]);
  fs.writeFileSync(path.join(directory, 'compile.txt'), compile.replace(/\r\n/g, '\n'));
  run(manifest.generator, []);
  assert.ok(fs.existsSync(manifest.executable));
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
function registry(fixture, args, missing = false) {
  assert.ok(fixture.key.startsWith(keyPrefix) && /^[0-9a-f-]{36}$/.test(fixture.key.slice(keyPrefix.length)));
  const result = cp.spawnSync(path.join(process.env.SystemRoot, 'System32/reg.exe'), [args[0], `HKCU\\${fixture.key}`, ...args.slice(1), '/reg:64'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  if (missing && result.status === 1) return null;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function seed(fixture, profile, receipt = 'en-US', matchingReceipt = true) {
  assert.ok(inside(fixture.directory, fixture.installPath));
  fs.mkdirSync(fixture.installPath, { recursive: true });
  for (const name of ['payload-one.txt', 'payload-two.txt', 'fixture.txt']) fs.writeFileSync(path.join(fixture.installPath, name), `Synthetic owned payload: ${name}\n`);
  fs.writeFileSync(fixture.sentinel, 'Synthetic user data must survive all uninstall UI tests.\n');
  if (profile === null) { if (fs.existsSync(fixture.profile)) fs.unlinkSync(fixture.profile); }
  else fs.writeFileSync(fixture.profile, profile);
  if (fs.existsSync(fixture.audit)) fs.unlinkSync(fixture.audit);
  if (fs.existsSync(fixture.failure)) fs.unlinkSync(fixture.failure);
  registry(fixture, ['add', '/v', 'Language', '/t', 'REG_SZ', '/d', receipt, '/f']);
  registry(fixture, ['add', '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', matchingReceipt ? fixture.installPath : path.join(fixture.directory, 'other'), '/f']);
}
function exercise(fixture, harness, action, locale, name) {
  const output = path.join(fixture.directory, name);
  fs.mkdirSync(output);
  const temporary = path.join(fixture.directory, 'owned-temp');
  fs.mkdirSync(temporary, { recursive: true });
  if (action === 'fail') fs.writeFileSync(fixture.failure, 'Synthetic failure before deletion.\n');
  const sentinelHash = sha256(fixture.sentinel), profileHash = fs.existsSync(fixture.profile) ? sha256(fixture.profile) : null;
  const stdout = run(harness, [output, '--uninstall-fixture', fixture.executable, fixture.installPath, String(locale), action],
    { env: { ...process.env, TEMP: temporary, TMP: temporary, APPDATA: path.dirname(fixture.profile), VEYLO_UPDATE_LANGUAGE: '' } });
  fs.writeFileSync(path.join(output, 'stdout.txt'), stdout.replace(/\r\n/g, '\n'));
  assert.equal(sha256(fixture.sentinel), sentinelHash);
  assert.equal(fs.existsSync(fixture.profile) ? sha256(fixture.profile) : null, profileHash);
  const keepsPayload = ['cancel', 'fail'].includes(action);
  assert.equal(fs.existsSync(fixture.installPath), keepsPayload);
  if (keepsPayload) for (const file of ['payload-one.txt', 'payload-two.txt', 'fixture.txt']) assert.ok(fs.existsSync(path.join(fixture.installPath, file)));
  assert.equal(registry(fixture, ['query'], true) !== null, keepsPayload);
  const audit = fs.existsSync(fixture.audit) ? fs.readFileSync(fixture.audit, 'utf8') : '';
  if (action === 'cancel') assert.equal(audit, '');
  else {
    assert.equal((audit.match(/process-check/g) || []).length, 1, 'Stock init/section process-check timing remains intact');
    assert.match(audit, new RegExp(`ready=${['silent', 'updated'].includes(action) ? 0 : 1}`));
  }
  const exitCode = Number(stdout.match(/uninstall fixture action=\w+ exit=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(exitCode));
  return { action, locale, output, exitCode, sentinelPreserved: true, profilePreserved: true,
    payloadRetainedBeforeCleanup: keepsPayload, keyRetainedBeforeCleanup: keepsPayload, audit,
    screenshots: fs.readdirSync(output).filter(name => name.endsWith('.png')).map(name => path.join(output, name)) };
}
function cleanupRegistry(fixture) {
  if (registry(fixture, ['query'], true)) registry(fixture, ['delete', '/f']);
}
function cleanupFixture(fixture) {
  assert.ok(inside(scratch, fixture.directory) && fixture.installPath === path.join(fixture.directory, 'installed-fixture'));
  if (fs.existsSync(fixture.installPath)) {
    const directory = fs.lstatSync(fixture.installPath);
    assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
    for (const name of fs.readdirSync(fixture.installPath)) {
      assert.ok(['payload-one.txt', 'payload-two.txt', 'fixture.txt'].includes(name), 'Only exact synthetic payload files may be cleaned');
      const file = path.join(fixture.installPath, name), stat = fs.lstatSync(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      fs.unlinkSync(file);
    }
    fs.rmdirSync(fixture.installPath);
  }
  cleanupRegistry(fixture);
  assert.equal(registry(fixture, ['query'], true), null);
  return { payloadCleaned: !fs.existsSync(fixture.installPath), fixtureKeyCleaned: true };
}
function main() {
  assert.equal(process.platform, 'win32');
  assert.ok(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--dll'), 'Usage: node tests/run-uninstaller-hooks-fixture.cjs [--dll <frozen-dll>]');
  fs.mkdirSync(scratch, { recursive: true });
  const dll = process.argv[2] ? path.resolve(process.argv[3]) : privateBuild();
  // The nested runner has separate 120-second compile and 60-second GUI bounds.
  const nativeOutput = run(process.execPath, [path.join(__dirname, 'run-native-installer-gui.cjs'), '--uninstall-ui', dll], { timeout: 200000 });
  const summary = JSON.parse(nativeOutput.slice(nativeOutput.lastIndexOf('\n{\n') + 1));
  assert.equal(summary.status, 0);
  const harness = path.join(summary.fixture, 'harness.exe');
  const directory = fs.mkdtempSync(path.join(scratch, 'native-uninstall-suite-'));
  const originalHashes = sourceHashes(), originalDllHash = sha256(dll), checks = [];
  const scenarios = [['zh-CN', 2052], ['zh-TW', 1028], ['en-US', 1033], ['ja-JP', 1041], ['ko-KR', 1042]]
    .map(([locale, id]) => ({ action: 'finish', id, name: `finish-${locale}`, profile: JSON.stringify({ locale, syntheticActivation: 'preserve' }) + '\n' }));
  scenarios.push(
    { action: 'cancel', id: 1028, name: 'cancel-malformed-profile', profile: '{broken\n', receipt: 'zh-TW' },
    { action: 'fail', id: 1041, name: 'failure-receipt-fallback', profile: null, receipt: 'ja-JP' },
    { action: 'finish', id: 1033, name: 'mismatched-receipt-default', profile: null, receipt: 'ko-KR', matches: false },
    ...['silent', 'updated'].map(action => ({ action, id: 1033, name: action, profile: '{"locale":"zh-CN","syntheticActivation":"preserve"}\n' })));
  for (const scenario of scenarios) {
    const fixture = prepare(dll);
    let check;
    try {
      seed(fixture, scenario.profile, scenario.receipt, scenario.matches);
      check = { ...exercise(fixture, harness, scenario.action, scenario.id, scenario.name), manifest: path.join(fixture.directory, 'manifest.json'),
        uniqueInstallPath: fixture.installPath, uniqueFixtureKey: fixture.key, dllSha256: fixture.dllSha256 };
    } finally {
      const cleanup = cleanupFixture(fixture);
      if (check) Object.assign(check, cleanup);
    }
    checks.push(check);
  }
  assert.equal(sha256(dll), originalDllHash, 'Tested DLL remains frozen');
  assert.deepEqual(sourceHashes(), originalHashes, 'Product sources remain frozen throughout the matrix');
  const result = { status: 'passed', version: require('../package.json').version, directory, dllPath: dll, dllSha256: originalDllHash,
    sourceHashes: originalHashes, nativeSkin: summary, checks, reportFile: path.join(directory, 'summary.json'),
    isolation: 'Private desktops; separate fixed synthetic directory and current-user UUID key per scenario; stock page/init snapshots; no production removal section, PATH, devices, app launch or real profile access.' };
  fs.writeFileSync(result.reportFile, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; } }
module.exports = { prepare, seed, exercise, cleanupRegistry, cleanupFixture, sourceHashes };
