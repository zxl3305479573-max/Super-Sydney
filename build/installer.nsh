!include "LogicLib.nsh"

; 1. 替换默认 CHECK_APP_RUNNING：
;    避免 electron-builder 默认脚本调用 PowerShell Get-CimInstance Win32_Process（部分机器 WMI 挂起或无法识别路径导致漏杀进程），
;    改为轻量 nsProcess 检测 + taskkill /F /T 连同嵌入式 WebContentsView 子进程树一并收尾。
!macro customCheckAppRunning
  ${If} $PowerShellPath == ""
    StrCpy $PowerShellPath "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}

  ${If} ${isUpdated}
    StrCpy $R1 0
    ${DoWhile} $R1 < 6
      nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
      Pop $R0
      ${If} $R0 != 0
        ${Break}
      ${EndIf}
      Sleep 450
      IntOp $R1 $R1 + 1
    ${Loop}
  ${EndIf}

  nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
  Pop $R0
  ${If} $R0 == 0
    ${IfNot} ${Silent}
      ${IfNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
        Quit
      ${EndIf}
    ${EndIf}
    DetailPrint "$(appClosing)"
    nsProcess::_CloseProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    Sleep 500
    nsExec::ExecToStack `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $R0
    Pop $R1
    nsProcess::_KillProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    Sleep 700
  ${EndIf}
  nsProcess::_Unload
!macroend

; 2. 替换默认 un.atomicRMDir：
;    避免应用安装在非系统盘（如 D:\）时跨盘符 Rename 到 C:\Temp 失败或因 \Uninstall Sydney.exe 反斜杠匹配缺陷报错退出码 2。
!macro customRemoveFiles
  StrCmp "" "1" 0 _sydneySkipDeadUninstRefs
    Push ""
    Call un.atomicRMDir
    Pop $R0
    Push ""
    Call un.restoreFiles
    Pop $R0
  _sydneySkipDeadUninstRefs:

  SetOutPath $TEMP
  StrCpy $R1 0
  ${DoWhile} $R1 < 10
    ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ${Break}
    ${EndIf}
    ClearErrors
    Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${IfNot} ${Errors}
      ${Break}
    ${EndIf}
    nsExec::ExecToStack `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $R2
    Pop $R3
    Sleep 500
    IntOp $R1 $R1 + 1
  ${Loop}

  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\swiftshader"
  Delete /REBOOTOK "$INSTDIR\*.dll"
  Delete /REBOOTOK "$INSTDIR\*.pak"
  Delete /REBOOTOK "$INSTDIR\*.bin"
  Delete /REBOOTOK "$INSTDIR\*.dat"
  Delete /REBOOTOK "$INSTDIR\*.json"
  Delete /REBOOTOK "$INSTDIR\*.html"
  Delete /REBOOTOK "$INSTDIR\*.txt"
  Delete /REBOOTOK "$INSTDIR\*.ico"
  Delete /REBOOTOK "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

  ${IfNot} ${isUpdated}
    Delete /REBOOTOK "$INSTDIR\${UNINSTALL_FILENAME}"
    RMDir /r /REBOOTOK "$INSTDIR"
  ${EndIf}
  ClearErrors
!macroend

; 3. 兼容从旧版本（如 v0.1.8 及更早）升级时的兜底清理：
;    旧版自带的 Uninstall Sydney.exe 仍含跨盘符 atomicRMDir 缺陷，返回退出码 2 时由新版安装器直接接管清理旧目录，不中断升级。
!macro _sydneyRecoverOldUninstall REG_ROOT
  ${If} ${Errors}
  ${OrIf} $R0 != 0
    DetailPrint "Old uninstaller returned $R0, performing direct upgrade cleanup..."
    ClearErrors
    ReadRegStr $R1 ${REG_ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R1 == ""
      StrCpy $R1 "$INSTDIR"
    ${EndIf}

    ${If} $R1 != ""
    ${AndIf} ${FileExists} "$R1\*.*"
      SetOutPath $TEMP
      nsExec::ExecToStack `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
      Pop $R2
      Pop $R3
      Sleep 600

      StrCpy $R2 0
      ${DoWhile} $R2 < 8
        ${IfNot} ${FileExists} "$R1\${APP_EXECUTABLE_FILENAME}"
          ${Break}
        ${EndIf}
        ClearErrors
        Delete "$R1\${APP_EXECUTABLE_FILENAME}"
        ${IfNot} ${Errors}
          ${Break}
        ${EndIf}
        Sleep 500
        IntOp $R2 $R2 + 1
      ${Loop}

      ${If} ${FileExists} "$R1\${APP_EXECUTABLE_FILENAME}"
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
        SetErrorLevel 2
        Quit
      ${EndIf}

      RMDir /r "$R1\resources"
      RMDir /r "$R1\locales"
      RMDir /r "$R1\swiftshader"
      Delete /REBOOTOK "$R1\*.dll"
      Delete /REBOOTOK "$R1\*.pak"
      Delete /REBOOTOK "$R1\*.bin"
      Delete /REBOOTOK "$R1\*.dat"
      Delete /REBOOTOK "$R1\*.json"
      Delete /REBOOTOK "$R1\*.html"
      Delete /REBOOTOK "$R1\*.txt"
      Delete /REBOOTOK "$R1\*.ico"
      Delete /REBOOTOK "$R1\${UNINSTALL_FILENAME}"
      ${If} $R1 != "$INSTDIR"
        RMDir /REBOOTOK "$R1"
      ${EndIf}
    ${EndIf}

    ClearErrors
    StrCpy $R0 0
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro _sydneyRecoverOldUninstall SHELL_CONTEXT
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro _sydneyRecoverOldUninstall HKCU
!macroend
