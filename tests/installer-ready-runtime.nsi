; Harmless runtime fixture: real MUI callbacks, no app deployment or installation guard.
Unicode true
RequestExecutionLevel user
Name "Veylo readiness runtime fixture"
OutFile "${FIXTURE_EXE}"
InstallDir "${FIXTURE_INSTALL_DIR}"
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!addincludedir "${PROJECT_DIR}\build"
!include "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis\include\StdUtils.nsh"
!addplugindir /x86-unicode "${FIXTURE_STDUTILS_DIR}"
!define VERSION "readiness-fixture"
!define APP_FILENAME "Veylo-readiness-fixture"
!define APP_EXECUTABLE_FILENAME "never-created.exe"
!define SHORTCUT_NAME "Veylo-readiness-fixture"
!define INSTALL_REGISTRY_KEY "Software\VeyloReadinessRuntimeNeverWritten"
!define UNINSTALL_REGISTRY_KEY "Software\VeyloReadinessRuntimeNeverWritten"
!define VEYLO_RECEIPT_ROOT HKCU
!define VEYLO_RECEIPT_KEY "Software\VeyloReadinessRuntimeNeverWritten"
!define isNoDesktopShortcut `"" FixtureNoShortcut ""`
!define isUpdated `"" isUpdated ""`
!macro _FixtureNoShortcut _a _b _t _f
  StrCmp "0" "1" `${_t}` `${_f}`
!macroend
!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
Var launchLink
Var FixtureCase
Var FixturePhase
Var FixtureInit
Var FixtureGui
Var FixturePage
Var FixtureGuiThread
Var FixturePageThread
Var FixtureWorkerThread
Var FixtureWorkerReady
Var FixtureVisible
Var FixtureIconic
Var FixtureStartupFlags
Var FixtureStartupShow
!include "${PROJECT_DIR}\build\installer.nsh"
!undef MUI_CUSTOMFUNCTION_GUIINIT
!define MUI_CUSTOMFUNCTION_GUIINIT FixtureGuiInit
!insertmacro customPageAfterChangeDir
!undef MUI_PAGE_CUSTOMFUNCTION_SHOW
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FixtureInstallShow
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "TradChinese"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro customHeader

Function .onInit
  ${StdUtils.GetParameter} $FixtureCase "fixture-case" ""
  ${StdUtils.GetParameter} $FixturePhase "fixture-phase" ""
  ${If} $FixtureCase != "inside-normal"
  ${AndIf} $FixtureCase != "inside-hidden"
  ${AndIf} $FixtureCase != "inside-minimized"
  ${AndIf} $FixtureCase != "token-valid"
  ${AndIf} $FixtureCase != "token-missing"
  ${AndIf} $FixtureCase != "token-expired"
  ${AndIf} $FixtureCase != "token-invalid"
  ${AndIf} $FixtureCase != "worker-check"
    SetErrorLevel 3
    Quit
  ${EndIf}
  ${If} $FixturePhase != "inside"
    SetErrorLevel 3
    Quit
  ${EndIf}
  System::Alloc 68
  Pop $0
  System::Call 'kernel32::GetStartupInfoW(p r0)'
  IntOp $1 $0 + 44
  System::Call '*$1(i .r2)'
  StrCpy $FixtureStartupFlags $2
  IntOp $1 $0 + 48
  System::Call '*$1(i .r2)'
  IntOp $FixtureStartupShow $2 & 0xFFFF
  System::Free $0
  !insertmacro customInit
  StrCpy $FixtureInit $VeyloHandoffStatus
  StrCpy $FixtureWorkerReady "not-called"
FunctionEnd

Function FixtureRunGui
  System::Call 'kernel32::GetCurrentThreadId() i .r0'
  StrCpy $FixtureGuiThread $0
  Call VeyloGuiInit
  StrCpy $FixtureGui $VeyloHandoffStatus
  System::Call 'user32::IsWindowVisible(p $HWNDPARENT) i .r0'
  StrCpy $FixtureVisible $0
  System::Call 'user32::IsIconic(p $HWNDPARENT) i .r0'
  StrCpy $FixtureIconic $0
FunctionEnd
Function FixtureGuiInit
  Call FixtureRunGui
FunctionEnd
Function FixtureInstallShow
  System::Call 'kernel32::GetCurrentThreadId() i .r0'
  StrCpy $FixturePageThread $0
  Call VeyloInstallShow
  StrCpy $FixturePage $VeyloHandoffStatus
FunctionEnd

Section "Record only; never deploy"
  System::Call 'kernel32::GetCurrentThreadId() i .r0'
  StrCpy $FixtureWorkerThread $0
  ${If} $FixtureCase == "worker-check"
    VeyloInstaller::ShowReady /NOUNLOAD
    Pop $FixtureWorkerReady
  ${EndIf}
  FileOpen $R0 "${FIXTURE_RESULT_ROOT}\$FixtureCase.json" w
  FileWrite $R0 '{"configure":"$FixtureInit","gui":"$FixtureGui","page":"$FixturePage","guiThread":"$FixtureGuiThread","pageThread":"$FixturePageThread","workerThread":"$FixtureWorkerThread","workerReady":"$FixtureWorkerReady","visible":"$FixtureVisible","iconic":"$FixtureIconic","startupFlags":"$FixtureStartupFlags","startupShow":"$FixtureStartupShow"}$\n'
  FileClose $R0
  SetErrorLevel 0
  Quit
SectionEnd
