/**
 * renderer ⇄ main 的 IPC 边界（DEV_PLAN §6 阶段 2 + 阶段 3）。
 *
 * handlers：
 * - 阶段 2：gateway:getState / gateway:configure / app:openExternal
 * - 通道选择（DEV_PLAN §5.6，通道名一律用 @fairy/core 的 IPC.channel* 常量）：
 *   channel:get / channel:saveApi / channel:select / channel:start / channel:stop / channel:test
 *   （channel:test 替代旧 gateway:testChat，按当前通道探活）
 * - 阶段 3：会话 CRUD 与聊天（通道名一律用 @fairy/core 的 IPC 常量，勿手写字符串）：
 *   session:list / session:create / session:remove / chat:history / chat:send / chat:stop
 * - 阶段 4：记忆面板：memory:list / memory:add / memory:update / memory:remove /
 *   memory:export / memory:import；add/update/remove/import 成功后广播 memory:changed
 *   （聊天管道的 remember/forget/抽取变更在 chat.ts/extract.ts 内广播，双路汇一）
 * - 阶段 5：日程面板：event:list / event:add / event:complete / event:remove；
 *   add/complete/remove 成功后广播 event:changed（聊天管道 schedule_* 与通知轮询变更在
 *   chat.ts/notify-loop.ts 内广播，三路汇一）
 * 事件广播：
 * - 网关状态：sidecar onState → broadcast('gateway:state')，300ms 去抖合并（'gateway:state' 为阶段 2 遗留通道名，不在 IPC 常量表，保持兼容）
 * - 聊天事件（delta/done/busy）与会话变化（session:changed）由 chat.ts 直接走 windows.broadcast
 * 托盘：login_failed → 红图标 + 异常 tooltip（tray 实例由 index.ts 创建后经 registerTray 注入）。
 */
import { app, ipcMain, nativeImage, shell } from 'electron'
import type { Tray } from 'electron'
import { join } from 'node:path'
import { IPC, APP_NAME, FAIRY_VERSION } from '@fairy/core'
import type {
  ApiChannelConfig,
  ChannelKind,
  EventListFilter,
  GatewayAccountConfig,
  GatewayState,
  MemoryKind,
  MemoryListFilter,
  ScheduleScope
} from '@fairy/core'
import {
  createSession,
  getMemoryStore,
  listHistory,
  listSessions,
  removeSession,
  sendChat,
  stopChat
} from './chat'
import { getEventStore } from './events'
import { broadcast } from './windows'
import { configureGateway, getGatewayState, onGatewayStateChanged } from './sidecar'
import {
  channelTest,
  getChannelState,
  saveApi,
  selectChannel,
  startGatewayAction,
  stopGatewayAction
} from './channel'

let tray: Tray | null = null
let normalIcon: Electron.NativeImage | null = null
let redIcon: Electron.NativeImage | null = null
let iconsResolved = false

// ===== 阶段 4：记忆入参校验（IPC 边界不信任 renderer，坏输入 throw → invoke reject） =====

const MEMORY_KINDS: readonly MemoryKind[] = ['preference', 'fact', 'note', 'decision', 'topic']

function normalizeKind(value: unknown): MemoryKind | undefined {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
    ? (value as MemoryKind)
    : undefined
}

function parseMemoryAdd(input: unknown): { content: string; kind?: MemoryKind } {
  const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const content = typeof obj.content === 'string' ? obj.content.trim() : ''
  if (content === '') throw new Error('content 必须为非空字符串')
  const kind = normalizeKind(obj.kind)
  return kind ? { content, kind } : { content }
}

function parseMemoryPatch(patch: unknown): {
  content?: string
  kind?: MemoryKind
  weight?: number
} {
  const obj = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>
  const next: { content?: string; kind?: MemoryKind; weight?: number } = {}
  if (obj.content !== undefined) {
    const content = typeof obj.content === 'string' ? obj.content.trim() : ''
    if (content === '') throw new Error('content 必须为非空字符串')
    next.content = content
  }
  if (obj.kind !== undefined) {
    const kind = normalizeKind(obj.kind)
    if (!kind) throw new Error('kind 非法')
    next.kind = kind
  }
  if (obj.weight !== undefined) {
    if (typeof obj.weight !== 'number' || !Number.isFinite(obj.weight)) {
      throw new Error('weight 必须为数字')
    }
    next.weight = obj.weight
  }
  return next
}

function parseMemoryId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('id 必须为整数')
  return id
}

