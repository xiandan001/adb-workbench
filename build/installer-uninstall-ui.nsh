; Presentation only: retain electron-builder's process checks and removal section.
ManifestDPIAware true
!include LogicLib.nsh
!include nsDialogs.nsh
!addplugindir /x86-unicode "${BUILD_RESOURCES_DIR}\generated\installer-ui"
!define /ifndef VEYLO_RECEIPT_KEY "Software\Veylo\adb-workbench Installer"
!define /ifndef VEYLO_RECEIPT_ROOT HKLM
!define /ifndef VEYLO_ICON_FILE "${PROJECT_DIR}\icon.png"
Var VeyloUnReady
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.VeyloGuiInit

!macro customUnInit
  StrCpy $VeyloUnReady "0"
  ; /S (including the updater's /S --updated) never initializes a skin.
  ${IfNot} ${Silent}
    Call un.VeyloInitLanguage
  ${EndIf}
!macroend

!macro customUnWelcomePage
  UninstPage custom un.VeyloConfirm
  ; With perMachine=true, the next page is the real engine's instfiles page.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.VeyloProgress
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.VeyloProgressLeave
!macroend

!macro customUninstallPage
  ; This hook precedes the stock finish page; it does not replace that page.
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW un.VeyloFinish
!macroend

!macro customHeader
  LangString VeyloUnSkinError 1033 "The uninstall window could not open. Please try again."
  LangString VeyloUnSkinError 2052 "无法打开卸载界面，请重试。"
  LangString VeyloUnSkinError 1028 "無法開啟解除安裝介面，請重試。"
  LangString VeyloUnSkinError 1041 "アンインストール画面を開けませんでした。再試行してください。"
  LangString VeyloUnSkinError 1042 "제거 화면을 열 수 없습니다. 다시 시도해 주세요."

  Function un.VeyloApplyLanguage
    ${If} $0 S== "zh-CN"
      StrCpy $LANGUAGE 2052
    ${ElseIf} $0 S== "zh-TW"
      StrCpy $LANGUAGE 1028
    ${ElseIf} $0 S== "en-US"
      StrCpy $LANGUAGE 1033
    ${ElseIf} $0 S== "ja-JP"
      StrCpy $LANGUAGE 1041
    ${ElseIf} $0 S== "ko-KR"
      StrCpy $LANGUAGE 1042
    ${EndIf}
  FunctionEnd

  Function un.VeyloInitLanguage
    StrCpy $LANGUAGE 1033
    SetRegView 64
    ReadRegStr $0 ${VEYLO_RECEIPT_ROOT} "${VEYLO_RECEIPT_KEY}" "Language"
    ReadRegStr $1 ${VEYLO_RECEIPT_ROOT} "${VEYLO_RECEIPT_KEY}" "InstallLocation"
    ${If} $1 == $INSTDIR
      Call un.VeyloApplyLanguage
    ${EndIf}
    ; Only the current user's fixed profile is read. Never change or enumerate it.
    !ifdef VEYLO_PROFILE_SETTINGS_FILE
      StrCpy $3 "${VEYLO_PROFILE_SETTINGS_FILE}"
    !else
      ReadEnvStr $3 "APPDATA"
      ${If} $3 == ""
        Return
      ${EndIf}
      StrCpy $3 "$3\adb-workbench\settings.json"
    !endif
    InitPluginsDir
    File /oname=$PLUGINSDIR\veylo-installer-language.ps1 "${PROJECT_DIR}\build\installer-language.ps1"
    System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_SETTINGS_FILE", w r3)'
    StrCpy $4 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
    ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
      StrCpy $4 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    ${EndIf}
    nsExec::ExecToStack /TIMEOUT=5000 `"$4" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\veylo-installer-language.ps1"`
    Pop $0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_SETTINGS_FILE", p 0)'
    ${If} $0 == "0"
      StrCpy $0 $1
      Call un.VeyloApplyLanguage
    ${EndIf}
  FunctionEnd

  Function un.VeyloSkinResult
    Pop $0
    ${If} $0 != "ok"
      MessageBox MB_OK|MB_ICONSTOP "$(VeyloUnSkinError)"
      SetErrorLevel 2
      Quit
    ${EndIf}
  FunctionEnd

  Function un.VeyloGuiInit
    SetAutoClose true
    InitPluginsDir
    File /oname=$PLUGINSDIR\veylo-brand.png "${VEYLO_ICON_FILE}"
    VeyloInstaller::Init /NOUNLOAD "$HWNDPARENT" "$PLUGINSDIR\veylo-brand.png" "$LANGUAGE" "${VERSION}"
    Call un.VeyloSkinResult
    StrCpy $VeyloUnReady "1"
    VeyloInstaller::Page /NOUNLOAD "uninstall-confirm" "$INSTDIR" "${APP_FILENAME}" "0" "0"
    Call un.VeyloSkinResult
  FunctionEnd

  Function un.VeyloConfirm
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == "error"
      SetErrorLevel 2
      Quit
    ${EndIf}
    VeyloInstaller::Page /NOUNLOAD "uninstall-confirm" "$INSTDIR" "${APP_FILENAME}" "0" "0"
    Call un.VeyloSkinResult
    nsDialogs::Show
  FunctionEnd

  Function un.VeyloProgress
    VeyloInstaller::Page /NOUNLOAD "uninstall" "$INSTDIR" "${APP_FILENAME}" "$mui.InstFilesPage.ProgressBar" "$mui.InstFilesPage.Log"
    Call un.VeyloSkinResult
  FunctionEnd

  Function un.VeyloProgressLeave
    ; The engine invokes instfiles LEAVE when its worker finishes, including
    ; Abort. un.onUninstFailed runs only when the user later closes that page.
    IfAbort 0 veyloUninstallNotFailed
      VeyloInstaller::Failed /NOUNLOAD
    veyloUninstallNotFailed:
  FunctionEnd

  Function un.VeyloFinish
    VeyloInstaller::Page /NOUNLOAD "uninstall-finish" "$INSTDIR" "${APP_FILENAME}" "0" "0"
    Call un.VeyloSkinResult
  FunctionEnd

  Function un.onUninstFailed
    ${If} $VeyloUnReady == "1"
      VeyloInstaller::Failed /NOUNLOAD
    ${EndIf}
  FunctionEnd

  Function un.onGUIEnd
    ${If} $VeyloUnReady == "1"
      VeyloInstaller::Dispose
    ${EndIf}
  FunctionEnd
!macroend
