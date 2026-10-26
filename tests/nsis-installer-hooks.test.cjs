const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const hooks = read('build/installer-ui.nsh');
const builder = JSON.parse(read('electron-builder.json'));

test('custom installer retains stock NSIS engine, stable identity and packaged language helper', () => {
  assert.equal(builder.appId, 'com.scrcpy.gui'); assert.equal(builder.productName, '卓控台');
  assert.equal(builder.nsis.include, 'build/installer.nsh'); assert.equal(builder.nsis.script, undefined);
  assert.equal(builder.nsis.allowToChangeInstallationDirectory, false);
  assert.equal(builder.nsis.deleteAppDataOnUninstall, false);
  assert.deepEqual(builder.nsis.installerLanguages, ['en_US', 'zh_CN', 'zh_TW', 'ja_JP', 'ko_KR']);
  assert.ok(builder.asarUnpack.includes('electron/lib/installer-language.cjs'));
});

test('installer default English and language receipt are explicit and path scoped', () => {
  assert.match(hooks, /StrCpy \$LANGUAGE 1033/);
  assert.match(hooks, /!define \/ifndef VEYLO_RECEIPT_ROOT HKLM/);
  assert.match(hooks, /\$1 == \$INSTDIR/);
  assert.match(hooks, /SetRegView 64/);
  for (const locale of ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR']) assert.ok(hooks.includes(locale));
  assert.match(hooks, /"Language" "\$VeyloLocale"/);
  assert.match(hooks, /"InstallLocation" "\$INSTDIR"/);
  assert.match(read('build/installer.nsh'), /!macro customInstall\s+!insertmacro VeyloSaveInstallerLanguage/);
});

test('native callbacks retain real engine controls, update flags, shortcut opt-out and unelevated launch', () => {
  assert.match(hooks, /ManifestDPIAware true/);
  assert.match(hooks, /MUI_CUSTOMFUNCTION_GUIINIT VeyloGuiInit/);
  assert.match(hooks, /Function VeyloGuiInit\s+;[^\n]*\n\s+SetAutoClose true/);
  assert.match(hooks, /VeyloInstaller::GetPath \/NOUNLOAD/);
  assert.match(hooks, /ReadRegStr \$0 SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" "InstallLocation"/);
  assert.match(hooks, /\$\{FileExists\} "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/);
  assert.match(hooks, /VeyloInstaller::TrustExistingPath \/NOUNLOAD "\$INSTDIR"/);
  assert.match(hooks, /\$mui\.InstFilesPage\.ProgressBar/);
  assert.match(hooks, /\$mui\.InstFilesPage\.Log/);
  assert.match(hooks, /_isNoDesktopShortcut/);
  assert.match(hooks, /\$\{StdUtils.ExecShellAsUser\}/);
  assert.match(hooks, /"--updated"/);
  assert.match(hooks, /Function \.onGUIEnd/);
  assert.match(hooks, /Function \.onInstFailed/);
  for (const language of [1033,2052,1028,1041,1042]) assert.match(hooks, new RegExp(`LangString VeyloSkinError ${language} `));
  assert.ok(!hooks.includes('\r\n')); assert.ok(!hooks.includes('\uFFFD'));
});

test('final configuration stage uses an actual install hook and leaves the stock engine intact', () => {
  const source = read('build/installer.nsh');
  assert.match(source, /!macro customInstall\s+!insertmacro VeyloSaveInstallerLanguage\s+\$\{If\} \$VeyloReady == "1"\s+VeyloInstaller::Stage \/NOUNLOAD "configuring"/);
  assert.equal((source.match(/VeyloInstaller::Stage/g) || []).length, 1);
  assert.doesNotMatch(source, /!macro (?:uninstallOldVersion|decompress|extractUsing7za)|SetDetailsPrint both/);
});

test('installer paths are passed as environment data, never interpolated as PowerShell code', () => {
  const source = read('build/installer.nsh');
  const calls = source.split('\n').filter(line => line.includes('nsExec::ExecToStack'));
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call, /\$\$dir=\$\$env:VEYLO_INSTALLER_TOOL_DIR/);
    assert.ok(!call.includes('$INSTDIR') && !call.includes('$R0'));
    assert.match(call, /\$SYSDIR\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  }
  assert.equal((source.match(/SetEnvironmentVariableW\(w "VEYLO_INSTALLER_TOOL_DIR", p 0\)/g) || []).length, 3);
});
