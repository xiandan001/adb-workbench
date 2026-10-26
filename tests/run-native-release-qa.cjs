const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const installer = require('./run-installer-hooks-fixture.cjs');
const { sourceHashes } = require('./run-uninstaller-hooks-fixture.cjs');

function childReport(directory, name, script, args, timeout = 200000) {
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(directory, `${name}.stdout.txt`), (result.stdout || '').replace(/\r\n/g, '\n'));
  fs.writeFileSync(path.join(directory, `${name}.stderr.txt`), (result.stderr || '').replace(/\r\n/g, '\n'));
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`);
  const start = result.stdout.lastIndexOf('\n{\n');
  return JSON.parse(start >= 0 ? result.stdout.slice(start + 1) : result.stdout);
}

function installerScenario(directory, dll, harness, action, locale, id) {
  const fixture = installer.prepare({ dllPath: dll });
  const name = `installer-${action}-${locale}`;
  let report;
  try {
    if (action === 'updated') installer.seedUpdated(fixture, { profileLocale: locale, receiptLocale: locale === 'en-US' ? 'zh-CN' : 'en-US' });
    report = childReport(directory, name, 'run-native-installer-gui.cjs', ['--fixture', fixture.exe, fixture.installPath, String(id), action, '--reuse-harness', harness]);
    assert.equal(report.status, 0);
    assert.equal(report.dllSha256, sha256(dll));
    assert.equal(report.artifactVerification.checked, true);
  } finally {
    installer.uninstall(fixture);
    installer.assertNoInstallation(fixture);
  }
  return { action, locale, status: 'passed', report: path.join(report.fixture, 'summary.json'),
    manifest: path.join(fixture.fixture, 'manifest.json'), uniqueInstallPath: fixture.installPath, uniqueFixtureKey: fixture.receiptKey,
    dllSha256: report.dllSha256, payloadCleaned: true, fixtureKeyCleaned: true, sentinelPreserved: true,
    profilePreserved: !fixture.profileSettingsSha256 || sha256(fixture.profileSettings) === fixture.profileSettingsSha256,
    screenshots: report.screenshots.map(name => path.join(report.fixture, name)) };
}

function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.argv.length, 4, 'Usage: node tests/run-native-release-qa.cjs --dll <frozen-dll>');
  assert.equal(process.argv[2], '--dll');
  const dll = fs.realpathSync(process.argv[3]);
  const originalDll = sha256(dll), originalSources = sourceHashes();
  const scratch = path.join(root, '.superpowers');
  fs.mkdirSync(scratch, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratch, 'native-release-478-'));
  console.log(`Native 4.7.8 evidence: ${directory}`);
  const uninstall = childReport(directory, 'uninstaller-matrix', 'run-uninstaller-hooks-fixture.cjs', ['--dll', dll], 600000);
  assert.equal(uninstall.status, 'passed');
  assert.equal(uninstall.dllSha256, originalDll);
  const harness = path.join(uninstall.nativeSkin.fixture, 'harness.exe');
  console.log('Uninstaller matrix passed; checking the installer with the same DLL.');
  const installSkin = childReport(directory, 'installer-dll', 'run-native-installer-gui.cjs', [dll, '--reuse-harness', harness]);
  assert.equal(installSkin.status, 0);
  assert.equal(installSkin.dllSha256, originalDll);
  assert.equal(installSkin.safetySentinelsPreserved, true);
  const installerScenarios = [installerScenario(directory, dll, harness, 'cancel', 'en-US', 1033), installerScenario(directory, dll, harness, 'install', 'en-US', 1033)];
  for (const [locale, id] of [['zh-CN', 2052], ['zh-TW', 1028], ['en-US', 1033], ['ja-JP', 1041], ['ko-KR', 1042]]) {
    installerScenarios.push(installerScenario(directory, dll, harness, 'updated', locale, id));
    console.log(`Installer language GUI passed: ${locale}`);
  }
  assert.equal(sha256(dll), originalDll, 'Final DLL bytes remain unchanged');
  assert.deepEqual(sourceHashes(), originalSources, 'Product sources remain unchanged during final QA');
  assert.ok(installerScenarios.every(scenario => scenario.profilePreserved));
  const aggregate = { status: 'passed', version: require('../package.json').version, completedAt: new Date().toISOString(),
    dllPath: dll, dllSha256: originalDll, sourceHashes: originalSources,
    reports: { uninstaller: uninstall.reportFile, uninstallSkin: path.join(uninstall.nativeSkin.fixture, 'summary.json'), installerSkin: path.join(installSkin.fixture, 'summary.json') },
    uninstallerScenarios: uninstall.checks, installerScenarios,
    fiveLocaleUninstallScreenshots: uninstall.nativeSkin.screenshots.map(name => path.join(uninstall.nativeSkin.fixture, name)),
    installerSafetySentinels: { count: installSkin.safetySentinelCount, preserved: installSkin.safetySentinelsPreserved },
    notCovered: ['Production installation or removal', 'Elevation/UAC', 'Other DPI or multi-monitor configurations', 'Global motion or clipboard changes'],
    isolation: 'Frozen release DLL copied into per-scenario private-desktop fixtures; no production uninstaller, real PATH/profile, device or app launch.' };
  const aggregateFile = path.join(directory, 'aggregate.json');
  fs.writeFileSync(aggregateFile, JSON.stringify(aggregate, null, 2) + '\n');
  console.log(JSON.stringify({ status: aggregate.status, version: aggregate.version, dllSha256: originalDll, aggregate: aggregateFile }, null, 2));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.stack); process.exitCode = 1; } }
