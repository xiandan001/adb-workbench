const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { compileStrings } = require('../scripts/build-installer-ui.cjs');

test('independent native wait helper validates protocol, read-only Local mutexes, safe launch and five-language hidden painting', { skip: process.platform !== 'win32' }, () => {
  const temporaryParent = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryParent, 'veylo-wait-native-test-'));
  const output = path.resolve(__dirname, '../output/playwright/native-install-wait-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(output, { recursive: true });
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const sources = ['../build/installer-ui/installer-wait.cpp', '../build/installer-ui/installer-wait-policy.h', '../build/installer-ui/strings.json', 'native-installer-wait.cpp', 'installer-wait-native.test.cjs'];
  const report = { status: 'running', output, inputs: sources.map(file => ({ file, sha256: hash(path.resolve(__dirname, file)) })),
    coverage: { actualWin32: true, x86: true, staticCRT: true, asInvokerManifest: true, privateDesktop: true, switchDesktop: false,
      actualOwnedTargetCreateProcess: true, testLocalMutexOnly: true, realGlobalMutexOrProgramData: false, realAppOrInstaller: false, UAC: false } };
  const owned = file => { const relative = path.relative(directory, path.resolve(file)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); return file; };
  try {
    fs.writeFileSync(owned(path.join(directory, 'installer-strings.generated.h')), compileStrings(require('../build/installer-ui/strings.json')));
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
    const visualStudio = cp.execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
    const executable = owned(path.join(directory, 'native-wait-fixture.exe'));
    const command = `call "${path.join(visualStudio, 'VC/Auxiliary/Build/vcvarsall.bat')}" x86 >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /DUNICODE /D_UNICODE /I"${directory}" /Fo"${owned(path.join(directory, 'fixture.obj'))}" "${path.join(__dirname, 'native-installer-wait.cpp')}" /link /OUT:"${executable}" /MANIFEST:EMBED /MANIFESTUAC:"level='asInvoker' uiAccess='false'" user32.lib gdi32.lib shell32.lib crypt32.lib gdiplus.lib`;
    cp.execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: directory, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 120000 });
    report.binarySha256 = hash(executable);
    const result = cp.spawnSync(executable, [directory, output], { cwd: directory, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    fs.writeFileSync(path.join(output, 'native-output.txt'), result.stdout || '');
    assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, (result.stdout || '') + (result.stderr || ''));
    assert.match(result.stdout, /RESULT \d+ native wait checks passed/);
    assert.equal(fs.readdirSync(output).filter(file => file.endsWith('.png')).length, 7);
    report.checks = Number(result.stdout.match(/RESULT (\d+) native wait checks passed/)[1]);
    report.screenshots = fs.readdirSync(output).filter(file => file.endsWith('.png')).map(file => ({ file, sha256: hash(path.join(output, file)) }));
    for (const input of report.inputs) assert.equal(hash(path.resolve(__dirname, input.file)), input.sha256, 'Frozen native input unchanged');
    report.status = 'passed';
    console.log(JSON.stringify({ output, native: result.stdout.trim() }));
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; throw error;
  } finally {
    assert.equal(fs.realpathSync.native(directory).toLowerCase(), directory.toLowerCase());
    const relative = path.relative(temporaryParent, directory); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(directory, { recursive: true, maxRetries: 10, retryDelay: 100 });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
});
