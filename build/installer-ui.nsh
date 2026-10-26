; Display-only native skin; electron-builder retains its install/update/uninstall engine.
!ifndef BUILD_UNINSTALLER
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

    Function VeyloInitLanguage
      StrCpy $VeyloReady "0"
      StrCpy $VeyloShortcut "1"
      StrCpy $LANGUAGE 1033
      SetRegView 64
      ReadRegStr $0 ${VEYLO_RECEIPT_ROOT} "${VEYLO_RECEIPT_KEY}" "Language"
      ReadRegStr $1 ${VEYLO_RECEIPT_ROOT} "${VEYLO_RECEIPT_KEY}" "InstallLocation"
      ${If} $1 == $INSTDIR
        ${Switch} $0
          ${Case} "zh-CN"
            StrCpy $LANGUAGE 2052
            ${Break}
          ${Case} "zh-TW"
            StrCpy $LANGUAGE 1028
            ${Break}
          ${Case} "ja-JP"
            StrCpy $LANGUAGE 1041
            ${Break}
          ${Case} "ko-KR"
            StrCpy $LANGUAGE 1042
            ${Break}
        ${EndSwitch}
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
