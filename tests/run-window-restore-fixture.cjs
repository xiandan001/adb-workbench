const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
assert.equal(process.platform, 'win32');
const fixture = fs.mkdtempSync(path.join(root, '.superpowers/window-restore-fixture-'));
const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe');
const vs = cp.execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true, encoding: 'utf8' }).trim();
const native = path.join(fixture, 'window-restore-native.exe');
const command = `call "${path.join(vs, 'VC/Auxiliary/Build/vcvarsall.bat')}" x64 >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /DUNICODE /D_UNICODE /Fo"${path.join(fixture, 'native.obj')}" "${path.join(__dirname, 'window-restore-native.cpp')}" /link /OUT:"${native}" user32.lib`;
cp.execFileSync(process.env.ComSpec, ['/d', '/s', '/c', `"${command}"`], { cwd: fixture, windowsHide: true, windowsVerbatimArguments: true, stdio: 'inherit', timeout: 120000 });
const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
const electron = path.join(root, '.electron-cache/electron/electron.exe');
const result = cp.spawnSync(native, [electron, path.join(__dirname, 'window-restore-fixture.cjs'), fixture, native],
  { cwd: fixture, windowsHide: true, env: environment, timeout: 95000, encoding: 'utf8' });
console.log(JSON.stringify({ fixture, status: result.status, error: result.error?.message || null, report: path.join(fixture, 'report.json') }, null, 2));
if (result.stdout) console.log(result.stdout); if (result.stderr) console.error(result.stderr);
assert.equal(result.status, 0); assert.equal(result.error, undefined);
