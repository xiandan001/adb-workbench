!include "installer-ui.nsh"

!macro customInit
  Call VeyloInitLanguage
  StrCpy $0 "$INSTDIR\scrcpy-win64"
  System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_TOOL_DIR", w r0)'
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$dir=$$env:VEYLO_INSTALLER_TOOL_DIR; $$names=@('adb.exe','scrcpy.exe','fastboot.exe'); $$procs=Get-CimInstance Win32_Process | Where-Object { $$path=$$_.ExecutablePath; $$name=$$_.Name; $$path -and $$name -and ($$names -contains $$name) -and $$path.StartsWith(($$dir.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase) }; foreach($$proc in $$procs){ Stop-Process -Id $$proc.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 350; Write-Host 'TOOLS_CLEANED'"`
  Pop $0
  Pop $1
  System::Call 'kernel32::SetEnvironmentVariableW(w "VEYLO_INSTALLER_TOOL_DIR", p 0)'
  DetailPrint "Prepared bundled Android tools for update"
!macroend

!macro customInstall
  !insertmacro VeyloSaveInstallerLanguage
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
!macroend

!macro customUnInstall
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
