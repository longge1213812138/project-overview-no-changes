import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatBusyEvent, ChatDeltaEvent, ChatDoneEvent, MessageDto } from '@fairy/core'
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
}

const EXAMPLE_PROMPTS = [
  '用三句话介绍一下 Transformer 的注意力机制',
  '帮我写一封明天上午请假半天的邮件',
  '今晚吃什么？给三个 20 分钟能做完的家常菜'
]

/** meta（JSON 对象）容错取字符串 */
function metaString(meta: MessageDto['meta'], key: string): string {
  const v = meta?.[key]
  return typeof v === 'string' ? v : ''
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
          streaming: true
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

  const busy = busySessionId === sessionId

  // 事件订阅只挂一次，靠 ref 过滤当前会话（浮窗 quick 会话 vs 普通会话互不串扰）
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
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
    const offBusy = window.fairy.chat.onBusy((e: ChatBusyEvent) => setBusySessionId(e.sessionId))
    return () => {
      offDelta()
      offDone()
      offBusy()
    }
  }, [])

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
          streaming: false
        },
        {
          key: asstKey,
          dbId: null,
          role: 'assistant',
          content: '',
          reasoning: '',
          error: null,
          streaming: true
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
            <h2>🧚 有什么可以帮你？</h2>
            <p>直接输入问题开始对话，或试试下面的示例：</p>
            {EXAMPLE_PROMPTS.map((p) => (
              <button key={p} className="example-btn" onClick={() => void handleSend(p)}>
                {p}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
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
          </div>
        ))}
      </div>

      <div className="chat-input-area">
        {sendError && <div className="input-error">{sendError}</div>}
        <div className="chat-input-row">
          <textarea
            ref={textareaRef}
            className="chat-input"
            rows={1}
            value={input}
            placeholder="输入消息，Enter 发送 / Shift+Enter 换行"
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
          {busy && <span className="gen-hint">生成中…</span>}
        </div>
      </div>
    </div>
  )
}
