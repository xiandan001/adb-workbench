const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

describe('native installer lifecycle in owned temporary namespaces', { skip: process.platform !== 'win32' }, () => {
  let root;
  let temporaryParent;
  let executable;
  function owned(target) {
    const relative = path.relative(root, target);
    assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    return target;
  }
  before(() => {
    temporaryParent = fs.realpathSync.native(os.tmpdir());
    root = fs.mkdtempSync(path.join(temporaryParent, 'veylo-native-lifecycle-test-'));
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
    const visualStudio = cp.execFileSync(vswhere, ['-latest', '-products', '*', '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true, encoding: 'utf8' }).trim();
    assert.ok(visualStudio, 'MSVC is required for actual native lifecycle tests');
    executable = owned(path.join(root, 'native-installer-lifecycle.exe'));
    const object = owned(path.join(root, 'native-installer-lifecycle.obj'));
    const source = path.join(__dirname, 'native-installer-lifecycle.cpp');
    const command = `call "${path.join(visualStudio, 'VC/Auxiliary/Build/vcvarsall.bat')}" x64 >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /DUNICODE /D_UNICODE /Fo"${object}" "${source}" /link /OUT:"${executable}"`;
    cp.execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`],
      { cwd: root, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8', env: { ...process.env, VSCMD_SKIP_SENDTELEMETRY: '1' } });
  });
  after(() => {
    if (!root) return;
    assert.equal(fs.realpathSync.native(root).toLowerCase(), root.toLowerCase());
    const relative = path.relative(temporaryParent, root);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(root, { recursive: true, maxRetries: 10, retryDelay: 100 });
  });
  function scope(label) {
    const directory = owned(path.join(root, label));
    fs.mkdirSync(directory);
    return { directory, mutex: `Local\\Veylo.InstallFixture.${crypto.randomBytes(16).toString('hex')}` };
  }
  function run(mode, fixture) {
    owned(fs.realpathSync.native(executable));
    owned(fs.realpathSync.native(fixture.directory));
    assert.ok(fixture.mutex.startsWith('Local\\Veylo.InstallFixture.'));
    const actual = cp.spawnSync(executable, [mode, fixture.directory, fixture.mutex],
      { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    assert.equal(actual.error, undefined, actual.error?.message);
    assert.equal(actual.status, 0, `${actual.stdout}\n${actual.stderr}`);
    return actual.stdout;
  }
  test('strict ready handoff, protected marker and cross-thread guard lifetime use actual Win32 objects', t => {
    const output = run('--normal', scope('normal'));
    t.diagnostic(output.trim());
    assert.match(output, /RESULT \d+ lifecycle checks passed/);
    assert.match(output, /authenticated users have only SYNCHRONIZE/);
    assert.match(output, /a different UI thread/);
  });
  test('crash removes the owned mutex while stale marker recovery remains possible', t => {
    const fixture = scope('crash');
    const crash = run('--crash', fixture), stale = run('--stale', fixture);
    t.diagnostic(crash.trim()); t.diagnostic(stale.trim());
    assert.match(crash, /owned crash fixture starts deployment/);
    assert.match(stale, /stale marker is not evidence/);
    assert.equal(fs.existsSync(path.join(fixture.directory, 'Veylo/adb-workbench/install-active.json')), false);
  });
  test('precreated broadly writable directories are rejected without changing their contents', t => {
    const fixture = scope('unsafe');
    fs.mkdirSync(owned(path.join(fixture.directory, 'Veylo')));
    const personal = owned(path.join(fixture.directory, 'Veylo/personal.txt'));
    fs.writeFileSync(personal, 'owned fixture contents\n');
    t.diagnostic(run('--reject', fixture).trim());
    assert.equal(fs.readFileSync(personal, 'utf8'), 'owned fixture contents\n');
    assert.equal(fs.existsSync(path.join(fixture.directory, 'Veylo/adb-workbench')), false);
  });
  test('an owned junction cannot redirect marker writes into another fixture directory', t => {
    const fixture = scope('reparse');
    const destination = owned(path.join(root, 'redirect-destination'));
    fs.mkdirSync(destination);
    fs.symlinkSync(destination, owned(path.join(fixture.directory, 'Veylo')), 'junction');
    t.diagnostic(run('--reject', fixture).trim());
    assert.deepEqual(fs.readdirSync(destination), []);
  });
});
