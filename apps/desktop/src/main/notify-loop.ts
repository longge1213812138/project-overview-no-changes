/**
 * 日程通知轮询（DEV_PLAN §5.3 + §8，阶段 5 任务 B4，main 进程侧）。
 *
 * - initNotifyLoop()（whenReady 调，幂等）：
 *   ① 启动清扫 sweepMissed()：已到期未触发 → fired=1 不补弹（§8「已过期不补弹，避免惊吓」），
 *      有清扫记录时 console.info 一行；
 *   ② 30s 间隔轮询（unref，不阻止进程退出）：dueEvents() 逐条弹 Electron Notification——
 *      标题「⏰ title」，内容 `${formatEventTime}（${relativeDayLabel}）`，备注换行附上；
 *      点通知 → showMainWindow() + 广播 appOpenTab {tab:'calendar'}；markFired(id) 后广播 eventChanged。
 *   通知构造/展示异常 try/catch 静默一行，不打断循环；每条事件无条件 markFired（单次触发语义，
 *   防坏通知导致每 30s 重试刷屏）。
 * - shutdownNotifyLoop()（before-quit 最前调，同步尽力而为、不阻塞退出）：
 *   清定时器 → pendingEvents()（!done && !fired，含已过期未触发）N>0 → 退出提示通知
 *   「有 N 个日程还未触发：前3条 title…」。
 *
 * 依赖单向：events / windows（均不回 import notify-loop）+ @fairy/core，不 import chat，无环。
 */
import { Notification } from 'electron'
import { IPC, formatEventTime, relativeDayLabel } from '@fairy/core'
import type { EventRecord } from '@fairy/core'
import { getEventStore } from './events'
import { broadcast, showMainWindow } from './windows'

const POLL_INTERVAL_MS = 30_000
/** 退出提示里最多列 3 条标题 */
const EXIT_LIST_LIMIT = 3

let timer: NodeJS.Timeout | null = null

/** whenReady 调用；幂等（重复调用直接返回） */
export function initNotifyLoop(): void {
  if (timer) return

  // ① 启动清扫（§8）：已到期未触发 → 标 fired 不补弹；异常一行静默，不影响启动
  try {
    const swept = getEventStore().sweepMissed()
    if (swept > 0) {
      console.info(`[notify] 启动清扫：${swept} 条已到期未触发的日程标记为已触发（不补弹）`)
    }
  } catch (err) {
    console.warn('[notify] 启动清扫失败：', err instanceof Error ? err.message : err)
  }

  timer = setInterval(tick, POLL_INTERVAL_MS)
  timer.unref?.() // 不阻止退出（与 extract.ts 定时器同规则）
}

/** before-quit 最前调（shutdownChat / shutdownSidecar 之前）；同步、尽力而为 */
export function shutdownNotifyLoop(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }

  // 退出提示（§5.3）：未触发日程（含已过期未触发）→ 一条通知告知；失败静默不阻塞退出
  try {
    const pending = getEventStore().pendingEvents()
    if (pending.length > 0) {
      const head = pending
        .slice(0, EXIT_LIST_LIMIT)
        .map((ev: EventRecord) => ev.title)
        .join('、')
      const more = pending.length > EXIT_LIST_LIMIT ? '…' : ''
      new Notification({
        title: 'Fairy 退出',
        body: `有 ${pending.length} 个日程还未触发：${head}${more}`
      }).show()
    }
  } catch (err) {
    console.warn('[notify] 退出提示失败：', err instanceof Error ? err.message : err)
  }
}

/** 30s 轮询体：到期（remind_at <= now && !fired && !done）→ 逐条通知 + fired=1 + 广播 */
function tick(): void {
  let due: EventRecord[] = []
  try {
    due = getEventStore().dueEvents()
  } catch (err) {
    console.warn('[notify] 轮询查询失败：', err instanceof Error ? err.message : err)
    return
  }

  for (const ev of due) {
    // 通知失败不打断循环（也不重试：单次触发语义，见文件头）
    try {
      const notification = new Notification({
        title: `⏰ ${ev.title}`,
        body: `${formatEventTime(ev.remindAt)}（${relativeDayLabel(ev.remindAt)}）${ev.notes ? '\n' + ev.notes : ''}`
      })
      notification.on('click', () => {
        showMainWindow()
        broadcast(IPC.appOpenTab, { tab: 'calendar' })
      })
      notification.show()
    } catch (err) {
      console.warn('[notify] 通知弹出失败：', err instanceof Error ? err.message : err)
    }

    try {
      getEventStore().markFired(ev.id)
      broadcast(IPC.eventChanged) // 面板「已触发」状态即时同步
    } catch (err) {
      console.warn('[notify] markFired 失败：', err instanceof Error ? err.message : err)
    }
  }
}
