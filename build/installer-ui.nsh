; Display-only native skin; electron-builder retains its install/update/uninstall engine.
!ifdef BUILD_UNINSTALLER
  !include "installer-uninstall-ui.nsh"
!else
  ; Render at the system DPI instead of letting Windows enlarge a 96-DPI bitmap.
  ManifestDPIAware true
  !include LogicLib.nsh
  !include nsDialogs.nsh
  !addplugindir /x86-unicode "${BUILD_RESOURCES_DIR}\generated\installer-ui"
  !define /ifndef VEYLO_RECEIPT_KEY "Software\Veylo\adb-workbench Installer"
  !define /ifndef VEYLO_RECEIPT_ROOT HKLM
  !define /ifndef VEYLO_ICON_FILE "${PROJECT_DIR}\icon.png"
  Var VeyloReady
  Var VeyloLocale
  Var VeyloDisplayName
  Var VeyloShortcut
  !undef SHORTCUT_NAME
  !define SHORTCUT_NAME "$VeyloDisplayName"
  !undef isNoDesktopShortcut
  !define isNoDesktopShortcut `"" VeyloNoDesktopShortcut ""`
  !macro _VeyloNoDesktopShortcut _a _b _t _f
    StrCmp $VeyloShortcut "0" `${_t}` 0
    !insertmacro _isNoDesktopShortcut `${_a}` `${_b}` `${_t}` `${_f}`
  !macroend
  !define MUI_CUSTOMFUNCTION_GUIINIT VeyloGuiInit

  !macro customWelcomePage
    Page custom VeyloWelcome VeyloWelcomeLeave
  !macroend
  !macro customPageAfterChangeDir
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW VeyloInstallShow
  !macroend
  !macro customFinishPage
    Page custom VeyloFinish VeyloFinishLeave
  !macroend

  !macro customHeader
    LangString VeyloSkinError 1033 "Setup could not open. Please download the installer again."
    LangString VeyloSkinError 2052 "无法打开安装界面，请重新下载安装包。"
    LangString VeyloSkinError 1028 "無法開啟安裝介面，請重新下載安裝程式。"
    LangString VeyloSkinError 1041 "セットアップを開けませんでした。インストーラーを再度ダウンロードしてください。"
    LangString VeyloSkinError 1042 "설치 화면을 열 수 없습니다. 설치 파일을 다시 다운로드해 주세요."

    Function VeyloSetDisplayLanguage
      StrCpy $VeyloDisplayName "Veylo"
      ${Switch} $LANGUAGE
        ${Case} 2052
          StrCpy $VeyloLocale "zh-CN"
          StrCpy $VeyloDisplayName "卓控台"
          ${Break}
        ${Case} 1028
          StrCpy $VeyloLocale "zh-TW"
          StrCpy $VeyloDisplayName "卓控臺"
          ${Break}
        ${Case} 1041
          StrCpy $VeyloLocale "ja-JP"
          ${Break}
        ${Case} 1042
          StrCpy $VeyloLocale "ko-KR"
          ${Break}
        ${Default}
          StrCpy $LANGUAGE 1033
          StrCpy $VeyloLocale "en-US"
      ${EndSwitch}
    FunctionEnd

    ; $0 is data from a fixed source. Only exact supported locale codes apply.
    ; $2 reports whether a value was accepted; all other values keep the fallback.
    Function VeyloApplyLanguageValue
      StrCpy $2 "1"
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
      ${Else}
        StrCpy $2 "0"
      ${EndIf}
    FunctionEnd

    Function VeyloReadUpgradeLanguage
      ; New updaters pass the active app language, including automatic quit installs.
      ReadEnvStr $0 "VEYLO_UPDATE_LANGUAGE"
      Call VeyloApplyLanguageValue
      ${If} $2 == "1"
        Return
      ${EndIf}
      ; Older updaters cannot pass a locale. Read only the current user's fixed
      ; profile, never enumerate other users or modify settings/activation data.
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
      ; This x86 NSIS process otherwise starts the slower WOW64 PowerShell host.
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
        Call VeyloApplyLanguageValue
      ${EndIf}
    FunctionEnd

    Function VeyloInitLanguage
      StrCpy $VeyloReady "0"
      StrCpy $VeyloShortcut "1"
      StrCpy $LANGUAGE 1033
      SetRegView 64
      ReadRegStr $0 ${VEYLO_RECEIPT_ROOT} "${VEYLO_RECEIPT_KEY}" "Language"
      ReadRegStr $1 ${VEYLO_RECEIPT_ROOT} "${VEYLO_RECEIPT_KEY}" "InstallLocation"
      ${If} $1 == $INSTDIR
        Call VeyloApplyLanguageValue
      ${EndIf}
      ${If} ${isUpdated}
        Call VeyloReadUpgradeLanguage
      ${Else}
        ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
        ${If} $0 == $INSTDIR
        ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
          Call VeyloReadUpgradeLanguage
        ${EndIf}
      ${EndIf}
      Call VeyloSetDisplayLanguage
    FunctionEnd

    Function VeyloGuiInit
      ; The stock MUI finish page sets this; our custom finish page must too.
      SetAutoClose true
      InitPluginsDir
      File /oname=$PLUGINSDIR\veylo-brand.png "${VEYLO_ICON_FILE}"
      VeyloInstaller::Init /NOUNLOAD "$HWNDPARENT" "$PLUGINSDIR\veylo-brand.png" "$LANGUAGE" "${VERSION}"
      Pop $0
      ${If} $0 != "ok"
        MessageBox MB_OK|MB_ICONSTOP "$(VeyloSkinError)"
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $VeyloReady "1"
      ; A prefilled default directory is not proof of an existing installation.
      ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
      ${If} $0 == $INSTDIR
      ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        VeyloInstaller::TrustExistingPath /NOUNLOAD "$INSTDIR"
      ${EndIf}
    FunctionEnd

    Function VeyloWelcome
      ${If} ${isUpdated}
        Abort
      ${EndIf}
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == "error"
        SetErrorLevel 2
        Quit
      ${EndIf}
      VeyloInstaller::Page /NOUNLOAD "welcome" "$INSTDIR" "${APP_FILENAME}" "0" "0"
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function VeyloWelcomeLeave
      VeyloInstaller::GetPath /NOUNLOAD
      Pop $0
      ${If} $0 == ""
        Abort
      ${EndIf}
      StrCpy $INSTDIR $0
      VeyloInstaller::GetLanguage /NOUNLOAD
      Pop $LANGUAGE
      VeyloInstaller::GetShortcut /NOUNLOAD
      Pop $VeyloShortcut
      Call VeyloSetDisplayLanguage
    FunctionEnd

    Function VeyloInstallShow
      VeyloInstaller::Page /NOUNLOAD "install" "$INSTDIR" "${APP_FILENAME}" "$mui.InstFilesPage.ProgressBar" "$mui.InstFilesPage.Log"
      Pop $0
    FunctionEnd

    Function VeyloFinish
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == "error"
        SetErrorLevel 2
        Quit
      ${EndIf}
      VeyloInstaller::Page /NOUNLOAD "finish" "$INSTDIR" "${APP_FILENAME}" "0" "0"
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function VeyloFinishLeave
      VeyloInstaller::GetLaunch /NOUNLOAD
      Pop $0
      ${If} $0 == "1"
        ${If} ${isUpdated}
          StrCpy $1 "--updated"
        ${Else}
          StrCpy $1 ""
        ${EndIf}
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
      ${EndIf}
    FunctionEnd

    Function .onInstFailed
      ${If} $VeyloReady == "1"
        VeyloInstaller::Failed /NOUNLOAD
      ${EndIf}
    FunctionEnd
    Function .onGUIEnd
      ${If} $VeyloReady == "1"
        VeyloInstaller::Dispose
      ${EndIf}
    FunctionEnd
  !macroend

  !macro VeyloSaveInstallerLanguage
    SetRegView 64
    WriteRegStr ${VEYLO_RECEIPT_ROOT} "${VEYLO_RECEIPT_KEY}" "Language" "$VeyloLocale"
    WriteRegStr ${VEYLO_RECEIPT_ROOT} "${VEYLO_RECEIPT_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayName" "$VeyloDisplayName"
  !macroend
!endif
