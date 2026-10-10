import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type {
  AgentToolNotice,
  ChatBusyEvent,
  ChatDeltaEvent,
  ChatDoneEvent,
  MessageDto,
  WebNotice,
  WebSourceRef
} from '@fairy/core'
import WebNoticeBar from './WebNoticeBar'
import 'highlight.js/styles/github-dark.css'

/**
 * 阶段 3：聊天面板（主窗口聊天 tab / 浮窗共用，一切状态经 props 与本地 state）。
 *
 * 数据流（契约见 packages/core/src/ipc.ts）：
 * - 历史：sessionId 变化 → chat.history() 一次性渲染（meta.reasoning / meta.error 容错展示）
 * - 流式：chat.onDelta 按 messageId 定位本地条目追加 content/reasoning；
 *   chat.onDone 标记完成（清 streaming、error 落红条）；chat.onBusy 维护 busySessionId。
 * - 发送：乐观插入 user + assistant 占位条目（占位条目在首个 delta/done 到达时
 *   收养真实 messageId）；chat.send 返回 {ok:false} 时回滚两条乐观条目并在输入区上方
 *   显示错误（错误不落消息）。
 */
interface ChatPaneProps {
  sessionId: string
  float?: boolean
}

/** 本地消息条目：dbId = 落库 id（乐观占位条目为 null，由首个 delta/done 收养） */
interface LocalMessage {
  /** React key；乐观条目取负数自减计数，delta 直建条目用 messageId */
  key: number
  dbId: number | null
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  error: string | null
  streaming: boolean
  /** 阶段 7：能力提示（ChatDoneEvent.capabilityHint，气泡下方小灰条） */
  hint: string
  /** 阶段 10：本轮联网来源（meta.sources，气泡下方引用列表） */
  sources: WebSourceRef[]
  /** 阶段 10 硬化：本轮联网结论（超时/部分/失败 → 提示条 + 重试；正常为 null） */
  notice: WebNotice | null
}

/** 空状态示例：各点一条，正好演示「记忆 / 联网 / 日程」三个模块 */
const EXAMPLE_PROMPTS = [
  '记住我喜欢冰美式，以后别推荐热的',
  '联网查一下 Node LTS 最新版本',
  '明天上午 10 点提醒我交周报'
]

/** 工具状态 → 中文短文案（工具状态行用，见 toolNoticeText） */
const TOOL_STATUS_TEXT: Record<AgentToolNotice['status'], string> = {
  requested: '等待审批…',
  denied: '已拒绝',
  started: '执行中…',
  completed: '已完成',
  failed: '执行失败'
}

/** 状态行文本：🔧 工具名：状态（failed 附错误摘要，超长截断防撑破输入区） */
function toolNoticeText(n: AgentToolNotice): string {
  const base = `🔧 ${n.name}：${TOOL_STATUS_TEXT[n.status]}`
  if (n.status !== 'failed' || !n.error) return base
  const err = n.error.length > 60 ? `${n.error.slice(0, 60)}…` : n.error
  return `${base}（${err}）`
}

/** meta（JSON 对象）容错取字符串 */
function metaString(meta: MessageDto['meta'], key: string): string {
  const v = meta?.[key]
  return typeof v === 'string' ? v : ''
}

/**
 * meta.sources 容错解析（阶段 10）：只接受 {id:number, title:string, url:string} 形状的条目，
 * 脏数据整条丢弃（渲染层不信任任何历史落盘内容）。
 */
function metaSources(meta: MessageDto['meta']): WebSourceRef[] {
  const v = meta?.['sources']
  if (!Array.isArray(v)) return []
  const out: WebSourceRef[] = []
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    if (typeof item['id'] !== 'number' || !Number.isFinite(item['id'])) continue
    if (typeof item['title'] !== 'string' || typeof item['url'] !== 'string') continue
    if (item['url'].trim() === '') continue
    out.push({
      id: item['id'],
      title: item['title'],
      url: item['url'],
      ...(typeof item['snippet'] === 'string' && item['snippet'] !== ''
        ? { snippet: item['snippet'] }
        : {})
    })
  }
  return out
}

