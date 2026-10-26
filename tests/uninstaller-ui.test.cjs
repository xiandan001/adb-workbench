const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('real uninstall branch uses presentation hooks without replacing engine callbacks or removal', () => {
  const outer = read('build/installer-ui.nsh');
  const source = read('build/installer-uninstall-ui.nsh');
  assert.match(outer, /!ifdef BUILD_UNINSTALLER\s+!include "installer-uninstall-ui\.nsh"\s+!else/);
  for (const hook of ['customUnInit', 'customUnWelcomePage', 'customUninstallPage', 'customHeader']) assert.ok(source.includes(`!macro ${hook}`));
  assert.match(source, /MUI_CUSTOMFUNCTION_UNGUIINIT un\.VeyloGuiInit/);
  assert.match(source, /MUI_PAGE_CUSTOMFUNCTION_SHOW un\.VeyloProgress/);
  assert.match(source, /MUI_PAGE_CUSTOMFUNCTION_LEAVE un\.VeyloProgressLeave/);
  assert.match(source, /Function un\.VeyloProgressLeave[\s\S]*?IfAbort 0 veyloUninstallNotFailed[\s\S]*?VeyloInstaller::Failed/);
  assert.match(source, /MUI_PAGE_CUSTOMFUNCTION_SHOW un\.VeyloFinish/);
  assert.match(source, /\$mui\.InstFilesPage\.ProgressBar.*\$mui\.InstFilesPage\.Log/);
  assert.match(source, /Function un\.onUninstFailed/);
  assert.match(source, /Function un\.onGUIEnd/);
  assert.doesNotMatch(source, /Function un\.(?:onInit|onGUIInit|onUserAbort)\b|!macro (?:customRemoveFiles|customUnInstallSection|customUnInstall)\b/);
  assert.doesNotMatch(source, /\b(?:RMDir|DeleteRegKey|WriteRegStr|ExecShell|SetSilent)\b|GetLaunch|GetPath|GetShortcut/);
  assert.match(source, /\$\{IfNot\} \$\{Silent\}\s+Call un\.VeyloInitLanguage/);
  assert.match(source, /ReadRegStr \$1 .*"InstallLocation"[\s\S]*\$1 == \$INSTDIR/);
  assert.match(source, /ReadEnvStr \$3 "APPDATA"/);
  assert.match(source, /VEYLO_PROFILE_SETTINGS_FILE/);
});

test('uninstall state cannot edit install paths, request launch or override engine progress', () => {
  const source = read('build/installer-ui/installer-skin.cpp');
  for (const mode of ['uninstall-confirm', 'uninstall', 'uninstall-finish']) assert.ok(source.includes(`L"${mode}"`));
  assert.match(source, /s\.mode == Mode::Welcome && !s\.uninstall && !Validate\(\)/);
  assert.match(source, /s\.launch = s\.mode == Mode::Finish && !s\.uninstall/);
  assert.match(source, /case Secondary:\s+if \(s\.uninstall\) break/);
  assert.match(source, /case Browse: if \(!s\.uninstall\)/);
  assert.match(source, /welcome && s\.custom && !s\.uninstall/);
  assert.match(source, /StringTrimmingEllipsisPath/);
  assert.equal((source.match(/s\.installPath, 282, (?:241|278),[^\n]*s\.uninstall/g) || []).length, 2);
  assert.match(source, /EnableWindow\(s\.cancel, !s\.cancelOverlay && CanCancel\(\)\)/);
  assert.doesNotMatch(source, /PBM_SETPOS|PBM_STEPIT|CreateProcess|ShellExecute|DeleteFile|RemoveDirectory/);
  const catalog = JSON.parse(read('build/installer-ui/strings.json'));
  const keys = [...source.matchAll(/L"(un[A-Z][^"]+)"/g)].map(match => match[1]);
  for (const [locale, strings] of Object.entries(catalog)) for (const key of keys) assert.ok(strings[key]?.trim(), `${locale}:${key}`);
  assert.match(catalog['en-US'].unRetention, /default.*Explicit data-removal options still apply/);
});

test('uninstaller fixture exercises stock page ordering and init with strictly synthetic deletion', () => {
  const fixture = read('tests/uninstaller-hooks-fixture.nsi');
  assert.match(fixture, /!define BUILD_UNINSTALLER/);
  assert.match(fixture, /FIXTURE_ASSISTED_PAGES/);
  assert.match(fixture, /FIXTURE_UNINSTALL_INIT/);
  assert.match(fixture, /WriteUninstaller/);
  assert.doesNotMatch(fixture, /UninstPage instfiles|RMDir \/r|Machine|installer\.nsh"/);
  assert.match(fixture, /StrCmp \$INSTDIR "\$\{FIXTURE_INSTALL_DIR\}"/);
  assert.match(fixture, /DeleteRegKey HKCU "\$\{FIXTURE_RECEIPT_KEY\}"/);
  for (const file of ['build/installer-ui.nsh', 'build/installer-uninstall-ui.nsh', 'tests/uninstaller-hooks-fixture.nsi']) {
    assert.equal(read(file).includes('\r'), false, file);
    assert.equal(read(file).includes('\uFFFD'), false, file);
  }
});
