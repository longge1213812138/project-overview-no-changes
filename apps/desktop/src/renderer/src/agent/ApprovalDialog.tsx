import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentApprovalRequest, AgentApprovalSettledEvent } from '@fairy/core'

/**
 * 阶段 7：工具审批对话框（主窗与浮窗各挂一个实例，见 App.tsx；每窗口只订阅一次）。
 *
 * 契约（packages/core/src/ipc.ts FairyApi.agent）：
 * - onApproval 收请求入本地队列（一次只展示队首），respondApproval 提交决定；
 * - onApprovalSettled = 对话框关闭信号（另一窗口先响应 / 超时 / 生成中止），
 *   与本地提交共用同一个幂等 Set，重复 id 一律忽略；
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
  const [queue, setQueue] = useState<AgentApprovalRequest[]>([])
  /** 已处理 id（本地提交与 settled 可能先后到达，幂等去重） */
  const handledRef = useRef<Set<number>>(new Set())
  /** 默认焦点落在「拒绝」上（Enter = 拒绝，安全默认） */
  const denyRef = useRef<HTMLButtonElement>(null)

  // ===== 订阅（每窗口一个实例，退订在 cleanup；preload 未就绪时静默跳过） =====
  useEffect(() => {
    const agent = window.fairy?.agent
    if (!agent?.onApproval || !agent.onApprovalSettled) return
    const offApproval = agent.onApproval((req: AgentApprovalRequest) => {
      setQueue((prev) =>
        handledRef.current.has(req.id) || prev.some((r) => r.id === req.id) ? prev : [...prev, req]
      )
    })
    const offSettled = agent.onApprovalSettled((e: AgentApprovalSettledEvent) => {
      handledRef.current.add(e.id)
      setQueue((prev) => prev.filter((r) => r.id !== e.id))
    })
    return () => {
      offApproval()
      offSettled()
    }
  }, [])

  const current = queue[0]

  /** 提交决定：先本地移除（立刻露出下一条），再回传 main；重复提交由 handledRef 挡住 */
  const respond = useCallback((id: number, approved: boolean) => {
    if (handledRef.current.has(id)) return
    handledRef.current.add(id)
    setQueue((prev) => prev.filter((r) => r.id !== id))
    try {
      void window.fairy.agent.respondApproval(id, approved).catch(() => {})
    } catch {
      // preload 面未就绪：本地已移除，main 侧超时兜底
    }
  }, [])

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
