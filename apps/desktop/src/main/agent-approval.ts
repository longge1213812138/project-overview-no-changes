/**
 * 阶段 7：工具审批请求生命周期（main 进程侧，DEV_PLAN §5.7）。
 *
 * - requestApproval：由 createRegistryAuthorizer 的 confirm 回调调用；生成自增 id →
 *   入 pending map → 广播 agent:approvalRequest（所有窗口，任一窗口 respond 第一个生效）；
 *   60s 超时 / AbortSignal 中止 / 生成结束（cancelAllPending）都必须收敛为 false，
 *   并广播 agent:approvalSettled 关闭 renderer 对话框 —— 审批绝不悬挂。
 * - respondApproval：未知/重复 id 静默忽略（幂等）；结算时广播 settled{id, approved}。
 * - 每次审批的发起/结算都 log.info('[approval]', ...)：安全决策全程可追踪（DEV_PLAN 要求）。
 *
 * 依赖单向：agent-approval → windows/logger（均不回 import agent-approval）。
 */
import { IPC } from '@fairy/core'
import type { AgentApprovalRequest, AgentApprovalSettledEvent } from '@fairy/core'
import { log } from './logger'
import {
  broadcast,
  getFloatWindow,
  getMainWindow,
  releaseFloatIfBlurred,
  setFloatApprovalGate,
  summonForApproval
} from './windows'

/** 审批超时（毫秒）：超时未决策 → 拒绝并 settled{reason:'timeout'} */
const APPROVAL_TIMEOUT_MS = 60_000

interface PendingApproval {
  request: AgentApprovalRequest
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

/** id → 待审批请求（同一时刻至多每 id 一条） */
const pending = new Map<number, PendingApproval>()

/** 自增审批 id（模块级单例；renderer 回传的 id 必须来自这里） */
let seq = 0

/** 窗口可见性描述（诊断日志用） */
function describeWin(win: Electron.BrowserWindow | null): string {
  if (!win || win.isDestroyed()) return 'gone'
  if (!win.isVisible()) return 'hidden'
  return win.isFocused() ? 'focused' : 'visible-blurred'
}

// 阶段 7：有待审审批时浮窗不收（Esc=拒绝键、失焦也不藏框）
setFloatApprovalGate(() => pending.size > 0)

/**
 * 结算一条 pending（幂等）：出 map → 清 timer/abort listener → resolve →
 * 广播 settled → log。重复结算（超时与 respond 竞态等）静默返回。
 */
function settle(id: number, approved: boolean, reason?: 'timeout' | 'cancelled'): void {
  const entry = pending.get(id)
  if (!entry) return
  pending.delete(id)
  clearTimeout(entry.timer)
  if (entry.signal && entry.onAbort) {
    entry.signal.removeEventListener('abort', entry.onAbort)
  }
  entry.resolve(approved)

  const event: AgentApprovalSettledEvent = {
    id,
    approved,
    ...(reason !== undefined ? { reason } : {})
  }
  broadcast(IPC.agentApprovalSettled, event)
  // 审批期间浮窗被豁免失焦收起：结算后若已失焦则补收（恢复阶段 3 规格行为）
  releaseFloatIfBlurred()
  log.info(
    '[approval]',
    `结算 id=${id} tool=${entry.request.tool.name} risk=${entry.request.tool.risk} ` +
      `outside=${entry.request.outside} approved=${approved}` +
      `${reason !== undefined ? ` reason=${reason}` : ''}（剩余 pending=${pending.size}）`
  )
}

/**
 * 请求用户审批。保证收敛：
 * - 60_000ms 超时 → false + settled{reason:'timeout'}
 * - opts.signal abort → false + settled{reason:'cancelled'}
 * - respondApproval(id, approved) → approved + settled{id, approved}
 * resolve 后清理 timer/listener（幂等：重复结算不再生效）。
 */
export function requestApproval(
  req: Omit<AgentApprovalRequest, 'id'>,
  opts: { signal?: AbortSignal }
): Promise<boolean> {
  const id = ++seq
  const request: AgentApprovalRequest = { id, ...req }
  const signal = opts.signal

  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => settle(id, false, 'cancelled')
    const timer = setTimeout(() => settle(id, false, 'timeout'), APPROVAL_TIMEOUT_MS)
    pending.set(id, { request, resolve, timer, signal, onAbort })

    log.info(
      '[approval]',
      `请求 id=${id} tool=${request.tool.name} risk=${request.tool.risk} ` +
        `source=${request.tool.source} outside=${request.outside}` +
        `${request.reason !== undefined ? ` reason=${request.reason}` : ''}` +
        // 诊断：发起时两窗可见性（GUI 验收「没弹框」排查：框渲染在了哪个窗、当时可见吗）
        ` | main=${describeWin(getMainWindow())} float=${describeWin(getFloatWindow())}`
    )

    // 发起时已中止：不打扰 renderer（请求也不广播），直接按取消结算
    if (signal?.aborted) {
      settle(id, false, 'cancelled')
      return
    }
    // 主动召唤：审批是阻塞工具循环的模态决策，必须确保承载框的窗口在前台
    // （GUI 验收实测：请求渲染在后台窗口里看不见，用户要点托盘才看到）
    summonForApproval()
    signal?.addEventListener('abort', onAbort, { once: true })
    broadcast(IPC.agentApprovalRequest, request)
    // 双保险：紧跟着发一条独立的对账指令。两条事件任一到达 renderer 都会
    // 拿到权威队列（request 负责入队展示、syncReq 负责校准），单条丢失自愈
    broadcast(IPC.agentApprovalSyncReq)
    // 三保险：延迟 500ms 再发一次 syncReq。覆盖 renderer 正在重建（HMR / 窗口重建）
    // 导致前两条广播丢失的场景——延迟到达时 renderer 已挂载、IPC 监听已就绪。
    // （GUI 验收实测：第二次审批框不弹，根因 = 广播在 renderer 挂载前发出）
    setTimeout(() => {
      if (pending.has(id)) {
        log.info('[approval]', `延迟对账 id=${id}（500ms 后补发 syncReq）`)
        broadcast(IPC.agentApprovalSyncReq)
      }
    }, 500)
  })
}

/**
 * renderer 经 agent:approvalRespond 提交决定。
 * 返回 true = 已受理；false = id 陈旧/未知（超时或另一窗口已结算）——
 * 调用方（preload/renderer）据此触发权威对账，避免陈旧点击静默丢失。
 */
export function respondApproval(id: number, approved: boolean): boolean {
  if (!pending.has(id)) {
    log.info('[approval]', `忽略未知/重复 id=${id} approved=${approved}`)
    return false
  }
  settle(id, approved)
  return true
}

/** 权威对账：当前真正未决的审批（renderer 挂载/新请求/提交被忽略时拉取） */
export function getPendingApprovals(): AgentApprovalRequest[] {
  return [...pending.values()].map((entry) => entry.request)
}

/** 全部未决审批结算为 false + settled{reason}（生成 finally / 退出时清悬挂） */
export function cancelAllPending(reason: 'cancelled'): void {
  for (const id of [...pending.keys()]) {
    settle(id, false, reason)
  }
}
