const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = path.join(root, '.superpowers');
fs.mkdirSync(scratch, { recursive: true });
const output = fs.mkdtempSync(path.join(scratch, 'harmony-native-test-'));
const source = path.join(__dirname, 'harmony-media-fragments.cpp');
const executable = path.join(output, process.platform === 'win32' ? 'fragments.exe' : 'fragments');
const run = (file, args) => cp.execFileSync(file, args, { cwd: root, windowsHide: true, stdio: 'inherit', timeout: 60000 });
if (process.platform === 'win32') {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const vs = cp.execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
  if (!vs) throw new Error('C++ host compiler is required for native fragment tests.');
  const vcvars = path.join(vs, 'VC/Auxiliary/Build/vcvarsall.bat');
  cp.execSync(`call "${vcvars}" x64 >nul && cl.exe /nologo /utf-8 /std:c++17 /W4 /WX /EHsc /MT /Fo"${path.join(output, 'fragments.obj')}" "${source}" /link /OUT:"${executable}"`,
    { cwd: root, windowsHide: true, stdio: 'inherit', timeout: 60000 });
} else run(process.env.CXX || 'c++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', source, '-o', executable]);
run(executable, []);
console.log(JSON.stringify({ passed: true, executable, deviceCalls: 0 }));
