import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentApprovalRequest,
  AgentApprovalSettledEvent,
  AgentApprovalSnapshot
} from '@fairy/core'

/**
 * 阶段 7：工具审批对话框（主窗与浮窗各挂一个实例，见 App.tsx；每窗口只订阅一次）。
 *
 * 契约（packages/core/src/ipc.ts FairyApi.agent）：
 * - onApproval 收请求入本地队列（一次只展示队首），respondApproval 提交决定
 *   并返回是否被 main 受理（false = 陈旧 id，已被超时/另一窗口结算）；
 * - onApprovalSettled = 对话框关闭信号，与本地提交共用幂等 Set；
 * - **权威对账**：本地队列可能因订阅空窗期丢事件而与 main 的 pending 脱钩
 *   （GUI 验收实测：陈旧条目占队首挡住新框、点击提交旧 id 被忽略导致真请求
 *   60s 超时）。因此在挂载、收到新请求、提交被忽略三个时机拉取
 *   getPendingApprovals() 以 main 为准校准队列，另有 65s 兜底过期。
 * - renderer 只展示与回传决定，不执行任何工具、不自行放行。
 */
/** risk → 中文标签（配色见 style.css .risk-badge） */
const RISK_LABEL: Record<AgentApprovalRequest['tool']['risk'], string> = {
  read: '只读',
  write: '写入',
  exec: '执行'
}

/** source → 中文标签（skill/mcp 阶段 8 起，统一展示为「扩展」） */
const SOURCE_LABEL: Record<AgentApprovalRequest['tool']['source'], string> = {
  builtin: '内置',
  skill: '扩展',
  mcp: '扩展'
}

/** input 序列化展示上限：超过则截断并加省略注（防超大 payload 拖垮渲染） */
const INPUT_PREVIEW_MAX = 2000

/** 本地队列条目：请求 + 入队时间（对账保留新鲜条目、65s 兜底过期用） */
interface QueueItem {
  request: AgentApprovalRequest
  receivedAt: number
}

/**
 * 对账保留窗口：sync 快照返回与本地 onApproval 入队之间的竞态窗口内（<3s）
 * 刚到的本地条目不因快照未含而被误删；>3s 仍不在快照 = settled 丢失的陈旧残留，删。
 */
const SYNC_FRESH_MS = 3_000
/** main 60s 必然结算，65s 仍在本地 = settled 广播丢失，兜底清除 */
const STALE_MS = 65_000

/** 模型入参原样展示（renderer 不执行、不校验，仅格式化） */
function formatInput(input: unknown): string {
  let text: string
  try {
    text = JSON.stringify(input, null, 2) ?? String(input)
  } catch {
    // 循环引用 / BigInt 等不可序列化值
    text = String(input)
  }
  if (text.length <= INPUT_PREVIEW_MAX) return text
  return `${text.slice(0, INPUT_PREVIEW_MAX)}\n…（输入过长已截断，共 ${text.length} 字符）`
}

