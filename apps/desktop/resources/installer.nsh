; ============================================================================
; Fairy NSIS 自定义脚本（阶段 6 打包硬化 / DEV_PLAN §6.6.1）
;
;   - 「安装选项」页：开机自启复选框（**默认勾选**）；
;   - customInit：默认勾选状态（静默安装 /S 也按默认开启）；
;   - customInstall：按选择写 HKCU\...\Run（键名 = AUMID `com.fairy.assistant`，与
;     app.setLoginItemSettings 的默认 name 一致；值 = "$INSTDIR\Fairy.exe"，
;     app.getLoginItemSettings({path}) 按「键名 = AUMID + 路径匹配」读回 openAtLogin=true）；
;   - customUnInstall：卸载时清理自启项。
;
; 注意 1：electron-builder 把本文件放在生成脚本的 header（早于 MUI2.nsh / nsDialogs.nsh），
; 因此所有用到 MUI2 / nsDialogs 宏的代码都包在宏里，延迟到插入点（此时两者已 include）展开。
; 注意 2：安装器专用的 Var/宏都放在 !ifndef BUILD_UNINSTALLER 里 —— 否则卸载器那次
; 中间编译会因"变量从未使用"的 warning（被当 error）而失败。
; ============================================================================
!include LogicLib.nsh
!include nsDialogs.nsh

!ifndef BUILD_UNINSTALLER

  Var fairyAutoStart
  Var fairyAutoStartCtl

  ; 「安装选项」页的页面函数（用到 MUI_HEADER_TEXT / NSD_* 宏 → 延迟展开）
  !macro fairyDefineAutoStartPage
    Function fairyAutoStartPageCreate
      !insertmacro MUI_HEADER_TEXT "安装选项" "选择是否随 Windows 自动启动 Fairy"
      nsDialogs::Create 1018
      Pop $fairyAutoStartCtl
      ${If} $fairyAutoStartCtl == error
        Abort
      ${EndIf}
      ${NSD_CreateCheckbox} 0 0 100% 24u "开机自启（随 Windows 启动 Fairy，托盘常驻，日程提醒不丢失）"
      Pop $fairyAutoStartCtl
      ${If} $fairyAutoStart == "1"
        ${NSD_Check} $fairyAutoStartCtl
      ${Else}
        ${NSD_Uncheck} $fairyAutoStartCtl
      ${EndIf}
      nsDialogs::Show
    FunctionEnd

    Function fairyAutoStartPageLeave
      ${NSD_GetState} $fairyAutoStartCtl $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $fairyAutoStart "1"
      ${Else}
        StrCpy $fairyAutoStart "0"
      ${EndIf}
    FunctionEnd
  !macroend

  ; 默认勾选（.onInit；静默安装不显示页面，也按默认开启）
  !macro customInit
    StrCpy $fairyAutoStart "1"
  !macroend

  ; 目录页之后、复制文件之前：显示安装选项页
  !macro customPageAfterChangeDir
    !insertmacro fairyDefineAutoStartPage
    Page custom fairyAutoStartPageCreate fairyAutoStartPageLeave
  !macroend

  ; 复制完成后写自启项（用户取消勾选则确保清掉旧值，与 UI 选择一致）
  ; 键名必须是 AUMID（com.fairy.assistant）：Electron 的 openAtLogin 只认这个默认名
  !macro customInstall
    ${If} $fairyAutoStart == "1"
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.fairy.assistant" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\""
    ${Else}
      DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.fairy.assistant"
    ${EndIf}
  !macroend

!endif

; 卸载时清理自启项（幂等）
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.fairy.assistant"
!macroend
