const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const script = path.join(root, 'build/installer-language.ps1');
const hooks = fs.readFileSync(path.join(root, 'build/installer-ui.nsh'), 'utf8');
// These cases verify parser semantics, not a performance deadline. Concurrent
// packaging can delay starting PowerShell; real NSIS tests retain its 5s budget.
const PARSER_TEST_TIMEOUT_MS = 15000;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-upgrade-language-'));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings-with-'quote.json");
  return { file, read(content, filePath = file) {
    if (content !== undefined) fs.writeFileSync(file, content);
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const result = cp.spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true, timeout: PARSER_TEST_TIMEOUT_MS, encoding: 'utf8', env: { ...process.env, VEYLO_INSTALLER_SETTINGS_FILE: filePath } });
    assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stderr, '');
    if (before) assert.ok(fs.readFileSync(file).equals(before), 'Profile must remain byte-identical');
    return result.stdout;
  } };
}

test('upgrade profile script accepts only five canonical locale strings and never exposes other settings', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR']) {
    const body = JSON.stringify({ locale, token: 'PRIVATE_FIXTURE_NEVER_OUTPUT', path: 'SENSITIVE_FIXTURE_PATH', nested: { locale: 'wrong' } });
    assert.equal(f.read(body), locale);
  }
});

test('old updater profile read handles BOM and fails closed on malformed, unsupported and oversized settings', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  assert.equal(f.read('\uFEFF{"locale":"zh-CN"}'), 'zh-CN');
  for (const body of ['{', '{}', 'null', '{"locale":"EN-US"}', '{"locale":"en"}', '{"locale":"fr-FR"}',
    '{"locale":123}', '{"locale":["zh-CN"]}', '[{"locale":"zh-CN"}]', '{"locale":"zh-CN; Write-Output private"}',
    Buffer.from([0xff, 0xfe, 0xfd]), JSON.stringify({ locale: 'zh-CN', large: 'x'.repeat(262144) })]) {
    assert.equal(f.read(body), '');
  }
  assert.equal(f.read(undefined, path.join(path.dirname(f.file), 'missing.json')), '');
  assert.equal(f.read(undefined, 'relative-settings.json'), '');
});

test('NSIS keeps fresh English, scopes profile fallback to upgrades and never executes profile contents', () => {
  const initializer = hooks.split('Function VeyloInitLanguage')[1].split('FunctionEnd')[0];
  assert.match(initializer, /StrCpy \$LANGUAGE 1033/);
  assert.match(initializer, /\$\{If\} \$\{isUpdated\}\s+Call VeyloReadUpgradeLanguage/);
  assert.match(initializer, /ReadRegStr \$0 SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation"/);
  assert.match(initializer, /\$\{AndIf\} \$\{FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"\s+Call VeyloReadUpgradeLanguage/);
  const reader = hooks.split('Function VeyloReadUpgradeLanguage')[1].split('FunctionEnd')[0];
  assert.match(reader, /ReadEnvStr \$0 "VEYLO_UPDATE_LANGUAGE"/);
  assert.match(reader, /ReadEnvStr \$3 "APPDATA"/);
  assert.match(reader, /\$3\\adb-workbench\\settings\.json/);
  assert.match(reader, /\/TIMEOUT=5000/);
  assert.match(reader, /\$WINDIR\\Sysnative\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(reader, /-File "\$PLUGINSDIR\\veylo-installer-language\.ps1"/);
  assert.doesNotMatch(reader, /-Command|WriteReg|Delete|FileWrite|FindFirst/);
  const helper = fs.readFileSync(script, 'utf8');
  assert.match(helper, /262144/); assert.match(helper, /FileAccess\]::Read/);
  assert.doesNotMatch(helper, /Write-Host|Write-Output|Invoke-Expression|Set-Content|WriteAllText|Get-ChildItem/);
  assert.ok(!helper.includes('\r') && !hooks.includes('\r'));
});