function parseMemoryFilter(filter: unknown): MemoryListFilter | undefined {
  const obj = (typeof filter === 'object' && filter !== null ? filter : {}) as Record<string, unknown>
  const kind = obj.kind === 'all' ? 'all' : normalizeKind(obj.kind)
  const query = typeof obj.query === 'string' && obj.query !== '' ? obj.query : undefined
  const limit =
    typeof obj.limit === 'number' && Number.isFinite(obj.limit) && obj.limit > 0
      ? Math.floor(obj.limit)
      : undefined
  if (kind === undefined && query === undefined && limit === undefined) return undefined
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(query !== undefined ? { query } : {}),
    ...(limit !== undefined ? { limit } : {})
  }
}

// ===== 阶段 5：日程入参校验（IPC 边界不信任 renderer，坏输入 throw → invoke reject） =====

function parseEventId(id: unknown): number {
  if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('id 必须为整数')
  return id
}

function parseEventAdd(input: unknown): { title: string; remindAt: number; notes?: string | null } {
  const obj = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  if (title === '') throw new Error('title 必须为非空字符串')
  if (typeof obj.remindAt !== 'number' || !Number.isFinite(obj.remindAt)) {
    throw new Error('remindAt 必须为有限数字（epoch 毫秒）')
  }
  const notes = typeof obj.notes === 'string' && obj.notes.trim() !== '' ? obj.notes.trim() : null
  return { title, remindAt: obj.remindAt, notes }
}

function parseEventDone(done: unknown): boolean {
  if (typeof done !== 'boolean') throw new Error('done 必须为布尔值')
  return done
}

function parseScheduleScope(value: unknown): ScheduleScope | undefined {
  return value === 'today' || value === 'tomorrow' || value === 'week' || value === 'all'
    ? value
    : undefined
}

/** 与 parseMemoryFilter 同策略：坏字段静默丢弃（缺省 = 全量含已完成），不 reject */
function parseEventFilter(filter: unknown): EventListFilter | undefined {
  const obj = (typeof filter === 'object' && filter !== null ? filter : {}) as Record<string, unknown>
  const scope = parseScheduleScope(obj.scope)
  const includeDone = typeof obj.includeDone === 'boolean' ? obj.includeDone : undefined
  const limit =
    typeof obj.limit === 'number' && Number.isFinite(obj.limit) && obj.limit > 0
      ? Math.floor(obj.limit)
      : undefined
  if (scope === undefined && includeDone === undefined && limit === undefined) return undefined
  return {
    ...(scope !== undefined ? { scope } : {}),
    ...(includeDone !== undefined ? { includeDone } : {}),
    ...(limit !== undefined ? { limit } : {})
  }
}

