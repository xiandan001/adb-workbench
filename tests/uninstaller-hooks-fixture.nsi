; Compiles the actual BUILD_UNINSTALLER skin and assisted page sequence.
; Only the synthetic fixture section below deletes anything; never installer.nsh.
Unicode true
RequestExecutionLevel user
Name "Veylo uninstall fixture"
OutFile "${FIXTURE_GENERATOR}"
InstallDir "${FIXTURE_INSTALL_DIR}"
SilentInstall silent
ShowUninstDetails nevershow
!define BUILD_UNINSTALLER
!define INSTALL_MODE_PER_ALL_USERS
!define VERSION "${FIXTURE_VERSION}"
!define APP_FILENAME "Veylo-uninstall-fixture"
!define VEYLO_RECEIPT_ROOT HKCU
!define VEYLO_RECEIPT_KEY "${FIXTURE_RECEIPT_KEY}"
!include MUI2.nsh
!include LogicLib.nsh
!include FileFunc.nsh
!include "${FIXTURE_UI_HOOKS}"
!include "${FIXTURE_ASSISTED_PAGES}"
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "TradChinese"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro customHeader

!macro check64BitAndSetRegView
  SetRegView 64
!macroend
!define LogSet "!insertmacro FixtureLogSet"
!macro FixtureLogSet ignored
!macroend
!macro CHECK_APP_RUNNING
  ; Preserve the real lifecycle's call sites without inspecting/killing any app.
  FileOpen $8 "${FIXTURE_AUDIT}" a
  FileSeek $8 0 END
  FileWrite $8 "process-check$\n"
  FileClose $8
!macroend
!macro setInstallModePerAllUsers
  ; The actual assisted lifecycle delegates to this fixture-only current-user mode.
  SetShellVarContext current
!macroend
; Exact template init functions, prefixed with one fixed-directory safety guard.
!include "${FIXTURE_UNINSTALL_INIT}"

Function .onInit
  WriteUninstaller "${FIXTURE_UNINSTALLER}"
  SetErrorLevel 0
  Quit
FunctionEnd

Section "Fixture generator"
SectionEnd

Section "Uninstall"
  StrCmp $INSTDIR "${FIXTURE_INSTALL_DIR}" +3
    SetErrorLevel 3
    Abort "Fixture directory mismatch"
  ${IfNot} ${Silent}
    Call un.checkAppRunning
  ${EndIf}
  FileOpen $8 "${FIXTURE_AUDIT}" a
  FileSeek $8 0 END
  FileWrite $8 "section language=$LANGUAGE ready=$VeyloUnReady$\n"
  FileClose $8
  ${If} ${FileExists} "${FIXTURE_FAIL_MARKER}"
    SetErrorLevel 7
    Abort "Synthetic fixture failure: no installed files were removed."
  ${EndIf}
  ; Genuine NSIS instfiles progress, long enough to observe multiple positions.
  DetailPrint "Removing only the fixture's named synthetic payload files"
  Sleep 1000
  Delete "$INSTDIR\payload-one.txt"
  Sleep 1000
  Delete "$INSTDIR\payload-two.txt"
  Sleep 1000
  Delete "$INSTDIR\fixture.txt"
  Sleep 1000
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
  SetRegView 64
  DeleteRegKey HKCU "${FIXTURE_RECEIPT_KEY}"
SectionEnd
