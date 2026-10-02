/**
 * 启动与生命周期（阶段 3 起瘦身：窗口/托盘状态/IPC/热键各归其位）。
 * - 窗口（主 + 浮窗）→ windows.ts；热键 → hotkeys.ts；聊天编排 → chat.ts
 * - 本文件只留：userData 初始化、托盘、单实例锁、退出时 sidecar 回收。
 */
import { app, BrowserWindow, Menu, Notification, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import { APP_NAME, FAIRY_VERSION } from '@fairy/core'
import { initUserDataPath } from './config'
import { initEvents } from './events'
import { initNotifyLoop, shutdownNotifyLoop } from './notify-loop'
import { initSidecar, shutdownSidecar } from './sidecar'
import { registerIpcHandlers, registerTray } from './ipc'
import {
  createFloatWindow,
  createMainWindow,
  iconPath,
  showMainWindow,
  toggleFloat
} from './windows'
import { initChat, shutdownChat } from './chat'
import { registerHotkeys, unregisterHotkeys } from './hotkeys'

// DEV_PLAN §7：尽早把 userData 指到 %APPDATA%/fairy（小写 fairy），必须先于一切读取 userData 的逻辑
initUserDataPath()

let tray: Tray | null = null

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath())
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  tray.setToolTip(`${APP_NAME} v${FAIRY_VERSION}`)

  // 托盘状态更新（红图标）逻辑注入 ipc.ts，保持本文件简洁
  registerTray(tray)

  const autoStart = app.getLoginItemSettings().openAtLogin

  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showMainWindow() },
    { label: '快速问答 (Alt+Space)', click: () => toggleFloat() },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: autoStart,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { type: 'separator' },
    {
      label: `关于 ${APP_NAME}`,
      click: () =>
        new Notification({
          title: APP_NAME,
          body: `版本 ${FAIRY_VERSION}（阶段 3）`
        }).show()
    },
    { label: '退出', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => showMainWindow())
}

// 单实例锁：防止多开导致 sidecar/数据文件竞争
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
  app.whenReady().then(() => {
    createMainWindow()
    createFloatWindow() // 预建隐藏：Alt+Space show 即出（DEV_PLAN §8 风险表）
    createTray()
    initEvents(join(app.getPath('userData'), 'fairy.db')) // 日程存储（独立连接同一 fairy.db，先于 IPC handler）
    initNotifyLoop() // §5.3 30s 通知轮询 + §8 启动清扫（先于 IPC handler）
    registerIpcHandlers()
    initSidecar()
    initChat()
    registerHotkeys()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
}

// 退出前解除全局热键（globalShortcut.unregisterAll 幂等，未注册也安全）
app.on('will-quit', () => unregisterHotkeys())

// 退出前：先同步弹未触发日程提示 + 清通知轮询（尽力而为），再清空闲记忆抽取定时器，
// 最后停掉网关子进程（防 Windows 僵尸进程）；幂等防重入，3s 兜底超时在 shutdownSidecar 内
let shuttingDown = false
app.on('before-quit', (event) => {
  if (shuttingDown) {
    event.preventDefault()
    return
  }
  shuttingDown = true
  event.preventDefault()
  shutdownNotifyLoop()
  shutdownChat()
  shutdownSidecar().finally(() => app.exit())
})

app.on('window-all-closed', () => {
  // MVP：留在托盘常驻；阶段 6 再加"是否退出"逻辑
})
