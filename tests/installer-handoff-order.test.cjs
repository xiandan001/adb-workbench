const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const hooks = read('build/installer.nsh');
const ui = read('build/installer-ui.nsh');
const native = read('build/installer-ui/installer-skin.cpp');
const macro = name => hooks.match(new RegExp(`!macro ${name}[^\\n]*\\n([\\s\\S]*?)!macroend`))?.[1] || '';
const callback = name => ui.match(new RegExp(`Function ${name}\\s*\\n([\\s\\S]*?)FunctionEnd`))?.[1] || '';

test('installer initialization only parses identity and locale, never waits for the live old app', () => {
  const init = macro('customInit');
  assert.match(init, /VeyloInstaller::ConfigureUpdate/);
  assert.match(init, /Call VeyloInitLanguage/);
  assert.doesNotMatch(init, /PrepareBundled|nsExec|Sleep|Wait/);
});

test('native ready acknowledgement follows successful explicit UI show and painting', () => {
  const ready = native.slice(native.indexOf('SKIN_EXPORT(ShowReady)'), native.indexOf('SKIN_EXPORT(BeginInstall)'));
  assert.match(ready, /ShowWindow/);
  assert.match(ready, /UpdateWindow/);
  assert.match(ready, /SignalReady/);
  assert.ok(ready.indexOf('ShowWindow') < ready.indexOf('SignalReady'));
  assert.ok(ready.indexOf('UpdateWindow') < ready.indexOf('SignalReady'));
  assert.match(callback('VeyloGuiInit'), /VeyloInstaller::ShowReady/);
  const init = callback('VeyloGuiInit');
  const page = init.indexOf('VeyloInstaller::Page');
  const acknowledge = init.indexOf('VeyloInstaller::ShowReady');
  assert.ok(page >= 0 && page < acknowledge);
  assert.match(init.slice(page, acknowledge), /\$0 != "ok"[\s\S]*PreparationFailed[\s\S]*Return/);
});

test('predeployment override acquires guard before exact cleanup and safely aborts failures', () => {
  const check = macro('customCheckAppRunning');
  assert.match(check, /VeyloInstaller::BeginInstall/);
  assert.match(check, /VeyloPrepareBundledProcesses/);
  assert.ok(check.indexOf('BeginInstall') < check.indexOf('VeyloPrepareBundledProcesses'));
  assert.match(check, /VeyloInstaller::EndInstall/);
  assert.match(check, /VeyloInstaller::PreparationFailed/);
  assert.match(check, /Abort/);
  assert.doesNotMatch(check, /MessageBox|KILL_PROCESS|Stop-Process|taskkill|CHECK_APP_RUNNING/);
  assert.match(check, /\$\{Silent\}[\s\S]*"silent"[\s\S]*"interactive"/);
  const begin = native.slice(native.indexOf('SKIN_EXPORT(BeginInstall)'), native.indexOf('SKIN_EXPORT(EndInstall)'));
  assert.match(begin, /mode == L"silent" && skin::updateArguments.valid && !skin::updateArguments.tokenProvided/);
  assert.match(begin, /mode == L"interactive" && skin::readyConfirmed.load\(\)/);
});

test('deployment guard is released before finish launch and on failure or disposal', () => {
  assert.match(callback('VeyloFinish'), /VeyloInstaller::EndInstall/);
  const finish = callback('VeyloFinishLeave');
  assert.ok(finish.indexOf('EndInstall') >= 0 && finish.indexOf('EndInstall') < finish.indexOf('ExecShellAsUser'));
  assert.match(callback('\\.onInstFailed'), /VeyloInstaller::EndInstall/);
  assert.match(callback('\\.onGUIEnd'), /VeyloInstaller::EndInstall/);
  assert.match(native, /void Cleanup\(\)\s*\{\s*[^\n]*installGuard\.End/);
  assert.doesNotMatch(ui, /MessageBox/);
  assert.match(macro('customInstall'), /ci_done:[\s\S]*\$\{Silent\}\s+VeyloInstaller::EndInstall/);
});

test('main-app wait is exact and read-only even without an updater identity', () => {
  const source = read('electron/assets/update-processes.ps1');
  const mainWait = source.match(/function Wait-ForInstallApplications[\s\S]*?\n}\n/)?.[0] || '';
  assert.match(mainWait, /canonicalApp/);
  assert.match(mainWait, /UpdateProcessHandle\]::Open\([^\n]*\$false\)/);
  assert.match(mainWait, /Test-SamePath/);
  assert.match(mainWait, /\.Wait\(/);
  assert.doesNotMatch(mainWait, /\.Stop\(|TerminateProcess|Stop-Process/);
  assert.match(mainWait, /EnvOnlyMode/);
});

test('post-ready wait covers supported serial cleanup budgets without force-closing the application', () => {
  const source = read('electron/assets/update-processes.ps1');
  assert.match(source, /\$Mode -eq 'PrepareInstall'\) \{ 60000 \} else \{ 5000 \}/);
  assert.match(hooks, /\/TIMEOUT=90000/);
  assert.ok(60000 > 4 * 5000 + 1500 + 10000, 'Harmony cleanup, socket grace and tool cleanup require more than fifteen seconds');
});

test('production hook compile fixture can never execute deployment or request elevation', () => {
  const source = read('tests/installer-predeployment-compile.nsi');
  assert.match(source, /RequestExecutionLevel user/);
  const init = source.match(/Function \.onInit\s*\n([\s\S]*?)FunctionEnd/)[1];
  assert.ok(init.indexOf('Quit') >= 0 && init.indexOf('Quit') < init.indexOf('!insertmacro customInit'));
  assert.match(source, /!insertmacro customCheckAppRunning/);
});
