; Real NSIS host: observe only, never deploy or pre-set the parent clipping bit.
Unicode true
RequestExecutionLevel user
Name "Veylo parent paint fixture"
OutFile "${FIXTURE_EXE}"
InstallDir "${FIXTURE_INSTALL_DIR}"
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!addincludedir "${PROJECT_DIR}\build"
!include "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis\include\StdUtils.nsh"
!addplugindir /x86-unicode "${FIXTURE_STDUTILS_DIR}"
!define VERSION "parent-paint-fixture"
!define APP_FILENAME "Veylo-parent-paint-fixture"
!define APP_EXECUTABLE_FILENAME "never-created.exe"
!define SHORTCUT_NAME "Veylo-parent-paint-fixture"
!define INSTALL_REGISTRY_KEY "Software\VeyloParentPaintNeverWritten"
!define UNINSTALL_REGISTRY_KEY "Software\VeyloParentPaintNeverWritten"
!define VEYLO_RECEIPT_ROOT HKCU
!define VEYLO_RECEIPT_KEY "Software\VeyloParentPaintNeverWritten"
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
Var FixtureParentBefore
Var FixtureGui
Var FixturePage
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
  ${If} $FixtureCase != "inside-normal"
  ${AndIf} $FixtureCase != "token-valid"
    SetErrorLevel 3
    Quit
  ${EndIf}
  !insertmacro customInit
  ; This selects rendering locale, not the independent updater-language handoff.
  StrCpy $LANGUAGE ${FIXTURE_LANGUAGE_ID}
  Call VeyloSetDisplayLanguage
FunctionEnd
Function FixtureGuiInit
  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -16) i .r0'
  IntOp $FixtureParentBefore $0 & 0x02000000
  Call VeyloGuiInit
  StrCpy $FixtureGui $VeyloHandoffStatus
  ParentPaint::Init /NOUNLOAD "${FIXTURE_RESULT_ROOT}\paint.jsonl"
  Pop $0
  ${If} $0 != "ok"
    SetErrorLevel 4
    Quit
  ${EndIf}
FunctionEnd
Function FixtureInstallShow
  Call VeyloInstallShow
  StrCpy $FixturePage $VeyloHandoffStatus
FunctionEnd

Section "Observe only; no deployment"
  ParentPaint::Snapshot /NOUNLOAD "0"
  Pop $0
  Sleep 1000
  ParentPaint::Snapshot /NOUNLOAD "1"
  Pop $0
  Sleep 3000
  ParentPaint::Snapshot /NOUNLOAD "4"
  Pop $0
  ParentPaint::Finish /NOUNLOAD
  Pop $0
  FileOpen $R0 "${FIXTURE_RESULT_ROOT}\result.json" w
  FileWrite $R0 '{"originalParentClip":"$FixtureParentBefore","gui":"$FixtureGui","page":"$FixturePage","finish":"$0","language":"$LANGUAGE"}$\n'
  FileClose $R0
  SetErrorLevel 0
  Quit
SectionEnd
