; Compile-only production-hook contract. Even an accidental launch quits before any hook.
Unicode true
RequestExecutionLevel user
Name "Veylo compile-only lifecycle fixture"
OutFile "${FIXTURE_EXE}"
InstallDir "${FIXTURE_INSTALL_DIR}"
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!addincludedir "${PROJECT_DIR}\build"
!include "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis\include\StdUtils.nsh"
!addplugindir /x86-unicode "${FIXTURE_STDUTILS_DIR}"
!define VERSION "${FIXTURE_VERSION}"
!define APP_FILENAME "Veylo-compile-only"
!define APP_EXECUTABLE_FILENAME "Veylo-compile-only.exe"
!define SHORTCUT_NAME "Veylo-compile-only"
!define INSTALL_REGISTRY_KEY "Software\VeyloCompileOnlyNeverExecuted"
!define UNINSTALL_REGISTRY_KEY "Software\VeyloCompileOnlyNeverExecuted"
!define VEYLO_RECEIPT_ROOT HKCU
!define isNoDesktopShortcut `"" isNoDesktopShortcut ""`
!define isUpdated `"" FixtureIsUpdated ""`
Var launchLink
Var FixtureUpdated
!macro _isNoDesktopShortcut _a _b _t _f
  StrCmp "0" "1" `${_t}` `${_f}`
!macroend
!macro _FixtureIsUpdated _a _b _t _f
  StrCmp $FixtureUpdated "1" `${_t}` `${_f}`
!macroend
!include "${PROJECT_DIR}\build\installer.nsh"
!insertmacro customWelcomePage
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "TradChinese"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro customHeader

Function .onInit
  StrCpy $FixtureUpdated "0"
  StrCpy $launchLink "$INSTDIR\Veylo-compile-only.exe"
  SetErrorLevel 0
  Quit
  ; Parse and type-check production code, but never execute it in this fixture.
  !insertmacro customInit
FunctionEnd

Section "Compile-only contract"
  !insertmacro customCheckAppRunning
  !insertmacro customInstall
SectionEnd
