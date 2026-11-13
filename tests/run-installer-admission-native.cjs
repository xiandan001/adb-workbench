const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

assert.equal(process.platform, 'win32');
const repo = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(repo, '.superpowers/installer-admission-native-'));
const relative = path.relative(path.join(repo, '.superpowers'), fs.realpathSync.native(output));
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
const source = path.join(repo, 'build/installer-ui');
fs.writeFileSync(path.join(output, 'installer-strings.generated.h'),
  require('../scripts/build-installer-ui.cjs').compileStrings(JSON.parse(fs.readFileSync(path.join(source, 'strings.json'), 'utf8'))));
const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
const visualStudio = cp.execFileSync(vswhere, ['-latest', '-products', '*', '-requires',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true, encoding: 'utf8' }).trim();
assert.ok(visualStudio);
const executable = path.join(output, 'native-installer-admission.exe');
const command = `call "${path.join(visualStudio, 'VC/Auxiliary/Build/vcvarsall.bat')}" x86 >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /DUNICODE /D_UNICODE /DVEYLO_INSTALLER_LIFECYCLE_TEST /I"${output}" "${path.join(__dirname, 'native-installer-admission.cpp')}" "${path.join(source, 'installer-skin.cpp')}" /link /MANIFEST:EMBED /MANIFESTUAC:"level='asInvoker' uiAccess='false'" /OUT:"${executable}" user32.lib gdi32.lib comctl32.lib gdiplus.lib ole32.lib shell32.lib uuid.lib`;
cp.execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
  cwd: output, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8',
  env: { ...process.env, VSCMD_SKIP_SENDTELEMETRY: '1' },
});
const token = crypto.randomBytes(16).toString('hex');
const cases = [[], ['--updated', `--veylo-ready-token=${token}`, '--veylo-update-pid=123', '--veylo-language=en-US']].map(args => {
  const actual = cp.spawnSync(executable, args, { cwd: output, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(actual.error, undefined);
  assert.equal(actual.status, 0, `${actual.stdout}\n${actual.stderr}`);
  return { tokenProvided: args.length > 0, status: actual.status, stdout: actual.stdout.replaceAll('\r', '') };
});
const report = { output, status: 'passed', cases,
  isolation: 'Actual plugin code compiled with lifecycle TEST guard; no GUI, Global mutex, ProgramData, registry or installer execution.' };
fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
