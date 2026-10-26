; Safe integration fixture: includes the production UI hooks, never installer.nsh.
Unicode true
RequestExecutionLevel user
Name "Veylo hooks fixture"
OutFile "${FIXTURE_EXE}"
InstallDir "${FIXTURE_INSTALL_DIR}"
ShowUninstDetails show
!ifdef FIXTURE_APP_ARCHIVE
  ShowInstDetails nevershow
  SetCompressor zlib
!else
  ShowInstDetails show
  SetCompressor /SOLID lzma
!endif

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "${PROJECT_DIR}\node_modules\app-builder-lib\templates\nsis\include\StdUtils.nsh"
!addplugindir /x86-unicode "${FIXTURE_STDUTILS_DIR}"
!define VERSION "${FIXTURE_VERSION}"
!define APP_FILENAME "Veylo-hooks-fixture"
!define APP_EXECUTABLE_FILENAME "fixture.txt"
!define SHORTCUT_NAME "Veylo-hooks-fixture"
!define isNoDesktopShortcut `"" isNoDesktopShortcut ""`
!define VEYLO_RECEIPT_ROOT HKCU
!define VEYLO_RECEIPT_KEY "${FIXTURE_RECEIPT_KEY}"
!define UNINSTALL_REGISTRY_KEY "${FIXTURE_RECEIPT_KEY}"
!define INSTALL_REGISTRY_KEY "${FIXTURE_RECEIPT_KEY}"
Var launchLink
Var FixtureUpdated
!define isUpdated `"" FixtureIsUpdated ""`
!macro _FixtureIsUpdated _a _b _t _f
  StrCmp $FixtureUpdated "1" `${_t}` `${_f}`
!macroend
!macro _isNoDesktopShortcut _a _b _t _f
  StrCmp "0" "1" `${_t}` `${_f}`
!macroend
!include "${FIXTURE_UI_HOOKS}"
!ifdef FIXTURE_APP_ARCHIVE
  !include "x64.nsh"
  !define APP_64 "${FIXTURE_APP_ARCHIVE}"
  !define COMPRESSION_METHOD "7z"
  !define COMPRESS "auto"
  !define PRODUCT_NAME "Veylo extraction fixture"
  !include "${FIXTURE_EXTRACT_INCLUDE}"
!endif

!insertmacro customWelcomePage
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
UninstPage instfiles
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "TradChinese"
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro customHeader
!ifdef FIXTURE_APP_ARCHIVE
  LangString appCannotBeClosed 1033 "Fixture copy failed. Only this fixture may be retried."
  LangString appCannotBeClosed 2052 "测试目录复制失败，仅允许重试本测试。"
  LangString appCannotBeClosed 1028 "測試目錄複製失敗，僅允許重試本測試。"
  LangString appCannotBeClosed 1041 "テスト用ディレクトリのコピーを再試行してください。"
  LangString appCannotBeClosed 1042 "테스트 디렉터리 복사를 다시 시도하세요."
!endif

Function .onInit
  SetShellVarContext current
  StrCpy $launchLink "$INSTDIR\no-application-in-fixture.exe"
  StrCpy $FixtureUpdated "0"
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} "$R0" "--updated" $R1
  ${IfNot} ${Errors}
    StrCpy $FixtureUpdated "1"
  ${EndIf}
  Call VeyloInitLanguage
FunctionEnd

!macro FixtureProgressCheckpoint label
  FileOpen $5 "$INSTDIR\qa-progress-checkpoint.txt" w
  FileWrite $5 "${label}"
  FileClose $5
  Sleep 750
  Delete "$INSTDIR\qa-progress-checkpoint.txt"
!macroend

Section "Fixture payload"
!ifdef FIXTURE_APP_ARCHIVE
  ; Match production installSection.nsh before even SetOutPath can add a row.
  SetDetailsPrint none
!endif
  ; Neither command line nor folder browser can escape the dedicated fixture.
  StrCmp $INSTDIR "${FIXTURE_INSTALL_DIR}" ownedDirectory
    SetErrorLevel 3
    Abort "Fixture directory mismatch"
  ownedDirectory:
  SetOutPath "$INSTDIR"
!ifdef FIXTURE_APP_ARCHIVE
  System::Call 'kernel32::GetTickCount64() l .r6'
  FileOpen $5 "$EXEDIR\extraction-timing.txt" w
  FileWrite $5 "start=$6$\nplugins=$PLUGINSDIR$\n"
  FileClose $5
  !insertmacro extractEmbeddedAppPackage
  System::Call 'kernel32::GetTickCount64() l .r6'
  FileOpen $5 "$EXEDIR\extraction-timing.txt" a
  FileSeek $5 0 END
  FileWrite $5 "end=$6$\n"
  FileClose $5
!else
  DetailPrint "Extracting real fixture payload through the NSIS File instruction"
  !insertmacro FixtureProgressCheckpoint "before-file"
  File /oname=fixture-payload.bin "${FIXTURE_PAYLOAD}"
  !insertmacro FixtureProgressCheckpoint "after-file"
!endif
!ifdef FIXTURE_STAGE_FEEDBACK
  VeyloInstaller::Stage /NOUNLOAD "configuring"
!endif
!ifdef FIXTURE_APP_ARCHIVE
  FileOpen $5 "$EXEDIR\extraction-complete.txt" w
  FileWrite $5 "The real archive macro has returned; configuring was posted.$\n"
  FileClose $5
!endif
  SetRegView 64
  ReadRegDWORD $2 HKCU "${FIXTURE_RECEIPT_KEY}" "Generation"
  IntOp $2 $2 + 1
  FileOpen $3 "$INSTDIR\fixture.txt" w
  FileWrite $3 "fixture=${FIXTURE_ID}$\r$\ngeneration=$2$\r$\nlanguage=$VeyloLocale$\r$\nupdated=$FixtureUpdated$\r$\n"
  FileClose $3
  StrCpy $4 0
  ${Do}
    IntOp $4 $4 + 1
    DetailPrint "Fixture operation $4 of 30"
    Sleep 35
  ${LoopUntil} $4 == 30
  ; Stable engine checkpoints let the GUI timer catch up before pixel comparison.
  !insertmacro FixtureProgressCheckpoint "after-loop"
  WriteUninstaller "$INSTDIR\fixture-uninstall.exe"
  !insertmacro VeyloSaveInstallerLanguage
  WriteRegDWORD HKCU "${FIXTURE_RECEIPT_KEY}" "Generation" $2
SectionEnd

Function un.onInit
  SetShellVarContext current
  StrCmp $INSTDIR "${FIXTURE_INSTALL_DIR}" ownedUninstallDirectory
    SetErrorLevel 3
    Quit
  ownedUninstallDirectory:
FunctionEnd

Section "Uninstall"
!ifdef FIXTURE_EXTRACT_CLEANUP
  !include "${FIXTURE_EXTRACT_CLEANUP}"
!endif
  Delete "$INSTDIR\fixture.txt"
  Delete "$INSTDIR\fixture-payload.bin"
  Delete "$INSTDIR\qa-progress-checkpoint.txt"
  Delete "$INSTDIR\fixture-uninstall.exe"
  RMDir "$INSTDIR"
  SetRegView 64
  DeleteRegKey HKCU "${FIXTURE_RECEIPT_KEY}"
SectionEnd
