const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const repo = path.resolve(__dirname, '..');
const cases = [
  ...[['normal', 10], ['hidden', 0], ['minimized', 2]]
    .map(([label, show]) => ({ name: 'inside-' + label, phase: 'inside', show, token: 'none', ready: true })),
  { name: 'token-valid', phase: 'inside', show: 0, token: 'valid', ready: true },
  { name: 'token-missing', phase: 'inside', show: 10, token: 'missing', ready: false },
  { name: 'token-expired', phase: 'inside', show: 0, token: 'expired', ready: false },
  { name: 'token-invalid', phase: 'inside', show: 10, token: 'invalid', ready: false },
  { name: 'worker-check', phase: 'inside', show: 10, token: 'none', ready: true },
];

describe('actual harmless NSIS readiness lifecycle on a private desktop', { skip: process.platform !== 'win32' }, () => {
  let root, host, fixture, environment, evidence, report;
  const inputs = ['build/installer.nsh', 'build/installer-ui.nsh', 'build/installer-ui/installer-skin.cpp', 'build/installer-ui/installer-skin.def',
    'build/installer-ui/installer-lifecycle.h', 'build/installer-ui/strings.json', 'tests/installer-ready-runtime.nsi', 'tests/native-installer-ready.cpp',
    'tests/installer-ready-native.test.cjs'];
  const hashes = () => Object.fromEntries(inputs.map(file => [file, sha(path.join(repo, file))]));
  function owned(file) { const p = path.relative(root, file); assert.ok(p && !p.startsWith('..') && !path.isAbsolute(p)); return file; }
  before(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'veylo-ready-lifecycle-test-'));
    evidence = process.env.VEYLO_READY_EVIDENCE_DIR || fs.mkdtempSync(path.join(repo, '.superpowers/nsis-ready-runtime-'));
    assert.ok(path.resolve(evidence).startsWith(path.join(repo, '.superpowers') + path.sep)); fs.mkdirSync(evidence, { recursive: true });
    const dllSource = path.resolve(process.env.VEYLO_READY_DLL || path.join(repo, 'build/generated/installer-ui/VeyloInstaller.dll'));
    report = { status: 'running', root, dllSource, dllSha256: sha(dllSource), before: hashes(), cases: [],
      scope: 'Real RequestExecutionLevel user NSIS dummy; no BeginInstall/customCheck/deployment/registry writes/UAC/Global/ProgramData.' };
    const resources = owned(path.join(root, 'resources')); const plugins = path.join(resources, 'generated/installer-ui');
    fs.mkdirSync(plugins, { recursive: true }); fs.copyFileSync(dllSource, path.join(plugins, 'VeyloInstaller.dll'));
    assert.equal(sha(path.join(plugins, 'VeyloInstaller.dll')), report.dllSha256);
    const resultDir = owned(path.join(root, 'results')); fs.mkdirSync(resultDir);
    const temporary = owned(path.join(root, 'temporary')); fs.mkdirSync(temporary);
    const appdata = owned(path.join(root, 'fake-appdata')); fs.mkdirSync(appdata);
    const programFiles = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
    const vswhere = path.join(programFiles, 'Microsoft Visual Studio/Installer/vswhere.exe');
    const studio = cp.execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath'], { windowsHide: true, encoding: 'utf8' }).trim();
    assert.ok(studio, 'MSVC x86 build tools are required for native readiness tests');
    const vcVersion = fs.readFileSync(path.join(studio, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), 'utf8').trim();
    const vc = path.join(studio, 'VC/Tools/MSVC', vcVersion);
    const sdk = process.env.WindowsSdkDir || path.join(programFiles, 'Windows Kits/10');
    const version = fs.readdirSync(path.join(sdk, 'Include')).filter(name => /^10[.][0-9]+[.][0-9]+[.][0-9]+$/.test(name)
      && fs.existsSync(path.join(sdk, 'Lib', name, 'ucrt/x86')) && fs.existsSync(path.join(sdk, 'Lib', name, 'um/x86')))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    assert.ok(version, 'A Windows SDK with x86 libraries is required');
    const compiler = path.join(vc, 'bin/Hostx64/x86/cl.exe');
    environment = { ...process.env, TEMP: temporary, TMP: temporary, APPDATA: appdata, VEYLO_UPDATE_LANGUAGE: 'en-US', VSCMD_SKIP_SENDTELEMETRY: '1',
      INCLUDE: [path.join(vc, 'include'), ...['ucrt', 'shared', 'um', 'winrt'].map(name => path.join(sdk, 'Include', version, name))].join(';'),
      LIB: [path.join(vc, 'lib/x86'), ...['ucrt', 'um'].map(name => path.join(sdk, 'Lib', version, name, 'x86'))].join(';'),
      PATH: [path.dirname(compiler), path.join(sdk, 'bin', version, 'x64'), process.env.PATH].join(';') };
    host = owned(path.join(root, 'ready-lifecycle-host.exe'));
    const compiled = cp.spawnSync(compiler, ['/nologo', '/utf-8', '/std:c++17', '/O2', '/MT', '/EHsc', '/DUNICODE', '/D_UNICODE',
      '/Fo' + path.join(root, 'host.obj'), path.join(repo, 'tests/native-installer-ready.cpp'), '/link', '/MANIFEST:EMBED',
      "/MANIFESTUAC:level='asInvoker' uiAccess='false'", '/OUT:' + host, 'user32.lib', 'ole32.lib'],
    { cwd: root, env: environment, windowsHide: true, encoding: 'utf8' });
    fs.writeFileSync(path.join(evidence, 'host-compile.log'), ((compiled.stdout || '') + (compiled.stderr || '')).replaceAll('\r', ''));
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis');
    const locate = (prefix, file) => fs.readdirSync(cache).filter(name => name.startsWith(prefix))
      .map(name => path.join(cache, name, file)).find(file => fs.existsSync(file));
    const makensis = locate('nsis-', 'Bin/makensis.exe'), stdutils = locate('nsis-resources-', 'plugins/x86-unicode/StdUtils.dll');
    fixture = owned(path.join(root, 'ready-runtime-fixture.exe'));
    const definitions = { PROJECT_DIR: repo, BUILD_RESOURCES_DIR: resources, FIXTURE_EXE: fixture, FIXTURE_INSTALL_DIR: path.join(root, 'never-installed'),
      FIXTURE_RESULT_ROOT: resultDir, FIXTURE_STDUTILS_DIR: path.dirname(stdutils), VEYLO_ICON_FILE: path.join(repo, 'assets/brand/icon-256.png') };
    const nsis = cp.spawnSync(makensis, ['/V3', '/INPUTCHARSET', 'UTF8', ...Object.entries(definitions).map(([key, value]) => '/D' + key + '=' + value),
      path.join(repo, 'tests/installer-ready-runtime.nsi')], { cwd: root, env: environment, windowsHide: true, encoding: 'utf8' });
    fs.writeFileSync(path.join(evidence, 'nsis-compile.log'), ((nsis.stdout || '') + (nsis.stderr || '')).replaceAll('\r', ''));
    assert.equal(nsis.status, 0, nsis.stdout + nsis.stderr);
  });
  after(() => {
    if (report) { report.after = hashes(); report.sourcesUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
      report.dllUnchanged = sha(report.dllSource) === report.dllSha256;
      report.status = report.sourcesUnchanged && report.dllUnchanged && report.cases.length === cases.length && report.cases.every(item => item.passed) ? 'passed' : 'failed';
      fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      assert.ok(report.sourcesUnchanged, 'Fixture and production inputs changed during verification');
      assert.ok(report.dllUnchanged, 'The DLL input changed during verification'); }
    if (root) { const real = fs.realpathSync.native(root); assert.equal(real.toLowerCase(), root.toLowerCase()); fs.rmSync(real, { recursive: true, maxRetries: 10, retryDelay: 100 }); }
  });
  for (const spec of cases) test(spec.name, t => {
    const ran = cp.spawnSync(host, [root, fixture, spec.name, spec.phase, String(spec.show), spec.token],
      { cwd: root, env: environment, windowsHide: true, encoding: 'utf8', timeout: 20000 });
    const entry = { ...spec, status: ran.status, error: ran.error?.message || null, stdout: ran.stdout, stderr: ran.stderr, passed: false };
    report.cases.push(entry);
    assert.equal(ran.error, undefined, ran.error?.message); assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    entry.native = JSON.parse(ran.stdout.trim());
    const output = path.join(root, 'results', spec.name + '.json'); assert.ok(fs.existsSync(output));
    entry.lifecycle = JSON.parse(fs.readFileSync(output, 'utf8'));
    const diagnostic = { ...entry }; delete diagnostic.passed; t.diagnostic(JSON.stringify(diagnostic));
    assert.equal(Number(entry.lifecycle.startupFlags) & 1, 1, 'STARTF_USESHOWWINDOW must reach actual NSIS');
    assert.equal(Number(entry.lifecycle.startupShow), spec.show, 'The actual NSIS startup show flag must match the scenario');
    assert.equal(entry.lifecycle.configure, spec.token === 'invalid' ? 'error' : 'ok');
    assert.equal(entry.lifecycle.gui, spec.ready ? 'ok' : 'error'); assert.equal(entry.lifecycle.page, spec.ready ? 'ok' : 'error');
    if (spec.ready) { assert.equal(entry.lifecycle.visible, '1'); assert.equal(entry.lifecycle.iconic, '0'); }
    assert.equal(entry.native.eventSignaled, spec.token === 'valid'); assert.equal(entry.native.missingEventRecreated, false);
    assert.equal(entry.lifecycle.guiThread, entry.lifecycle.pageThread); assert.notEqual(entry.lifecycle.guiThread, entry.lifecycle.workerThread);
    if (spec.name === 'worker-check') assert.equal(entry.lifecycle.workerReady, 'error');
    entry.passed = true;
  });
});
