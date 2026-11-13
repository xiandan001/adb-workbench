const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), os = require('node:os'), crypto = require('node:crypto');
const repo = path.resolve(__dirname, '..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const native = process.platform === 'win32';
let root, host, report, evidence, dllSource, environment;
const inputs = ['tests/native-installer-button-paint.cpp', 'tests/installer-button-paint-native.test.cjs'];
const hashes = () => Object.fromEntries(inputs.map(name => [name, hash(path.join(repo, name))]));
before(() => {
  if (!native) return;
  root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'veylo-button-paint-test-'));
  evidence = process.env.VEYLO_BUTTON_PAINT_EVIDENCE_DIR || fs.mkdtempSync(path.join(repo, '.superpowers/button-paint-proof-'));
  assert.ok(path.resolve(evidence).startsWith(path.join(repo, '.superpowers') + path.sep)); fs.mkdirSync(evidence, { recursive: true });
  dllSource = path.resolve(process.env.VEYLO_BUTTON_PAINT_DLL || path.join(repo, 'build/generated/installer-ui/VeyloInstaller.dll'));
  report = { status: 'running', root, dllSource, dllSha256: hash(dllSource), before: hashes(), cases: [],
    coverage: { productionInstaller: false, globalGuard: false, systemDpiChanged: false, privateDesktop: true, preCaptureForcedRedraw: false,
      preCaptureInput: false, naturalDrawHdcSample: true, retainedClientDcObservationOnly: true, additionalDpiCoverageClaimed: false } };
  fs.copyFileSync(dllSource, path.join(root, 'VeyloInstaller.dll')); fs.copyFileSync(path.join(repo, 'assets/brand/icon-256.png'), path.join(root, 'icon.png'));
  assert.equal(hash(path.join(root, 'VeyloInstaller.dll')), report.dllSha256);
  const programFiles = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const studio = cp.execFileSync(path.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe'), ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true, encoding: 'utf8' }).trim();
  assert.ok(studio, 'MSVC x86 build tools required');
  const version = fs.readFileSync(path.join(studio, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), 'utf8').trim();
  const vc = path.join(studio, 'VC/Tools/MSVC', version), sdk = process.env.WindowsSdkDir || path.join(programFiles, 'Windows Kits/10');
  const sdkVersion = fs.readdirSync(path.join(sdk, 'Include')).filter(name => /^10[.][0-9]+[.][0-9]+[.][0-9]+$/.test(name)
    && fs.existsSync(path.join(sdk, 'Lib', name, 'ucrt/x86')) && fs.existsSync(path.join(sdk, 'Lib', name, 'um/x86')))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  assert.ok(sdkVersion, 'Windows SDK x86 libraries required');
  const compiler = path.join(vc, 'bin/Hostx64/x86/cl.exe');
  environment = { ...process.env, VSCMD_SKIP_SENDTELEMETRY: '1', VEYLO_UPDATE_LANGUAGE: '',
    INCLUDE: [path.join(vc, 'include'), ...['ucrt', 'shared', 'um', 'winrt'].map(name => path.join(sdk, 'Include', sdkVersion, name))].join(';'),
    LIB: [path.join(vc, 'lib/x86'), ...['ucrt', 'um'].map(name => path.join(sdk, 'Lib', sdkVersion, name, 'x86'))].join(';'),
    PATH: [path.dirname(compiler), path.join(sdk, 'bin', sdkVersion, 'x64'), process.env.PATH].join(';') };
  host = path.join(root, 'button-paint-host.exe');
  const compiled = cp.spawnSync(compiler, ['/nologo', '/utf-8', '/std:c++17', '/O2', '/MT', '/EHsc', '/DUNICODE', '/D_UNICODE',
    '/Fo' + path.join(root, 'paint.obj'), path.join(repo, 'tests/native-installer-button-paint.cpp'), '/link', '/MANIFEST:EMBED',
    "/MANIFESTUAC:level='asInvoker' uiAccess='false'", '/OUT:' + host, 'user32.lib', 'gdi32.lib', 'comctl32.lib'],
  { cwd: root, env: environment, windowsHide: true, encoding: 'utf8' });
  fs.writeFileSync(path.join(evidence, 'compile.log'), ((compiled.stdout || '') + (compiled.stderr || '')).replaceAll('\r', ''));
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});
after(() => {
  if (report) {
    report.after = hashes(); report.sourcesUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
    report.dllUnchanged = hash(dllSource) === report.dllSha256;
    report.status = report.sourcesUnchanged && report.dllUnchanged && report.cases.length === 5 && report.cases.every(item => item.passed) ? 'passed' : 'failed';
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    assert.ok(report.sourcesUnchanged); assert.ok(report.dllUnchanged);
  }
  if (root) { assert.equal(fs.realpathSync.native(root).toLowerCase(), root.toLowerCase()); fs.rmSync(root, { recursive: true, maxRetries: 10, retryDelay: 100 }); }
});
for (const locale of [2052, 1028, 1033, 1041, 1042]) test('owner-drawn button background and untouched state frames: ' + locale, { skip: !native }, t => {
  const result = cp.spawnSync(host, [root, String(locale)], { cwd: root, env: environment, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  const entry = { locale, status: result.status, error: result.error?.message || null, stdout: result.stdout, stderr: result.stderr, passed: false }; report.cases.push(entry);
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  entry.result = JSON.parse(result.stdout); t.diagnostic(JSON.stringify(entry.result));
  assert.equal(entry.result.privateDesktopVerified, true); assert.ok(entry.result.actualWindowDpi >= 96);
  assert.equal(entry.result.engineDisabledMirrored, true); assert.equal(entry.result.engineEnabledMirrored, true);
  for (const stage of entry.result.stages) {
    assert.ok(stage.naturalDraws > 0, stage.name + ': natural production draw occurred');
    assert.ok(stage.drawHdc.total > 1000 && stage.drawHdc.ink > 5, stage.name + ': real text/border pixels, not blank black capture');
    assert.ok(stage.drawHdc.black / stage.drawHdc.total > 0.65, stage.name + ': black button background');
    assert.ok(stage.drawHdc.white / stage.drawHdc.total < 0.3, stage.name + ': no solid white rectangle');
    assert.equal(Boolean(stage.itemState & 4), stage.name === 'disabled', stage.name + ': actual ODS_DISABLED');
  }
  assert.equal(entry.result.backgroundBrushColor, 0, 'owner-drawn erase uses the owned black brush, not the default system face');
  assert.notEqual(entry.result.eraseResult, 0); assert.equal(entry.result.eraseColor, 0, 'actual BUTTON background erase fills black');
  entry.passed = true;
});