/**
 * meta.webNotice 容错解析（阶段 10 硬化）：只接受 {kind, message} 且 kind 在枚举内、
 * message 非空的形状；脏数据当没有（提示条不猜、不半渲染）。
 */
function metaNotice(meta: MessageDto['meta']): WebNotice | null {
  const v = meta?.['webNotice']
  if (typeof v !== 'object' || v === null) return null
  const item = v as Record<string, unknown>
  const kind = item['kind']
  const message = item['message']
  if (kind !== 'timeout' && kind !== 'partial' && kind !== 'failed' && kind !== 'degraded') {
    return null
  }
  if (typeof message !== 'string' || message.trim() === '') return null
  return { kind, message }
}

/** 该助手消息之前最近的一条用户消息文本（重试 = 重发它；找不到返回空串） */
function precedingUserText(list: LocalMessage[], index: number): string {
  for (let i = index - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (m.role === 'user' && m.content.trim() !== '') return m.content
  }
  return ''
}

/** delta → 追加到对应条目（找不到则收养乐观占位 / 末尾新建） */
function appendDelta(
  list: LocalMessage[],
  messageId: number,
  kind: ChatDeltaEvent['kind'],
  text: string
): LocalMessage[] {
  let idx = list.findIndex((m) => m.dbId === messageId)
  if (idx === -1) {
    // 收养乐观占位条目（send 后本地先插的空 assistant 条）
    idx = list.findIndex((m) => m.role === 'assistant' && m.dbId === null && m.streaming)
    if (idx === -1) {
      // 未知来源（如另一窗口发起、或本组件挂载前已在生成）：末尾新建
      return [
        ...list,
        {
          key: messageId,
          dbId: messageId,
          role: 'assistant',
          content: kind === 'content' ? text : '',
          reasoning: kind === 'reasoning' ? text : '',
          error: null,
          streaming: true,
          hint: '',
          sources: [],
          notice: null
        }
      ]
    }
  }
  const next = [...list]
  const msg: LocalMessage = { ...next[idx] }
  if (msg.dbId === null) msg.dbId = messageId
  if (kind === 'content') msg.content += text
  else msg.reasoning += text
  msg.streaming = true
  next[idx] = msg
  return next
}

/** done → 标记完成（清 streaming，出错写 error） */
function finalizeMessage(list: LocalMessage[], e: ChatDoneEvent): LocalMessage[] {
  let idx = list.findIndex((m) => m.dbId === e.messageId)
  if (idx === -1) {
    // 没收到过 delta（空回复 / 先错）：收养最后一个乐观占位条目
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m.role === 'assistant' && m.dbId === null && m.streaming) {
        idx = i
        break
      }
    }
    if (idx === -1) return list
  }
  const next = [...list]
  const msg: LocalMessage = { ...next[idx] }
  if (msg.dbId === null) msg.dbId = e.messageId
  msg.streaming = false
  // 阶段 10：本轮来源随 done 落到条目上（空数组 = 本轮未联网）
  if (e.sources !== undefined) msg.sources = e.sources
  // 阶段 10 硬化：联网结论同样随 done 落到条目上（本轮正常完成 → null，不残留上一轮提示）
  msg.notice = e.webNotice ?? null
  // 阶段 7：通道能力提示随 done 落到条目上（非空才展示）
  if (e.capabilityHint) msg.hint = e.capabilityHint
  if (!e.ok && e.error) msg.error = e.error
  next[idx] = msg
  return next
}

