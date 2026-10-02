/**
 * 开机自启（阶段 6 / DEV_PLAN §6.6.1）。
 *
 * 三处共用同一套状态，务必一致：
 * 1. NSIS 安装器（`resources/installer.nsh`）：安装选项页「开机自启」**默认勾选**，
 *    勾选则写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`；
 * 2. 本模块：托盘菜单 / 设置页开关走 `app.setLoginItemSettings`（写/删同一个 Run 值）；
 * 3. 读状态：`app.getLoginItemSettings({ path: process.execPath })`。
 *
 * **注册表值名必须是 AUMID（`com.fairy.assistant`）**——实测（Electron 39）：
 * `openAtLogin` 只认「值名 = AUMID」的 Run 项；值名不一致时只有
 * `executableWillLaunchAtLogin` 为 true，UI 会显示"未开启"。因此：
 * - 安装器写 `com.fairy.assistant`（installer.nsh）；
 * - `setLoginItemSettings` 传同样的 name（缺省也取 AUMID，显式传更稳）；
 * - `app.setAppUserModelId('com.fairy.assistant')` 必须在 index.ts 早期调用。
 *
 * 值数据 = `"<exe 路径>"`（带引号亦可，实测两种都能被路径匹配到）。
 *
 * 开发态（pnpm dev）process.execPath 是 electron.exe：写 Run 值等于"开机自启 electron.exe"，
 * 不是真正的产品行为；设置页会标注这一点，验证自启请用打包产物。
 */
import { app } from 'electron'

/** Run 值名 = AUMID（与 resources/installer.nsh 的 WriteRegStr 保持一致） */
export const AUTOSTART_RUN_NAME = 'com.fairy.assistant'

export function isAutoStartEnabled(): boolean {
  return app.getLoginItemSettings({ path: process.execPath }).openAtLogin
}

/** 开关开机自启；返回设置后的实际状态（写失败时如实回报） */
export function setAutoStart(enabled: boolean): boolean {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    name: AUTOSTART_RUN_NAME,
    path: process.execPath
  })
  return isAutoStartEnabled()
}
