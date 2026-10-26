const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'];
function compileStrings(catalog) {
  assert.deepEqual(Object.keys(catalog).sort(), [...LOCALES].sort(), 'Installer requires all five languages');
  const keys = Object.keys(catalog['zh-CN']);
  const literal = value => 'L' + JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(catalog[locale]).sort(), [...keys].sort(), `Installer keys: ${locale}`);
    for (const key of keys) assert.ok(typeof catalog[locale][key] === 'string' && catalog[locale][key].trim() && catalog[locale][key].length <= 2000, `Installer copy: ${locale}/${key}`);
  }
  return '// Generated from strings.json; do not edit.\n'
    + `static const wchar_t* const kSkinStringKeys[] = {${keys.map(literal).join(',')}};\n`
    + `static const wchar_t* const kSkinStrings[5][${keys.length}] = {\n${LOCALES.map(locale => `{${keys.map(key => literal(catalog[locale][key])).join(',')}}`).join(',\n')}\n};\n`
    + `static constexpr size_t kSkinStringCount = ${keys.length};\n`;
}
function build() {
  assert.equal(process.platform, 'win32', 'Build the native Windows installer skin on Windows');
  const source = path.join(ROOT, 'build/installer-ui');
  const output = path.join(ROOT, 'build/generated/installer-ui');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'installer-strings.generated.h'), compileStrings(JSON.parse(fs.readFileSync(path.join(source, 'strings.json'), 'utf8'))), 'utf8');
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe');
  const visualStudio = cp.execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.ok(visualStudio && fs.existsSync(visualStudio), 'MSVC x86 Build Tools are required');
  const vcvars = path.join(visualStudio, 'VC/Auxiliary/Build/vcvarsall.bat');
  const command = `call "${vcvars}" x86 >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /LD /DUNICODE /D_UNICODE /I"${output}" /Fo"${path.join(output, 'installer-skin.obj')}" "${path.join(source, 'installer-skin.cpp')}" /link /DEF:"${path.join(source, 'installer-skin.def')}" /OUT:"${path.join(output, 'VeyloInstaller.dll')}" user32.lib gdi32.lib comctl32.lib gdiplus.lib ole32.lib shell32.lib uuid.lib`;
  cp.execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: output, windowsHide: true, windowsVerbatimArguments: true, stdio: 'inherit', timeout: 120000 });
  const binary = fs.readFileSync(path.join(output, 'VeyloInstaller.dll'));
  assert.equal(binary.readUInt16LE(binary.readUInt32LE(0x3c) + 4), 0x14c, 'NSIS skin must be x86');
  console.log('Native installer skin built (x86, static CRT, five languages).');
}
if (require.main === module) { try { build(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { compileStrings };
