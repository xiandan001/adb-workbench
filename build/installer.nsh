!include "installer-ui.nsh"
Var VeyloPreparationResult

!macro VeyloPrepareBundledProcesses FLAGS
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  InitPluginsDir
  File /oname=$PLUGINSDIR\veylo-update-processes.ps1 "${PROJECT_DIR}\electron\assets\update-processes.ps1"
  StrCpy $0 "$INSTDIR"
  StrCpy $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_ROOT", w r0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_APP_EXE", w r1)'
  !ifndef BUILD_UNINSTALLER
    VeyloInstaller::GetUpdatePid /NOUNLOAD
    Pop $0
    System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_UPDATE_PID", w r0)'
    System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_UPDATE_EXE", w r1)'
  !endif
  StrCpy $2 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $2 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=90000 `"$2" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\veylo-update-processes.ps1" -Mode PrepareInstall ${FLAGS}`
  Pop $3
  Pop $4
  StrCpy $VeyloPreparationResult $3
  ${If} $3 == "0"
    DetailPrint "Bundled tool processes exited"
  ${Else}
    DetailPrint "Process preparation requires attention: $3 $4"
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_ROOT", p 0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_APP_EXE", p 0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_UPDATE_PID", p 0)'
  System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_UPDATE_EXE", p 0)'
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customInit
  VeyloInstaller::ConfigureUpdate /NOUNLOAD
  Pop $VeyloHandoffStatus
  VeyloInstaller::GetUpdateLanguage /NOUNLOAD
  Pop $0
  ${If} $0 != ""
    System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_UPDATE_LANGUAGE", w r0)'
  ${EndIf}
  Call VeyloInitLanguage
!macroend

; The stock engine calls this before uninstalling or replacing application files.
!ifndef BUILD_UNINSTALLER
!macro customCheckAppRunning
  ${If} $VeyloHandoffStatus != "ok"
    VeyloInstaller::PreparationFailed /NOUNLOAD "ready"
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${If} ${Silent}
    StrCpy $0 "silent"
  ${Else}
    StrCpy $0 "interactive"
  ${EndIf}
  VeyloInstaller::BeginInstall /NOUNLOAD "$0"
  Pop $0
  ${If} $0 != "ok"
    VeyloInstaller::PreparationFailed /NOUNLOAD "$0"
    VeyloInstaller::EndInstall /NOUNLOAD
    SetErrorLevel 2
    Abort
  ${EndIf}
  !insertmacro VeyloPrepareBundledProcesses ""
  ${If} $VeyloPreparationResult != "0"
    ${If} $VeyloPreparationResult == "3"
      VeyloInstaller::PreparationFailed /NOUNLOAD "application"
    ${Else}
      VeyloInstaller::PreparationFailed /NOUNLOAD "error"
    ${EndIf}
    VeyloInstaller::EndInstall /NOUNLOAD
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend
!endif

!macro customInstall
  !insertmacro VeyloSaveInstallerLanguage
  ${If} $VeyloReady == "1"
    VeyloInstaller::Stage /NOUNLOAD "configuring"
  ${EndIf}
  Push $R0
  StrCpy $R0 "$INSTDIR\scrcpy-win64"

  IfFileExists "$R0\scrcpy.exe" 0 ci_skip
    StrCpy $0 $R0
    System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_TOOL_DIR", w r0)'
    nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$dir=$$env:VEYLO_INSTALLER_TOOL_DIR; $$cur=[string][System.Environment]::GetEnvironmentVariable('Path','Machine'); if(($$cur -split ';') -notcontains $$dir){ [System.Environment]::SetEnvironmentVariable('Path',($$cur.TrimEnd(';')+';'+$$dir),'Machine'); Write-Host 'ADDED' } else { Write-Host 'EXISTS' }"`
    Pop $0
    Pop $1
    System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_TOOL_DIR", p 0)'
    StrCpy $1 $1 6
    StrCmp $1 "ADDED" 0 ci_exists
      DetailPrint "Added $R0 to system PATH"
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
      Goto ci_done
    ci_exists:
      DetailPrint "$R0 is already in system PATH"
      Goto ci_done

  ci_skip:
    DetailPrint "scrcpy-win64 not found, skipping PATH update"

  ci_done:
  Pop $R0
  ; Silent installs skip the finish/GUI callbacks; stock may immediately launch.
  ${If} ${Silent}
    VeyloInstaller::EndInstall /NOUNLOAD
  ${EndIf}
!macroend

!macro customUnInstall
  !insertmacro VeyloPrepareBundledProcesses "-EnvOnlyMode"
  Push $R0
  StrCpy $R0 "$INSTDIR\scrcpy-win64"

  StrCpy $0 $R0
  System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_TOOL_DIR", w r0)'
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$dir=$$env:VEYLO_INSTALLER_TOOL_DIR; $$cur=[string][System.Environment]::GetEnvironmentVariable('Path','Machine'); $$parts=$$cur -split ';' | Where-Object { $$_ -ne $$dir -and $$_ -ne '' }; [System.Environment]::SetEnvironmentVariable('Path',($$parts -join ';'),'Machine'); Write-Host 'REMOVED'"`
  Pop $0
  Pop $1
  System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_TOOL_DIR", p 0)'
  StrCpy $1 $1 7
  StrCmp $1 "REMOVED" 0 cu_done
    DetailPrint "Removed $R0 from system PATH"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  cu_done:
  Pop $R0
!macroend
