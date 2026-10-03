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
import { broadcast, setFloatEscGate } from './windows'

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

// 阶段 7：有待审审批时浮窗 Esc 不收窗（Esc = 审批对话框的拒绝键）
setFloatEscGate(() => pending.size > 0)

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
        `${request.reason !== undefined ? ` reason=${request.reason}` : ''}`
    )

    // 发起时已中止：不打扰 renderer（请求也不广播），直接按取消结算
    if (signal?.aborted) {
      settle(id, false, 'cancelled')
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    broadcast(IPC.agentApprovalRequest, request)
  })
}

/** renderer 经 agent:approvalRespond 提交决定；未知/重复 id 静默忽略 */
export function respondApproval(id: number, approved: boolean): void {
  if (!pending.has(id)) {
    log.info('[approval]', `忽略未知/重复 id=${id} approved=${approved}`)
    return
  }
  settle(id, approved)
}

/** 全部未决审批结算为 false + settled{reason}（生成 finally / 退出时清悬挂） */
export function cancelAllPending(reason: 'cancelled'): void {
  for (const id of [...pending.keys()]) {
    settle(id, false, reason)
  }
}
