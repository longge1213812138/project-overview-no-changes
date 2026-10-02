/**
 * 日程存储单例（阶段 5 任务 B4，main 进程侧）。
 *
 * - initEvents(dbPath)（whenReady 调，幂等）：createCalendarStore 独立连接同一 fairy.db
 *   （主进程同步串行访问，安全）；必须先于 registerIpcHandlers / initNotifyLoop。
 * - getEventStore()：ipc.ts / chat.ts / notify-loop.ts 共用同一实例（CalendarStore 为 A4 冻结签名）。
 * - 类型复用 ipc.ts 的 EventRecord / EventListFilter / ScheduleScope（契约冻结）。
 *
 * 依赖单向：events 只依赖 @fairy/core，不 import chat / notify-loop（后两者 → events，无环）。
 */
import { createCalendarStore } from '@fairy/core'
import type { CalendarStore } from '@fairy/core'

let store: CalendarStore | null = null

/** whenReady 调用（须先于 IPC handler 注册）；重复调用直接返回 */
export function initEvents(dbPath: string): void {
  if (store) return
  store = createCalendarStore({ dbPath })
}

/** ipc / chat / notify-loop 直调；未初始化直接抛（调用顺序错了要 fail-visible） */
export function getEventStore(): CalendarStore {
  if (!store) throw new Error('日程存储未初始化（initEvents 应先于 IPC handler 注册）')
  return store
}
