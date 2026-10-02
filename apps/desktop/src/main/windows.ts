/**
 * 双窗口管理：主窗口 + 浮窗（DEV_PLAN §6 阶段 3 第 3 条 / §8 风险表）。
 *
 * - createMainWindow：阶段 2 index.ts 的主窗口逻辑搬过来（外链 handler、did-finish-load 补发状态保留）；
 * - createFloatWindow：无边框 380×560、alwaysOnTop、skipTaskbar，**启动时预建隐藏**（风险表："show 即出"）；
 *   Esc / 失焦收起；toggleFloat 由 Alt+Space 热键与托盘菜单共用。
 * - broadcast：事件统一发给所有窗口（聊天 delta/done/busy、sessionChanged、gateway:state）。
 */
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { APP_NAME, FAIRY_VERSION } from '@fairy/core'
import { getGatewayState } from './sidecar'

let mainWin: BrowserWindow | null = null
let floatWin: BrowserWindow | null = null

/** 开发态：项目 resources/；打包后：extraResources（阶段 2 规则不变） */
export function iconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources/icon.png')
}

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

export function getMainWindow(): BrowserWindow | null {
  return mainWin
}

export function getFloatWindow(): BrowserWindow | null {
  return floatWin
}

/** 显示主窗口；窗口已销毁则重建 */
export function showMainWindow(): void {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show()
    mainWin.focus()
    return
  }
  void createMainWindow()
}

/** Alt+Space / 托盘「快速问答」：可见 → hide；不可见 → show + focus + 置顶（防被新窗口压住后仍置顶） */
export function toggleFloat(): void {
  if (floatWin && !floatWin.isDestroyed()) {
    if (floatWin.isVisible()) {
      hideFloat()
    } else {
      floatWin.show()
      floatWin.focus()
      floatWin.setAlwaysOnTop(true)
    }
    return
  }
  // 浮窗被意外销毁的兜底：按需重建后同样 show + focus + 置顶
  void createFloatWindow().then(() => {
    if (floatWin && !floatWin.isDestroyed()) {
      floatWin.show()
      floatWin.focus()
      floatWin.setAlwaysOnTop(true)
    }
  })
}

export function hideFloat(): void {
  if (floatWin && !floatWin.isDestroyed()) {
    floatWin.hide()
  }
}

/** 向所有存活窗口广播事件（聊天 / 会话 / 网关状态统一走这里，双窗口同步） */
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

/** webContents 'did-finish-load' 后补发一次当前网关状态（窗口加载晚于状态变化时的兜底，双窗口统一在此挂） */
export function sendStateOnFinishLoad(contents: Electron.WebContents): void {
  contents.on('did-finish-load', () => {
    contents.send('gateway:state', getGatewayState())
  })
}

/** 幂等：主窗口存活时直接返回 */
export async function createMainWindow(): Promise<void> {
  if (mainWin && !mainWin.isDestroyed()) return

  const win = new BrowserWindow({
    width: 980,
    height: 640,
    show: false,
    title: `${APP_NAME} ${FAIRY_VERSION}`,
    icon: iconPath(),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  mainWin = win
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
  })

  win.on('ready-to-show', () => win.show())

  // 外链一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 窗口加载完成晚于状态变化时补发一次网关状态
  sendStateOnFinishLoad(win.webContents)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 浮窗预建（隐藏）：主进程常驻托盘，冷启动不阻塞首按 Alt+Space。
 * dev：ELECTRON_RENDERER_URL + '/?float=1'；prod：loadFile(index.html, { search: 'float=1' })。
 * 渲染层（阶段 3 任务 C）读 ?float=1 渲染快速问答形态。
 */
export async function createFloatWindow(): Promise<void> {
  if (floatWin && !floatWin.isDestroyed()) return

  const win = new BrowserWindow({
    width: 380,
    height: 560,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    icon: iconPath(),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  floatWin = win
  win.on('closed', () => {
    if (floatWin === win) floatWin = null
  })

  // 规格：Esc 收起
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      hideFloat()
    }
  })

  // 规格：失焦收起（切到主窗口/其他应用都收）
  win.on('blur', () => hideFloat())

  // 网关状态补发（did-finish-load 时）
  sendStateOnFinishLoad(win.webContents)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl.replace(/\/+$/, '') + '/?float=1')
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: 'float=1' })
  }
}
