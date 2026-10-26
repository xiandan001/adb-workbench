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
function run(file, args, timeout = 30000, environment = process.env) {
  const result = cp.spawnSync(file, args, { windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, env: environment });
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
function prepare(options = {}) {
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
  const dll = path.resolve(options.dllPath || path.join(root, 'build/generated/installer-ui/VeyloInstaller.dll'));
  fs.copyFileSync(dll, path.join(pluginDirectory, 'VeyloInstaller.dll'));
  assert.ok(!options.hooksRef || ['v4.7.5', 'v4.7.6'].includes(options.hooksRef), 'Only published regression baselines may override current hooks');
  const hooksFile = path.join(resources, 'installer-ui.snapshot.nsh');
  const hooks = options.hooksRef ? cp.execFileSync('git', ['show', `${options.hooksRef}:build/installer-ui.nsh`], { cwd: root, encoding: 'utf8', windowsHide: true }) : fs.readFileSync(path.join(root, 'build/installer-ui.nsh'), 'utf8');
  fs.writeFileSync(hooksFile, hooks.replace(/\r\n/g, '\n'), 'utf8');
  const profileSettings = path.join(fixture, 'synthetic-profile', 'settings.json');
  fs.mkdirSync(path.dirname(profileSettings), { recursive: true });
  const payload = path.join(resources, 'fixture-payload.bin');
  if (!options.extractionPayload) fs.writeFileSync(payload, crypto.randomBytes(4 * 1024 * 1024));
  const version = options.hooksRef ? options.hooksRef.slice(1) : require('../package.json').version;
  const nsisCache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis');
  const makensis = locateCacheFolder(nsisCache, 'nsis-', 'Bin/makensis.exe');
  const stdUtils = locateCacheFolder(nsisCache, 'nsis-resources-', 'plugins/x86-unicode/StdUtils.dll');
  const definitions = { PROJECT_DIR: root, BUILD_RESOURCES_DIR: resources, FIXTURE_EXE: exe,
    FIXTURE_INSTALL_DIR: installPath, FIXTURE_RECEIPT_KEY: receiptKey, FIXTURE_ID: id,
    FIXTURE_VERSION: version, FIXTURE_UI_HOOKS: hooksFile, FIXTURE_PAYLOAD: payload,
    VEYLO_PROFILE_SETTINGS_FILE: profileSettings,
    FIXTURE_STDUTILS_DIR: path.dirname(stdUtils), VEYLO_ICON_FILE: path.join(root, 'assets/brand/icon-256.png') };
  let extraction = null;
  if (options.extractionPayload) {
    const input = options.extractionPayload;
    assert.ok(inside(scratch, input.archiveFile), 'Only generated synthetic archives may be embedded');
    const archiveFile = path.join(resources, 'synthetic-app.7z');
    const payloadManifest = path.join(resources, 'payload-manifest.json');
    fs.copyFileSync(input.archiveFile, archiveFile);
    fs.copyFileSync(input.manifestFile, payloadManifest);
    const extractionSource = path.join(root, 'node_modules/app-builder-lib/templates/nsis/include/extractAppPackage.nsh');
    const extractionSnapshot = path.join(resources, 'extractAppPackage.snapshot.nsh');
    fs.copyFileSync(extractionSource, extractionSnapshot);
    const nsis7z = locateCacheFolder(nsisCache, 'nsis-resources-', 'plugins/x86-unicode/Nsis7z.dll');
    fs.copyFileSync(nsis7z, path.join(pluginDirectory, 'Nsis7z.dll'));
    const cleanupFile = path.join(resources, 'extract-cleanup.generated.nsh');
    for (const file of input.files) assert.match(file.name, /^(large-data\.bin|small\/fixture-\d{5}\.bin)$/);
    fs.writeFileSync(cleanupFile, input.files.map(file => `Delete "$INSTDIR\\${file.name.replaceAll('/', '\\')}"`).join('\n') + '\nRMDir "$INSTDIR\\small"\n', 'utf8');
    Object.assign(definitions, { FIXTURE_APP_ARCHIVE: archiveFile, FIXTURE_EXTRACT_INCLUDE: extractionSnapshot, FIXTURE_EXTRACT_CLEANUP: cleanupFile });
    extraction = { archiveFile, payloadManifest, archiveSha256: input.archiveSha256, archiveBytes: input.archiveBytes,
      unpackedBytes: input.unpackedBytes, fileCount: input.fileCount, compressionOptions: input.compressionOptions,
      nsis7zSha256: crypto.createHash('sha256').update(fs.readFileSync(nsis7z)).digest('hex'),
      extractionTemplateSha256: crypto.createHash('sha256').update(fs.readFileSync(extractionSnapshot)).digest('hex') };
  }
  if (!options.hooksRef) definitions.FIXTURE_STAGE_FEEDBACK = null;
  const languageScript = path.join(root, 'build/installer-language.ps1');
  const languageScriptSha256 = fs.existsSync(languageScript) ? crypto.createHash('sha256').update(fs.readFileSync(languageScript)).digest('hex') : null;
  const output = run(makensis, ['/V3', '/INPUTCHARSET', 'UTF8', ...Object.entries(definitions).map(([key, value]) => `/D${key}=${value}`), path.join(__dirname, 'installer-hooks-fixture.nsi')], 60000);
  if (languageScriptSha256) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(languageScript)).digest('hex'), languageScriptSha256, 'Language helper changed during fixture compilation');
  fs.writeFileSync(path.join(fixture, 'compile.txt'), output.replace(/\r\n/g, '\n'), 'utf8');
  const manifestFile = path.join(fixture, 'installer.manifest.xml');
  const manifestTool = 'C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/mt.exe';
  run(manifestTool, [`-inputresource:${exe};#1`, `-out:${manifestFile}`], 10000);
  const manifestXml = fs.readFileSync(manifestFile, 'utf8');
  const dpiAware = /<dpiAware(?:\s[^>]*)?>\s*true\s*<\/dpiAware>/i.test(manifestXml);
  if (!options.hooksRef) assert.ok(dpiAware, 'Current fixture EXE must declare system DPI awareness in its own manifest');
  const manifest = { fixture, exe, installPath, receiptKey, userDataSentinel, sentinel,
    payloadKind: extraction ? 'app-7z' : 'nsis-file', extraction,
    version, profileSettings, pluginDll: path.join(pluginDirectory, 'VeyloInstaller.dll'), hooksFile,
    historicalBaseline: options.hooksRef || null,
    manifestFile, dpiAware, languageScriptSha256,
    payloadSha256: extraction ? extraction.archiveSha256 : crypto.createHash('sha256').update(fs.readFileSync(payload)).digest('hex'),
    dllSha256: crypto.createHash('sha256').update(fs.readFileSync(dll)).digest('hex'),
    hooksSha256: crypto.createHash('sha256').update(fs.readFileSync(hooksFile)).digest('hex'),
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
function fixtureEnvironment(fixture, overrides = {}) {
  assert.ok(inside(scratch, fixture.fixture) && inside(fixture.fixture, fixture.profileSettings));
  const appData = path.join(fixture.fixture, 'fake-appdata');
  const temporary = path.join(fixture.fixture, 'owned-temp');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(temporary, { recursive: true });
  return { ...process.env, APPDATA: appData, TEMP: temporary, TMP: temporary, VEYLO_UPDATE_LANGUAGE: '', ...overrides };
}
function executeFixture(fixture, args, overrides) {
  return run(fixture.exe, args, 30000, fixtureEnvironment(fixture, overrides));
}
function assertPayload(fixture) {
  if (fixture.extraction) {
    const payload = JSON.parse(fs.readFileSync(fixture.extraction.payloadManifest, 'utf8'));
    assert.deepEqual(fs.readdirSync(fixture.installPath).sort(), ['fixture-uninstall.exe', 'fixture.txt', 'large-data.bin', 'small']);
    assert.ok(!fs.lstatSync(path.join(fixture.installPath, 'small')).isSymbolicLink(), 'Synthetic payload directory must not redirect outside its fixture');
    assert.deepEqual(fs.readdirSync(path.join(fixture.installPath, 'small')).sort(), payload.files.filter(file => file.name.startsWith('small/')).map(file => file.name.slice(6)).sort());
    for (const file of payload.files) {
      const target = path.join(fixture.installPath, file.name);
      assert.ok(inside(fixture.installPath, target) && fs.lstatSync(target).isFile(), 'Extracted data must be ordinary fixture files');
      assert.equal(fs.statSync(target).size, file.bytes);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), file.sha256, file.name);
    }
    assert.ok(fs.existsSync(path.join(fixture.installPath, 'fixture-uninstall.exe')));
    return;
  }
  assert.deepEqual(fs.readdirSync(fixture.installPath).sort(), ['fixture-payload.bin', 'fixture-uninstall.exe', 'fixture.txt']);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture.installPath, 'fixture-payload.bin'))).digest('hex'), fixture.payloadSha256, 'Real NSIS File extraction must reproduce exact payload bytes');
}
function assertNoInstallation(fixture) {
  assert.equal(fs.existsSync(fixture.installPath), false, 'Canceled fresh fixture must not create an installation directory');
  assert.equal(registry(fixture, ['query'], true), null, 'Canceled fresh fixture must not create its receipt key');
  assertSentinel(fixture);
}
function seedUpdated(fixture, { profileLocale = 'zh-CN', receiptLocale = 'en-US', updateLanguageEnvironment = '' } = {}) {
  executeFixture(fixture, ['/S']);
  assertPayload(fixture);
  registry(fixture, ['add', '/v', 'Language', '/t', 'REG_SZ', '/d', receiptLocale, '/f']);
  const profile = JSON.stringify({ locale: profileLocale, syntheticActivation: 'must remain unchanged' }) + '\n';
  fs.writeFileSync(fixture.profileSettings, profile, 'utf8');
  fixture.profileSettingsSha256 = crypto.createHash('sha256').update(profile).digest('hex');
  fixture.updateLanguageEnvironment = updateLanguageEnvironment;
  fs.writeFileSync(path.join(fixture.fixture, 'manifest.json'), JSON.stringify(fixture, null, 2) + '\n', 'utf8');
  assertSentinel(fixture);
  return fixture;
}
function uninstall(fixture) {
  assert.ok(inside(fixture.fixture, fixture.installPath));
  const source = path.join(fixture.installPath, 'fixture-uninstall.exe');
  if (!fs.existsSync(source)) return;
  const executable = path.join(fixture.fixture, 'fixture-uninstall-copy.exe');
  fs.copyFileSync(source, executable);
  run(executable, ['/S', `_?=${fixture.installPath}`], 30000, fixtureEnvironment(fixture));
  assert.equal(fs.existsSync(fixture.installPath), false, 'Uninstall should remove only fixture payload files and now-empty directory');
  assert.equal(registry(fixture, ['query'], true), null, 'Uninstall should remove only its fixture registry key');
  assertSentinel(fixture);
}
function silentRoundTrip(fixture) {
  const checks = [];
  try {
    executeFixture(fixture, ['/S']);
    assertPayload(fixture);
    assertValue(fixture, 'Language', 'en-US'); assertValue(fixture, 'DisplayName', 'Veylo');
    assertValue(fixture, 'InstallLocation', fixture.installPath);
    assert.match(fs.readFileSync(path.join(fixture.installPath, 'fixture.txt'), 'utf8'), /generation=1\r\nlanguage=en-US\r\nupdated=0/);
    assertSentinel(fixture); checks.push('silent fresh install defaults to English');
    let generation = 1;
    for (const [locale, brand] of [['zh-CN', '卓控台'], ['zh-TW', '卓控臺'], ['ja-JP', 'Veylo'], ['ko-KR', 'Veylo'], ['en-US', 'Veylo']]) {
      registry(fixture, ['add', '/v', 'Language', '/t', 'REG_SZ', '/d', locale, '/f']);
      executeFixture(fixture, ['/S', '--updated']);
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
function languageRoundTrip(fixture) {
  const checks = [];
  const writeProfile = value => fs.writeFileSync(fixture.profileSettings, value, 'utf8');
  const verify = (locale, brand, profile) => {
    try {
      assertValue(fixture, 'Language', locale); assertValue(fixture, 'DisplayName', brand);
    } catch (error) {
      fs.writeFileSync(path.join(fixture.fixture, 'language-failure.json'), JSON.stringify({
        expectedLocale: locale, expectedBrand: brand, profile,
        payload: fs.readFileSync(path.join(fixture.installPath, 'fixture.txt'), 'utf8'),
        completedChecks: checks,
      }, null, 2) + '\n', 'utf8');
      throw error;
    }
    assertPayload(fixture); assertSentinel(fixture);
    if (profile !== null) assert.equal(fs.readFileSync(fixture.profileSettings, 'utf8'), profile, 'Profile settings must be read-only');
  };
  try {
    const freshProfile = '{"locale":"zh-CN","syntheticActivation":"preserve"}\n';
    writeProfile(freshProfile);
    executeFixture(fixture, ['/S'], { VEYLO_UPDATE_LANGUAGE: 'ko-KR' });
    verify('en-US', 'Veylo', freshProfile);
    checks.push('fresh install ignores both existing-profile language and update-language environment');
    for (const [locale, brand] of [['zh-CN', '卓控台'], ['zh-TW', '卓控臺'], ['ja-JP', 'Veylo'], ['ko-KR', 'Veylo'], ['en-US', 'Veylo']]) {
      const profile = JSON.stringify({ locale, syntheticActivation: 'preserve' }) + '\n';
      writeProfile(profile); executeFixture(fixture, ['/S', '--updated']); verify(locale, brand, profile);
      checks.push(`old updater with no locale environment reads ${locale} from its isolated profile`);
    }
    const profile = '{"locale":"zh-CN","syntheticActivation":"preserve"}\n';
    writeProfile(profile); executeFixture(fixture, ['/S', '--updated'], { VEYLO_UPDATE_LANGUAGE: 'ja-JP' });
    verify('ja-JP', 'Veylo', profile); checks.push('future updater environment takes priority over profile');
    executeFixture(fixture, ['/S', '--updated'], { VEYLO_UPDATE_LANGUAGE: 'invalid-locale' });
    verify('zh-CN', '卓控台', profile); checks.push('invalid updater environment falls back to profile');
    registry(fixture, ['add', '/v', 'Language', '/t', 'REG_SZ', '/d', 'zh-TW', '/f']);
    writeProfile('{broken'); executeFixture(fixture, ['/S', '--updated']);
    verify('zh-TW', '卓控臺', '{broken'); checks.push('malformed profile falls back to existing receipt without rewriting profile');
    fs.unlinkSync(fixture.profileSettings); executeFixture(fixture, ['/S', '--updated']);
    verify('zh-TW', '卓控臺', null); checks.push('missing profile falls back to existing receipt');
    uninstall(fixture); checks.push('language fixture uninstall preserves sibling user-data sentinel');
    return checks;
  } finally {
    if (fs.existsSync(path.join(fixture.installPath, 'fixture-uninstall.exe'))) uninstall(fixture);
    if (registry(fixture, ['query'], true)) registry(fixture, ['delete', '/f']);
    assertSentinel(fixture);
  }
}

if (require.main === module) {
  (async () => {
    assert.ok(process.argv.length === 2 || (process.argv.length === 3 && ['--prepare', '--prepare-extract', '--language'].includes(process.argv[2])), 'Usage: node tests/run-installer-hooks-fixture.cjs [--prepare|--prepare-extract|--language]');
    const extractionPayload = process.argv[2] === '--prepare-extract' ? await require('./installer-extract-payload.cjs').createExtractionPayload() : null;
    const manifest = prepare({ extractionPayload });
    const summary = { ...manifest, checks: process.argv[2]?.startsWith('--prepare') ? [] : process.argv[2] === '--language' ? languageRoundTrip(manifest) : silentRoundTrip(manifest) };
    fs.writeFileSync(path.join(manifest.fixture, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify(summary, null, 2));
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { prepare, seedUpdated, silentRoundTrip, languageRoundTrip, uninstall, assertValue, assertSentinel, assertPayload, assertNoInstallation, executeFixture };