export default function ChatPane({ sessionId, float = false }: ChatPaneProps) {
  const [messages, setMessages] = useState<LocalMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const [busySessionId, setBusySessionId] = useState<string | null>(null)
  /** 最近一条工具执行状态行（只在 busy 期间展示，见 onToolNotice 订阅） */
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  /** 阶段 10：忙碌阶段短文本（如「🌐 联网检索中…」），随每次 busy 事件刷新 */
  const [busyNote, setBusyNote] = useState<string | null>(null)

  const busy = busySessionId === sessionId

  // 事件订阅只挂一次，靠 ref 过滤当前会话（浮窗 quick 会话 vs 普通会话互不串扰）
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  /** busy 快照：工具状态回调里同步判断（不用闭包里的旧 busy） */
  const busyRef = useRef(false)
  busyRef.current = busy
  /** 乐观条目 React key 计数（负数区，避开落库 id 正数区） */
  const keyRef = useRef(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ===== 历史加载：sessionId 变化重拉 =====
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setSendError(null)
    setMessages([])
    window.fairy.chat
      .history(sessionId)
      .then((rows: MessageDto[]) => {
        if (cancelled) return
        setMessages(
          rows.map((row) => ({
            key: row.id,
            dbId: row.id,
            role: row.role,
            content: row.content,
            reasoning: metaString(row.meta, 'reasoning'),
            hint: metaString(row.meta, 'capabilityHint'),
            sources: metaSources(row.meta),
            notice: metaNotice(row.meta),
            error: metaString(row.meta, 'error') || null,
            streaming: false
          }))
        )
        stickRef.current = true
        setLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // ===== 流式事件订阅（delta / done / busy） =====
  useEffect(() => {
    const offDelta = window.fairy.chat.onDelta((e: ChatDeltaEvent) => {
      if (e.sessionId !== sessionRef.current) return
      setMessages((prev) => appendDelta(prev, e.messageId, e.kind, e.text))
    })
    const offDone = window.fairy.chat.onDone((e: ChatDoneEvent) => {
      if (e.sessionId !== sessionRef.current) return
      setMessages((prev) => finalizeMessage(prev, e))
    })
    // 阶段 10：note 随事件刷新（缺省/null 即清空，不会残留上一轮的提示）
    const offBusy = window.fairy.chat.onBusy((e: ChatBusyEvent) => {
      setBusySessionId(e.sessionId)
      setBusyNote(e.note ?? null)
    })
    // 阶段 7：工具执行状态（按当前 sessionId 过滤；preload agent 面未就绪则不订阅）
    const agentApi = window.fairy.agent
    const offNotice = agentApi?.onToolNotice
      ? agentApi.onToolNotice((n: AgentToolNotice) => {
          if (n.sessionId !== sessionRef.current) return
          // 非生成期收到直接丢弃（不设定时器，无泄漏）；busy 期间只留最近一条
          if (!busyRef.current) return
          setToolStatus(toolNoticeText(n))
        })
      : () => {}
    return () => {
      offDelta()
      offDone()
      offBusy()
      offNotice()
    }
  }, [])

  // busy 结束即清空状态行（避免下次生成开头闪现上一轮的旧状态）
  useEffect(() => {
    if (!busy) setToolStatus(null)
  }, [busy])

  // ===== 自动滚到底（用户上翻时不打扰） =====
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  // ===== 发送 =====
  const handleSend = useCallback(
    async (raw?: string) => {
      const text = (raw ?? input).trim()
      if (!text || busy) return
      setSendError(null)

      // 乐观插入：user 消息 + assistant 空占位（delta 到达即收养真实 messageId，
      // 避免流式闪烁与顺序错乱）；send 失败整体回滚，错误只进输入区红条、不落消息
      const userKey = --keyRef.current
      const asstKey = --keyRef.current
      setMessages((prev) => [
        ...prev,
        {
          key: userKey,
          dbId: null,
          role: 'user',
          content: text,
          reasoning: '',
          error: null,
          streaming: false,
          hint: '',
          sources: [],
          notice: null
        },
        {
          key: asstKey,
          dbId: null,
          role: 'assistant',
          content: '',
          reasoning: '',
          error: null,
          streaming: true,
          hint: '',
          sources: [],
          notice: null
        }
      ])
      stickRef.current = true

      if (raw === undefined) {
        setInput('')
        const el = textareaRef.current
        if (el) el.style.height = 'auto'
      }

      let res: { ok: boolean; error?: string }
      try {
        res = await window.fairy.chat.send(sessionId, text)
      } catch (err) {
        res = { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (!res.ok) {
        setMessages((prev) => prev.filter((m) => m.key !== userKey && m.key !== asstKey))
        setSendError(res.error ?? '发送失败')
      }
    },
    [input, busy, sessionId]
  )

  const handleStop = useCallback(() => {
    void window.fairy.chat.stop(sessionId)
  }, [sessionId])

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // IME 组合中的 Enter 不发送，防止误发
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        void handleSend()
      }
    },
    [handleSend]
  )

  const handleInputChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
    stickRef.current = true
  }, [])

  return (
    <div className={float ? 'chat-pane float' : 'chat-pane'}>
      <div className="chat-messages" ref={scrollRef} onScroll={handleScroll}>
        {loaded && messages.length === 0 && (
          <div className="empty-state">
            <h2>Fairy 待命中——</h2>
            <p>检索、联网、日程、记忆四个模块全部在线。说吧，主人；也可以先点下面这几条开个头：</p>
            {EXAMPLE_PROMPTS.map((p) => (
              <button key={p} className="example-btn" onClick={() => void handleSend(p)}>
                {p}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => {
          // 重试 = 重发这条回复对应的上一条用户消息（历史/流式两种来源都在本地列表里）
          const retryText =
            m.role === 'assistant' && m.notice !== null ? precedingUserText(messages, i) : ''
          return (
          <div key={m.key} className={`msg-row ${m.role}`}>
            <div
              className={`bubble ${m.role}${m.streaming ? ' streaming' : ''}`}
            >
              {m.reasoning !== '' && (
                <details className="reasoning">
                  <summary>思考过程</summary>
                  <pre>{m.reasoning}</pre>
                </details>
              )}
              {m.role === 'assistant' ? (
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                    {m.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="plain-text">{m.content}</div>
              )}
              {m.error && <div className="msg-error">{m.error}</div>}
            </div>
            {/* 阶段 7：能力提示（气泡下方小灰条，仅非空时） */}
            {m.role === 'assistant' && m.hint !== '' && (
              <div className="capability-hint">{m.hint}</div>
            )}
            {/* 阶段 10：联网来源（与正文里的 [n] 编号对应；点击走系统浏览器） */}
            {m.role === 'assistant' && m.sources.length > 0 && (
              <div className="web-sources">
                <span className="web-sources-title">🌐 检索完成——本次参考了 {m.sources.length} 个来源</span>
                <ul>
                  {m.sources.map((s) => (
                    <li key={`${s.id}-${s.url}`}>
                      <span className="web-source-id">[{s.id}]</span>
                      <button
                        className="web-source-link"
                        title={s.url}
                        onClick={() => void window.fairy.openExternal(s.url)}
                      >
                        {s.title === '' ? s.url : s.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/* 阶段 10 硬化：联网结论（超时/部分/失败）+ 重试入口 */}
            {m.role === 'assistant' && m.notice !== null && (
              <WebNoticeBar
                notice={m.notice}
                busy={busy}
                {...(retryText !== '' ? { onRetry: () => void handleSend(retryText) } : {})}
              />
            )}
          </div>
          )
        })}
      </div>

      <div className="chat-input-area">
        {sendError && <div className="input-error">{sendError}</div>}
        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            className="chat-input"
            rows={1}
            value={input}
            placeholder="对 Fairy 说点什么（Enter 发送 · Shift+Enter 换行）"
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
          />
          {busy ? (
            <button className="chat-send stop" onClick={handleStop}>
              停止
            </button>
          ) : (
            <button
              className="chat-send"
              disabled={input.trim() === ''}
              onClick={() => void handleSend()}
            >
              发送
            </button>
          )}
        </div>
        <div className="input-foot">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <span className="foot-status">
            {busy && toolStatus && <span className="tool-status">{toolStatus}</span>}
            {busy && busyNote && <span className="tool-status">{busyNote}</span>}
            {busy && <span className="gen-hint">Fairy 运算中…</span>}
          </span>
        </div>
      </div>
    </div>
  )
}
