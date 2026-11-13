const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');

const repo = path.resolve(__dirname, '..');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cases = [
  { id: 'normal-zh-CN', name: 'inside-normal', show: 10, token: 'none', locale: 2052 },
  { id: 'update-zh-CN', name: 'token-valid', show: 0, token: 'valid', locale: 2052 },
  { id: 'update-en-US', name: 'token-valid', show: 0, token: 'valid', locale: 1033 },
];

describe('unmodified real NSIS parent protects wait-stage button pixels', { skip: process.platform !== 'win32' }, () => {
  let root, host, evidence, environment, report, dllSource;
  const inputs = ['tests/installer-parent-paint-runtime.nsi', 'tests/native-installer-parent-paint.cpp',
    'tests/installer-parent-paint-native.test.cjs', 'tests/native-installer-ready.cpp', 'build/installer.nsh', 'build/installer-ui.nsh'];
  const hashes = () => Object.fromEntries(inputs.map(file => [file, sha(path.join(repo, file))]));
  const command = (file, args, cwd, log) => {
    const result = cp.spawnSync(file, args, { cwd, env: environment, windowsHide: true, encoding: 'utf8' });
    fs.writeFileSync(path.join(evidence, log), ((result.stdout || '') + (result.stderr || '')).replaceAll('\r', ''));
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  before(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'veylo-ready-lifecycle-test-'));
    evidence = process.env.VEYLO_PARENT_PAINT_EVIDENCE_DIR || fs.mkdtempSync(path.join(repo, '.superpowers/nsis-parent-paint-'));
    assert.ok(path.resolve(evidence).startsWith(path.join(repo, '.superpowers') + path.sep)); fs.mkdirSync(evidence, { recursive: true });
    dllSource = path.resolve(process.env.VEYLO_PARENT_PAINT_DLL || path.join(repo, 'build/generated/installer-ui/VeyloInstaller.dll'));
    report = { status: 'running', root, dllSource, dllSha256: sha(dllSource), before: hashes(), cases: [],
      coverage: { realNsisMUI: true, originalHostClipRequiredAbsent: true, fixtureAddsParentClip: false,
        observerChangesStylesBeforeFrames: false, callbackPixelSampling: false, callbackGdiFlush: false,
        forcedRedraw: false, inputBeforeFrames: false, privateDesktop: true, productionInstaller: false, uac: false,
        renderingLocaleExplicit: true, tokenLanguageHandoffTestedSeparately: true,
        visibleDesktopPresentedFrameClaimed: false, snapshotBitBltGdiFlushAcknowledged: true } };
    const resources = path.join(root, 'resources'), plugins = path.join(resources, 'generated/installer-ui');
    fs.mkdirSync(plugins, { recursive: true }); fs.copyFileSync(dllSource, path.join(plugins, 'VeyloInstaller.dll'));
    assert.equal(sha(path.join(plugins, 'VeyloInstaller.dll')), report.dllSha256);
    const appdata = path.join(root, 'fake-appdata'), temporary = path.join(root, 'temporary');
    fs.mkdirSync(appdata); fs.mkdirSync(temporary);
    const pf = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
    const studio = cp.execFileSync(path.join(pf, 'Microsoft Visual Studio/Installer/vswhere.exe'),
      ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
      { windowsHide: true, encoding: 'utf8' }).trim();
    assert.ok(studio, 'MSVC x86 Build Tools required');
    const vcVersion = fs.readFileSync(path.join(studio, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), 'utf8').trim();
    const vc = path.join(studio, 'VC/Tools/MSVC', vcVersion), sdk = process.env.WindowsSdkDir || path.join(pf, 'Windows Kits/10');
    const sdkVersion = fs.readdirSync(path.join(sdk, 'Include')).filter(name => /^10[.][0-9]+[.][0-9]+[.][0-9]+$/.test(name)
      && fs.existsSync(path.join(sdk, 'Lib', name, 'um/x86')) && fs.existsSync(path.join(sdk, 'Lib', name, 'ucrt/x86')))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    assert.ok(sdkVersion, 'Windows SDK with x86 libraries required');
    const compiler = path.join(vc, 'bin/Hostx64/x86/cl.exe');
    environment = { ...process.env, APPDATA: appdata, TEMP: temporary, TMP: temporary, VEYLO_UPDATE_LANGUAGE: 'en-US', VSCMD_SKIP_SENDTELEMETRY: '1', VSLANG: '1033',
      INCLUDE: [path.join(vc, 'include'), ...['ucrt', 'shared', 'um', 'winrt'].map(name => path.join(sdk, 'Include', sdkVersion, name))].join(';'),
      LIB: [path.join(vc, 'lib/x86'), ...['ucrt', 'um'].map(name => path.join(sdk, 'Lib', sdkVersion, name, 'x86'))].join(';'),
      PATH: [path.dirname(compiler), path.join(sdk, 'bin', sdkVersion, 'x64'), process.env.PATH].join(';') };
    host = path.join(root, 'parent-paint-host.exe');
    const common = ['/nologo', '/utf-8', '/std:c++17', '/O2', '/MT', '/EHsc', '/DUNICODE', '/D_UNICODE'];
    command(compiler, [...common, '/Fo' + path.join(root, 'host.obj'), path.join(repo, 'tests/native-installer-ready.cpp'), '/link',
      '/MANIFEST:EMBED', "/MANIFESTUAC:level='asInvoker' uiAccess='false'", '/OUT:' + host, 'user32.lib', 'ole32.lib'], root, 'host-compile.log');
    const definitionsFile = path.join(root, 'observer.def');
    fs.writeFileSync(definitionsFile, 'LIBRARY ParentPaint\nEXPORTS\n  Init=ParentPaintInit\n  Snapshot=ParentPaintSnapshot\n  Finish=ParentPaintFinish\n');
    command(compiler, [...common, '/LD', '/Fo' + path.join(root, 'observer.obj'), path.join(repo, 'tests/native-installer-parent-paint.cpp'), '/link',
      '/DEF:' + definitionsFile,
      '/OUT:' + path.join(plugins, 'ParentPaint.dll'), 'user32.lib', 'gdi32.lib', 'comctl32.lib'], root, 'observer-compile.log');
    const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis');
    const locate = (prefix, suffix) => fs.readdirSync(cache).filter(name => name.startsWith(prefix))
      .map(name => path.join(cache, name, suffix)).find(file => fs.existsSync(file));
    const makensis = locate('nsis-', 'Bin/makensis.exe'), stdutils = locate('nsis-resources-', 'plugins/x86-unicode/StdUtils.dll');
    assert.ok(makensis && stdutils, 'Electron Builder NSIS compiler/resources required');
    for (const spec of cases) {
      const directory = path.join(root, spec.id); fs.mkdirSync(directory);
      const results = path.join(directory, 'results'); fs.mkdirSync(results);
      spec.directory = directory; spec.results = results; spec.fixture = path.join(directory, 'ready-runtime-fixture.exe');
      const defines = { PROJECT_DIR: repo, BUILD_RESOURCES_DIR: resources, FIXTURE_EXE: spec.fixture, FIXTURE_INSTALL_DIR: path.join(directory, 'never-installed'),
        FIXTURE_RESULT_ROOT: results, FIXTURE_LANGUAGE_ID: String(spec.locale), FIXTURE_STDUTILS_DIR: path.dirname(stdutils), VEYLO_ICON_FILE: path.join(repo, 'assets/brand/icon-256.png') };
      command(makensis, ['/V3', '/INPUTCHARSET', 'UTF8', ...Object.entries(defines).map(([key, value]) => '/D' + key + '=' + value),
        path.join(repo, 'tests/installer-parent-paint-runtime.nsi')], directory, spec.id + '-compile.log');
    }
  });
  after(() => {
    if (report) {
      report.after = hashes(); report.sourcesUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
      report.dllUnchanged = sha(dllSource) === report.dllSha256;
      report.status = report.sourcesUnchanged && report.dllUnchanged && report.cases.length === cases.length && report.cases.every(item => item.passed) ? 'passed' : 'failed';
      fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      assert.ok(report.sourcesUnchanged); assert.ok(report.dllUnchanged);
    }
    if (root) { assert.equal(fs.realpathSync.native(root).toLowerCase(), root.toLowerCase()); fs.rmSync(root, { recursive: true, maxRetries: 10, retryDelay: 100 }); }
  });
  for (const spec of cases) test(spec.id, t => {
    const ran = cp.spawnSync(host, [root, spec.fixture, spec.name, 'inside', String(spec.show), spec.token],
      { cwd: root, env: environment, windowsHide: true, encoding: 'utf8', timeout: 20000 });
    const entry = { id: spec.id, status: ran.status, error: ran.error?.message || null, stdout: ran.stdout, stderr: ran.stderr, passed: false };
    report.cases.push(entry); assert.equal(ran.error, undefined); assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    entry.native = JSON.parse(ran.stdout); entry.lifecycle = JSON.parse(fs.readFileSync(path.join(spec.results, 'result.json'), 'utf8'));
    const trace = fs.readFileSync(path.join(spec.results, 'paint.jsonl'), 'utf8');
    fs.writeFileSync(path.join(evidence, spec.id + '.jsonl'), trace);
    entry.trace = trace.trim().split(/\r?\n/).map(line => JSON.parse(line)); t.diagnostic(JSON.stringify(entry));
    assert.equal(entry.native.privateDesktop, true); assert.equal(entry.native.eventSignaled, spec.token === 'valid');
    assert.equal(entry.lifecycle.originalParentClip, '0', 'The actual NSIS host must not be silently pre-clipped by the fixture');
    assert.equal(entry.lifecycle.gui, 'ok'); assert.equal(entry.lifecycle.page, 'ok'); assert.equal(entry.lifecycle.finish, 'ok');
    assert.equal(Number(entry.lifecycle.language), spec.locale);
    const frames = entry.trace.filter(row => row.phase !== 'disposed'); assert.deepEqual(frames.map(row => row.phase), ['0', '1', '4']);
    for (const frame of frames) {
      assert.equal(frame.thread, frame.ownerThread); assert.match(frame.desktop, /^VeyloReadyRuntime-/); assert.ok(frame.dpi >= 96);
      assert.equal(frame.parentClipChildren, 1, 'Production Init must add missing parent child clipping');
      assert.equal(frame.buttons.length, 2);
      for (const button of frame.buttons) {
        assert.equal(button.type, 11); assert.equal(button.visible, 1); assert.equal(button.parentDcCovers, 0, 'Parent painting DC excludes owned button areas');
        const p = button.pixels; assert.equal(p.copied, 1); assert.ok(p.total >= 1000 && p.ink > 5, 'Black with real text, not a blank capture');
        assert.ok(p.black / p.total > 0.65); assert.ok(p.white / p.total < 0.3);
      }
    }
    const disposed = entry.trace.find(row => row.phase === 'disposed'); assert.ok(disposed);
    assert.equal(disposed.thread, frames[0].ownerThread); assert.equal(disposed.beforeClip, 1); assert.equal(disposed.afterClip, 0);
    assert.notEqual(disposed.unrelatedBefore, disposed.unrelatedChanged); assert.equal(disposed.unrelatedAfter, disposed.unrelatedChanged);
    entry.passed = true;
  });
});