export default function ApprovalDialog() {
  /** 待审队列：一次只展示队首，提交/结算后立刻露出下一条 */
  const [queue, setQueue] = useState<QueueItem[]>([])
  /** 快照镜像：respond 回调（useCallback）读最新队列，避免闭包陈旧 */
  const queueRef = useRef<QueueItem[]>([])
  queueRef.current = queue
  /** 已处理 id（本地提交与 settled 可能先后到达，幂等去重） */
  const handledRef = useRef<Set<number>>(new Set())
  /** 默认焦点落在「拒绝」上（Enter = 拒绝，安全默认） */
  const denyRef = useRef<HTMLButtonElement>(null)

  /** 权威对账：以 main 的 pending 为准校准本地队列（见模块头注释） */
  const syncFromMain = useCallback(async () => {
    const agent = window.fairy?.agent
    if (!agent?.getPendingApprovals) return
    try {
      const alive = await agent.getPendingApprovals()
      // 诊断日志：对账结果（GUI 验收第四轮排查）
      console.log('[ApprovalDialog] syncFromMain: alive ids =', alive.map((r) => r.id), 'queue ids =', queueRef.current.map((i) => i.request.id))
      setQueue((prev) => {
        const now = Date.now()
        const freshAlive = alive
          .filter((r) => !handledRef.current.has(r.id))
          .map<QueueItem>((r) => ({
            request: r,
            receivedAt: prev.find((p) => p.request.id === r.id)?.receivedAt ?? now
          }))
        const aliveIds = new Set(freshAlive.map((i) => i.request.id))
        // 快照竞态窗口内（<3s）刚入队的本地条目保留；其余本地孤儿 = 陈旧残留，删
        const freshLocal = prev.filter(
          (i) =>
            !aliveIds.has(i.request.id) &&
            !handledRef.current.has(i.request.id) &&
            now - i.receivedAt < SYNC_FRESH_MS
        )
        return [...freshAlive, ...freshLocal]
      })
    } catch {
      // preload/IPC 不可用：保持本地队列，65s 兜底过期仍在跑
    }
  }, [])

  // ===== 订阅（每窗口一个实例，退订在 cleanup；preload 未就绪时静默跳过） =====
  useEffect(() => {
    const agent = window.fairy?.agent
    if (!agent?.onApproval || !agent.onApprovalSettled) return
    const offApproval = agent.onApproval((req: AgentApprovalRequest) => {
      // 诊断日志：确认 renderer 是否收到审批请求（GUI 验收第四轮排查）
      console.log('[ApprovalDialog] onApproval received:', req.id, req.tool.name)
      setQueue((prev) =>
        handledRef.current.has(req.id) || prev.some((i) => i.request.id === req.id)
          ? prev
          : [...prev, { request: req, receivedAt: Date.now() }]
      )
      // 新请求 = main 活跃信号 → 立即对账，清掉可能挡住队首的陈旧条目
      void syncFromMain()
    })
    const offSettled = agent.onApprovalSettled((e: AgentApprovalSettledEvent) => {
      handledRef.current.add(e.id)
      setQueue((prev) => prev.filter((i) => i.request.id !== e.id))
    })
    // 对账指令：main summon 后的双保险事件（request 可能单条丢失，任一到达即可校准）
    const offSyncReq = agent.onSyncRequest?.(() => {
      console.log('[ApprovalDialog] onSyncRequest received')
      void syncFromMain()
    })
    // 挂载对账：覆盖「订阅建立前广播」的请求/结算丢失（窗口晚加载、HMR 重载）
    void syncFromMain()
    // 65s 兜底过期：settled 广播丢失时的最后防线（main 60s 必然结算）
    const sweeper = setInterval(() => {
      setQueue((prev) => {
        const now = Date.now()
        const alive = prev.filter((i) => now - i.receivedAt < STALE_MS)
        return alive.length === prev.length ? prev : alive
      })
    }, 5_000)
    // 10s 定时对账兕底：任何事件丢失/IPC reject 被吞的路径，最迟 10s 自愈
    //（GUI 验收实测：单靠事件触发的对账在某些窗口上未执行，陈旧框长期驻留）
    // 降至 3s：GUI 验收第四轮修复——第二次审批框不弹，缩短对账窗口加速自愈
    const reconciler = setInterval(() => void syncFromMain(), 3_000)
    // 窗口被召唤到前台/重新可见时立即对账：summonForApproval 会 focus 本窗口，
    // 把「窗口到前台」与「渲染自愈」焊在一起——即便广播/定时器全部失效，
    // 只要窗口获得焦点就必拉回权威队列（GUI 验收实测的最后防线）
    const onWindowFocus = (): void => void syncFromMain()
    const onVisibilityChange = (): void => {
      if (!document.hidden) void syncFromMain()
    }
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      offApproval()
      offSettled()
      offSyncReq?.()
      clearInterval(sweeper)
      clearInterval(reconciler)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [syncFromMain])

  const current = queue[0]?.request

  /**
   * 提交决定：先本地移除（立刻露出下一条），再回传 main。
   * main 返回 false = 该 id 已陈旧（超时/另一窗口先结算）→ 立即权威对账，
   * 把真正活着的请求顶上来——这就是 GUI 验收「点了允许却被忽略」的自愈路径。
   */
  const respond = useCallback(
    (id: number, approved: boolean) => {
      if (handledRef.current.has(id)) return
      handledRef.current.add(id)
      setQueue((prev) => prev.filter((i) => i.request.id !== id))
      try {
        const snapshot: AgentApprovalSnapshot = {
          queueIds: queueRef.current.map((i) => i.request.id),
          handledIds: [...handledRef.current],
          from: window.location.search.includes('float=1') ? 'float' : 'main'
        }
        // 诊断日志：提交审批决定（GUI 验收第四轮排查）
        console.log('[ApprovalDialog] respond:', id, approved, 'snapshot:', snapshot)
        void window.fairy.agent
          .respondApproval(id, approved, snapshot)
          .then((accepted) => {
            if (accepted !== true) void syncFromMain()
          })
          .catch(() => {
            // preload 面异常/IPC reject：也对账（main 侧 60s 超时兜底仍在）
            void syncFromMain()
          })
      } catch {
        // 同上
        void syncFromMain()
      }
    },
    [syncFromMain]
  )

  // ===== Esc = 拒绝（仅对话框存在时监听，卸载即退订） =====
  useEffect(() => {
    if (!current) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      respond(current.id, false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [current, respond])

  // ===== 新请求（或提交后露出的下一条）自动把焦点放在「拒绝」 =====
  useEffect(() => {
    if (current) denyRef.current?.focus()
  }, [current])

  // 无请求：不渲染任何 DOM（零 z-index 泄漏）
  if (!current) return null

  const { tool } = current
  const inputText = formatInput(current.input)

  return (
    <div className="approval-overlay" role="dialog" aria-modal="true" aria-label="工具调用审批">
      <div className="approval-card">
        <div className="approval-head">
          <span className="approval-title">工具调用审批</span>
          {queue.length > 1 && <span className="approval-pending">待处理 {queue.length} 条</span>}
        </div>

        <div className="approval-tool-row">
          <span className="approval-tool-name">{tool.name}</span>
          <span className={`risk-badge risk-${tool.risk}`}>{RISK_LABEL[tool.risk]}</span>
          <span className="source-badge">{SOURCE_LABEL[tool.source] ?? tool.source}</span>
        </div>

        {tool.description && <p className="approval-desc">{tool.description}</p>}

        {current.outside && (
          <div className="approval-outside">
            ⚠️ 越界操作：本次调用触及工作区/允许范围之外的资源
            {current.reason ? ` — ${current.reason}` : ''}
          </div>
        )}

        <div className="approval-input-head">入参（JSON）</div>
        <pre className="approval-input">{inputText}</pre>

        {current.reason && !current.outside && (
          <p className="approval-reason">{current.reason}</p>
        )}

        <div className="approval-actions">
          <button
            ref={denyRef}
            type="button"
            className="btn approval-deny"
            onClick={() => respond(current.id, false)}
          >
            拒绝
          </button>
          <button
            type="button"
            className="btn btn-primary approval-allow"
            onClick={() => respond(current.id, true)}
          >
            允许
          </button>
        </div>
        <div className="approval-foot">Esc = 拒绝 · 不提供「全部允许」</div>
      </div>
    </div>
  )
}
