const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
assert.equal(process.platform, 'win32', 'Native GUI QA requires Windows');
const fixtureMode = process.argv[2] === '--fixture';
const offscreenMode = process.argv[2] === '--offscreen';
const fixtureExecutable = fixtureMode ? fs.realpathSync(process.argv[3]) : null;
const installPath = fixtureMode ? path.resolve(process.argv[4]) : null;
const fixtureManifest = fixtureMode ? JSON.parse(fs.readFileSync(path.join(path.dirname(fixtureExecutable), 'manifest.json'), 'utf8')) : null;
if (fixtureMode) {
  const sandbox = path.resolve(root, '.superpowers') + path.sep;
  assert.ok(fixtureExecutable.toLowerCase().startsWith(sandbox.toLowerCase()) && /fixture.*\.exe$/i.test(path.basename(fixtureExecutable)), 'Only a named fixture EXE inside .superpowers may run');
  assert.ok(installPath.toLowerCase().startsWith(sandbox.toLowerCase()), 'Fixture installation must remain inside .superpowers');
  assert.equal(path.resolve(fixtureManifest.exe).toLowerCase(), fixtureExecutable.toLowerCase(), 'Executable must match its prepared fixture manifest');
  assert.equal(path.resolve(fixtureManifest.installPath).toLowerCase(), installPath.toLowerCase(), 'Installation must use the exact manifest-owned fixture path');
  assert.ok(path.resolve(fixtureManifest.hooksFile).startsWith(path.dirname(fixtureExecutable) + path.sep), 'Hooks snapshot must belong to this fixture');
  assert.equal(fixtureManifest.hooksSha256, crypto.createHash('sha256').update(fs.readFileSync(fixtureManifest.hooksFile)).digest('hex'), 'Fixture hooks snapshot changed');
  assert.ok(['install', 'cancel', 'updated'].includes(process.argv[6] || 'install'), 'Fixture action must be install, cancel or updated');
}
const source = path.resolve(fixtureMode ? fixtureManifest.pluginDll : !offscreenMode && process.argv[2] || path.join(root, 'build/generated/installer-ui/VeyloInstaller.dll'));
fs.mkdirSync(path.join(root, '.superpowers'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, '.superpowers/native-installer-qa-'));
const binary = fs.readFileSync(source);
assert.equal(binary.readUInt16LE(binary.readUInt32LE(0x3c) + 4), 0x14c, 'The NSIS DLL must be x86');
const dllSha256 = crypto.createHash('sha256').update(binary).digest('hex');
if (fixtureMode) assert.equal(fixtureManifest.dllSha256, dllSha256, 'Re-prepare the fixture after rebuilding the native DLL');
fs.copyFileSync(source, path.join(fixture, 'VeyloInstaller.dll'));
fs.copyFileSync(path.join(root, 'assets/brand/icon-256.png'), path.join(fixture, 'icon.png'));
const safetySentinels = [];
if (!fixtureMode && !offscreenMode) {
  for (const directory of ['Existing/Veylo', 'Other/Veylo', 'ParentWithPersonalFile', 'ReparseTarget', 'RealParent']) {
    const target = path.join(fixture, directory);
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, 'synthetic-user-profile.json');
    const content = JSON.stringify({ fixtureOnly: true, preserve: directory }) + '\n';
    fs.writeFileSync(file, content, 'utf8');
    safetySentinels.push({ file, content });
  }
  fs.mkdirSync(path.join(fixture, 'Empty/Veylo'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'Reparse'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'FileTarget'), { recursive: true });
  for (const relative of ['FileTarget/Veylo', 'FileParent']) {
    const file = path.join(fixture, relative);
    const content = 'Fixture-only file must not become an installation directory.\n';
    fs.writeFileSync(file, content, 'utf8');
    safetySentinels.push({ file, content });
  }
  fs.symlinkSync(path.join(fixture, 'ReparseTarget'), path.join(fixture, 'Reparse/Veylo'), 'junction');
  fs.symlinkSync(path.join(fixture, 'RealParent'), path.join(fixture, 'LinkedParent'), 'junction');
}
const harnessSourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'native-installer-gui.cpp'))).update(fs.readFileSync(path.join(__dirname, 'native-installer-fixture-driver.h'))).update('msvc-x86-c++17-static-crt-v1').digest('hex');
const reuseIndex = process.argv.indexOf('--reuse-harness');
const reusedHarness = reuseIndex >= 0 ? path.resolve(process.argv[reuseIndex + 1]) : null;
if (reusedHarness) {
  assert.ok(reusedHarness.startsWith(path.join(root, '.superpowers') + path.sep), 'Only this workspace QA harness may be reused');
  const previous = JSON.parse(fs.readFileSync(path.join(path.dirname(reusedHarness), 'summary.json'), 'utf8'));
  assert.equal(previous.harnessSourceSha256, harnessSourceSha256, 'Recompile the harness after changing either C++ test source');
  assert.equal(previous.harnessSha256, crypto.createHash('sha256').update(fs.readFileSync(reusedHarness)).digest('hex'), 'Reusable harness differs from its recorded binary');
  fs.copyFileSync(reusedHarness, path.join(fixture, 'harness.exe'));
} else {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const visualStudio = cp.execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.ok(visualStudio, 'MSVC x86 Build Tools are required');
  const vcvars = path.join(visualStudio, 'VC/Auxiliary/Build/vcvarsall.bat');
  const command = `call "${vcvars}" x86 >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /DUNICODE /D_UNICODE /Fo"${path.join(fixture, 'harness.obj')}" "${path.join(__dirname, 'native-installer-gui.cpp')}" /link /OUT:"${path.join(fixture, 'harness.exe')}" user32.lib gdi32.lib comctl32.lib gdiplus.lib ole32.lib`;
  cp.execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: fixture, windowsHide: true, windowsVerbatimArguments: true, stdio: 'inherit', timeout: 120000 });
}
const argumentsForHarness = fixtureMode ? [fixture, '--fixture', fixtureExecutable, installPath, process.argv[5] || '1033', process.argv[6] || 'install'] : offscreenMode ? [fixture, '--offscreen'] : [fixture];
const environment = { ...process.env, VEYLO_QA_VERSION: `${fixtureManifest?.version || require('../package.json').version} QA`, VEYLO_UPDATE_LANGUAGE: '' };
if (fixtureMode) {
  environment.APPDATA = path.join(fixtureManifest.fixture, 'fake-appdata');
  fs.mkdirSync(environment.APPDATA, { recursive: true });
  if (fixtureManifest.updateLanguageEnvironment) environment.VEYLO_UPDATE_LANGUAGE = fixtureManifest.updateLanguageEnvironment;
}
const execution = cp.spawnSync(path.join(fixture, 'harness.exe'), argumentsForHarness, { cwd: fixture, windowsHide: true, encoding: 'utf8', timeout: 60000, env: environment });
const artifactVerification = { checked: false, error: null };
if (fixtureMode) {
  try {
    const fixtureTools = require('./run-installer-hooks-fixture.cjs');
    fixtureTools.assertSentinel(fixtureManifest);
    if (fixtureManifest.profileSettingsSha256) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fixtureManifest.profileSettings)).digest('hex'), fixtureManifest.profileSettingsSha256, 'Existing isolated app profile changed during update');
    if (execution.status === 0 && !execution.error) {
      if (process.argv[6] === 'cancel') fixtureTools.assertNoInstallation(fixtureManifest);
      else {
        fixtureTools.assertPayload(fixtureManifest);
        const locale = { 2052: 'zh-CN', 1028: 'zh-TW', 1033: 'en-US', 1041: 'ja-JP', 1042: 'ko-KR' }[process.argv[5] || '1033'];
        fixtureTools.assertValue(fixtureManifest, 'Language', locale);
        artifactVerification.receiptLanguage = locale;
        artifactVerification.payloadSha256 = fixtureManifest.payloadSha256;
      }
      artifactVerification.checked = true;
    }
  } catch (error) { artifactVerification.error = error.message; }
}
const stdout = (execution.stdout || '').replace(/\r\n/g, '\n');
const stderr = (execution.stderr || '').replace(/\r\n/g, '\n');
fs.writeFileSync(path.join(fixture, 'stdout.txt'), stdout, 'utf8');
fs.writeFileSync(path.join(fixture, 'stderr.txt'), stderr, 'utf8');
const summary = {
  mode: fixtureMode ? `nsis-fixture-${process.argv[6] || 'install'}` : offscreenMode ? 'five-locale-offscreen-capture' : 'dll-functional',
  harnessSourceSha256,
  harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(fixture, 'harness.exe'))).digest('hex'),
  reusedHarness,
  dllSource: source,
  dllSha256,
  embeddedDllSha256: fixtureManifest?.dllSha256 || null,
  hooksSha256: fixtureManifest?.hooksSha256 || null,
  languageScriptSha256: fixtureManifest?.languageScriptSha256 || null,
  installerManifestDpiAware: fixtureManifest?.dpiAware ?? null,
  historicalBaseline: fixtureManifest?.historicalBaseline || null,
  fixture,
  fixtureExecutable,
  fixtureExecutableSha256: fixtureMode ? crypto.createHash('sha256').update(fs.readFileSync(fixtureExecutable)).digest('hex') : null,
  installPath,
  offscreenMode,
  status: execution.status,
  signal: execution.signal,
  error: execution.error?.message || null,
  artifactVerification,
  safetySentinelCount: safetySentinels.length,
  safetySentinelsPreserved: safetySentinels.every(({ file, content }) => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content),
  screenshots: fs.readdirSync(fixture).filter(name => name.endsWith('.png') && name !== 'icon.png'),
  wholeParentNativeSnapshots: fs.readdirSync(fixture).filter(name => name.endsWith('-native-windows.json')),
  isolation: `${offscreenMode ? 'Hidden Init, then offscreen (-20000,-20000) without activation; capture only' : 'Private desktop'}; fixture DLL copy; process-local 45-second watchdog; launcher 60-second child timeout.`,
  notCovered: ['Production installation and uninstall', 'Elevation', ...fixtureMode ? [] : ['NSIS engine integration'], 'Multi-monitor and non-current DPI', 'Global reduced-motion setting changes', 'Clipboard mutation'],
};
fs.writeFileSync(path.join(fixture, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
process.stdout.write(stdout);
process.stderr.write(stderr);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = execution.status === 0 && !execution.error && !artifactVerification.error && summary.safetySentinelsPreserved ? 0 : 1;