function iconsDir(): string {
  // 开发态：项目 resources/；打包后：extraResources（与 windows.ts iconPath() 规则一致）
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

function ensureIcons(): void {
  if (iconsResolved) return
  iconsResolved = true
  normalIcon = nativeImage.createFromPath(join(iconsDir(), 'icon.png'))
  redIcon = nativeImage.createFromPath(join(iconsDir(), 'icon-red.png'))
}

/** tray 实例由 index.ts 创建后注入；保持 index.ts 简洁 */
export function registerTray(t: Tray): void {
  tray = t
  ensureIcons()
}

/** login_failed（含 getGatewayState 派生的会话过期）→ 托盘红 + 异常 tooltip；否则恢复 */
export function setTrayState(state: GatewayState): void {
  if (!tray) return
  ensureIcons()
  if (state.accountStatus === 'login_failed') {
    tray.setImage(redIcon?.isEmpty() ? nativeImage.createEmpty() : (redIcon ?? nativeImage.createEmpty()))
    tray.setToolTip(`🧚 ${APP_NAME} · 会话异常（点击打开设置）`)
  } else {
    tray.setImage(normalIcon?.isEmpty() ? nativeImage.createEmpty() : (normalIcon ?? nativeImage.createEmpty()))
    tray.setToolTip(`${APP_NAME} v${FAIRY_VERSION}`)
  }
}

export function registerIpcHandlers(): void {
  // ===== 阶段 2：网关 / 外链 =====
  ipcMain.handle('gateway:getState', () => getGatewayState())
  ipcMain.handle('gateway:configure', (_event, input: GatewayAccountConfig) => configureGateway(input))

  // ===== 通道选择（DEV_PLAN §5.6；启动不自动登录，网页网关需显式 channel:start） =====
  ipcMain.handle(IPC.channelGet, () => getChannelState())
  ipcMain.handle(IPC.channelSaveApi, (_event, cfg: ApiChannelConfig) => saveApi(cfg))
  ipcMain.handle(IPC.channelSelect, (_event, channel: ChannelKind) => selectChannel(channel))
  ipcMain.handle(IPC.channelStart, () => startGatewayAction())
  ipcMain.handle(IPC.channelStop, () => stopGatewayAction())
  ipcMain.handle(IPC.channelTest, (_event, message: string) => channelTest(message))

  // 外链一律系统浏览器；只放行 http/https，其他协议 reject
  ipcMain.handle('app:openExternal', async (_event, url: unknown) => {
    if (typeof url !== 'string') throw new Error('URL 必须为字符串')
    let protocol = ''
    try {
      protocol = new URL(url).protocol
    } catch {
      throw new Error(`无法解析 URL：${url}`)
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`拒绝打开非 http/https 链接：${url}`)
    }
    await shell.openExternal(url)
  })

  // ===== 阶段 3：会话 + 聊天（通道名用 IPC 常量；store 操作在 chat.ts） =====
  ipcMain.handle(IPC.sessionList, () => listSessions())
  ipcMain.handle(IPC.sessionCreate, () => createSession())
  ipcMain.handle(IPC.sessionRemove, (_event, id: unknown) => {
    if (typeof id !== 'string' || id === '') throw new Error('session id 必须为非空字符串')
    removeSession(id)
  })
  ipcMain.handle(IPC.chatHistory, (_event, id: unknown, limit?: unknown) => {
    if (typeof id !== 'string') throw new Error('session id 必须为字符串')
    return listHistory(id, typeof limit === 'number' ? limit : undefined)
  })
  ipcMain.handle(IPC.chatSend, (_event, id: unknown, text: unknown) => {
    if (typeof id !== 'string') return { ok: false, error: '参数错误' }
    return sendChat(id, typeof text === 'string' ? text : '')
  })
  ipcMain.handle(IPC.chatStop, (_event, id: unknown) => {
    if (typeof id !== 'string') return
    return stopChat(id)
  })

  // ===== 阶段 4：记忆（面板 CRUD；add/update/remove/import 成功后广播 memoryChanged） =====
  ipcMain.handle(IPC.memoryList, (_event, filter?: unknown) =>
    getMemoryStore().list(parseMemoryFilter(filter))
  )
  ipcMain.handle(IPC.memoryAdd, (_event, input: unknown) => {
    const record = getMemoryStore().add(parseMemoryAdd(input))
    broadcast(IPC.memoryChanged)
    return record
  })
  ipcMain.handle(IPC.memoryUpdate, (_event, id: unknown, patch: unknown) => {
    getMemoryStore().update(parseMemoryId(id), parseMemoryPatch(patch))
    broadcast(IPC.memoryChanged)
  })
  ipcMain.handle(IPC.memoryRemove, (_event, id: unknown) => {
    getMemoryStore().remove(parseMemoryId(id))
    broadcast(IPC.memoryChanged)
  })
  ipcMain.handle(IPC.memoryExport, () => getMemoryStore().exportAll())
  ipcMain.handle(IPC.memoryImport, (_event, raw: unknown) => {
    const result = getMemoryStore().importMany(raw)
    broadcast(IPC.memoryChanged)
    return result
  })

  // ===== 阶段 5：日程（面板 CRUD；与聊天管道/通知轮询同库，add/complete/remove 成功后广播 eventChanged） =====
  ipcMain.handle(IPC.eventList, (_event, filter?: unknown) =>
    getEventStore().listEvents(parseEventFilter(filter))
  )
  ipcMain.handle(IPC.eventAdd, (_event, input: unknown) => {
    const record = getEventStore().addEvent(parseEventAdd(input))
    broadcast(IPC.eventChanged)
    return record
  })
  ipcMain.handle(IPC.eventComplete, (_event, id: unknown, done: unknown) => {
    getEventStore().completeEvent(parseEventId(id), parseEventDone(done))
    broadcast(IPC.eventChanged)
  })
  ipcMain.handle(IPC.eventRemove, (_event, id: unknown) => {
    getEventStore().removeEvent(parseEventId(id))
    broadcast(IPC.eventChanged)
  })

  // 网关状态广播：sidecar onState → 全窗口 send；300ms 去抖合并高频变化
  let pending: GatewayState | null = null
  let timer: NodeJS.Timeout | null = null
  onGatewayStateChanged((state) => {
    pending = state
    setTrayState(state) // 托盘立即更新，不等去抖
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      if (!pending) return
      const snapshot = pending
      pending = null
      broadcast('gateway:state', snapshot)
    }, 300)
  })
}
