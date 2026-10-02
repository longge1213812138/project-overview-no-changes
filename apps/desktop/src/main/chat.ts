/**
 * 聊天流式编排（DEV_PLAN §6 阶段 3，main 进程侧）。
 *
 * - initChat()（whenReady 调，幂等）：建会话存储 SQLite <userData>/fairy.db + ensure 快速会话
 *   + 记忆存储（同一 fairy.db 独立连接；主进程同步串行访问，安全）。
 * - 单飞：模块级 active，同一时刻只允许一条生成；sendChat 冲突直接返回 {ok:false,error}。
 * - 流水（DEV_PLAN §5.1 三步，全在单飞+busy+signal 之下）：
 *   user 落库 → assistant 空占位（拿 messageId）→ 广播 busy →
 *   ① 意图解析（parse，失败兜底 chat）→ ② 动作（remember/forget + 日程 schedule_*，异常按 chat 继续）
 *   → ③ 记忆检索注入（top-8 + 动作确认语 / 日程注入，buildContext systemExtra）→ streamChat；
 *   回调累积本地 buffer 并广播 delta（content/reasoning 都发，渲染层自决定展示）。
 * - 完成/中止/过期/其他错误 → updateMessage 保留已生成部分 + meta，广播 chatDone。
 * - 空闲抽取（§5.2 沉淀时机 2）：chatDone（ok 非中止）/再次发送 → 5 分钟单例定时器（extract.ts）。
 * - 广播统一走 windows.broadcast（主窗口 + 浮窗同步）。
 *
 * 依赖单向：chat → windows / sidecar / channel / extract（均不回 import chat）。
 * createSessionStore/SessionStore（阶段 3 任务 A）与 createIntentParser/createMemoryStore/
 * formatMemoryBlock/MEMORY_TOP_K（阶段 4 任务 A2）以及 createCalendarStore/CalendarStore/
 * formatEventTime/relativeDayLabel（阶段 5 任务 A4）均为 @fairy/core 冻结签名。
 */
import { app } from 'electron'
import { join } from 'node:path'
import {
  IPC,
  MEMORY_TOP_K,
  createIntentParser,
  createMemoryStore,
  createSessionStore,
  formatEventTime,
  formatMemoryBlock,
  relativeDayLabel,
  SessionExpiredError
} from '@fairy/core'
import type {
  ChatBusyEvent,
  ChatDeltaEvent,
  ChatDoneEvent,
  EventRecord,
  IntentResult,
  MemoryStore,
  MessageDto,
  ScheduleScope,
  SessionMeta,
  SessionStore
} from '@fairy/core'
import { resolveActiveChannel } from './channel'
import type { ActiveChannel } from './channel'
import { getEventStore } from './events'
import { createIdleExtractor } from './extract'
import type { IdleExtractor } from './extract'
import { reportSessionExpired, reportSessionOk } from './sidecar'
import { broadcast } from './windows'

let store: SessionStore | null = null

/** 记忆存储：同一 fairy.db 独立连接（MemoryStore 为 A2 冻结签名） */
let memoryStore: MemoryStore | null = null

/** 空闲记忆抽取（§5.2 沉淀时机 2）：全局单例定时器，chatDone/发送时 reset */
let idleExtractor: IdleExtractor | null = null

/** 单飞：同一时刻只有一条生成中（AbortController 供 stopChat 中止） */
let active: { sessionId: string; controller: AbortController } | null = null

/** whenReady 调用，幂等 */
export function initChat(): void {
  if (store) return
  const dbPath = join(app.getPath('userData'), 'fairy.db')
  store = createSessionStore({ dbPath })
  store.ensureQuickSession() // 浮窗固定快速会话（QUICK_SESSION_ID）
  memoryStore = createMemoryStore({ dbPath })
  idleExtractor = createIdleExtractor({
    memoryStore,
    listHistory: (sessionId, limit) => listHistory(sessionId, limit),
    createClient: () => {
      // 抽取也走通道解析（api 通道同样可抽取）；通道不可用返回 null → 本次抽取跳过
      const active = resolveActiveChannel()
      return active.ok ? active.client : null
    },
    isBusy: () => active !== null,
    onChanged: () => broadcast(IPC.memoryChanged)
  })
}

function requireStore(): SessionStore {
  if (!store) throw new Error('chat store 未初始化（initChat 应先于 IPC handler 注册）')
  return store
}

/** ipc.ts 记忆 handler 直调 */
export function getMemoryStore(): MemoryStore {
  if (!memoryStore) throw new Error('记忆存储未初始化（initChat 应先于 IPC handler 注册）')
  return memoryStore
}

/** 退出前清理空闲抽取定时器（before-quit 调用，放 shutdownSidecar 旁边） */
export function shutdownChat(): void {
  idleExtractor?.shutdown()
}

// ===== 会话 CRUD（ipc.ts handler 直调；session:changed 广播在此统一） =====

export function listSessions(): SessionMeta[] {
  return requireStore().listSessions()
}

export function createSession(): SessionMeta {
  const meta = requireStore().createSession('chat')
  broadcast(IPC.sessionChanged)
  return meta
}

export function removeSession(id: string): void {
  requireStore().removeSession(id)
  broadcast(IPC.sessionChanged)
}

export function listHistory(sessionId: string, limit?: number): MessageDto[] {
  return requireStore().listMessages(sessionId, limit)
}

// ===== 发送 / 停止 =====

/**
 * 校验（空消息 / 通道不可用（resolveActiveChannel） / 已有生成中 / 会话不存在）→ 否则落库并启动生成。
 * 返回 {ok:true} 只代表「已受理」；流式结果经 chat:delta / chat:done 事件推送。
 */
export function sendChat(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof text !== 'string' || text.trim() === '') {
    return Promise.resolve({ ok: false, error: '消息不能为空' })
  }

  // 通道解析（§5.6，替代旧「网关 ready」检查）：未选通道 / api 配置不全 / 网关未启动 → 引导文案
  const resolved = resolveActiveChannel()
  if (!resolved.ok) {
    return Promise.resolve({ ok: false, error: resolved.error })
  }
  if (active) {
    return Promise.resolve({ ok: false, error: '正在生成回复…' })
  }
  if (requireStore().getSession(sessionId) === null) {
    return Promise.resolve({ ok: false, error: '会话不存在' })
  }

  // user 消息落库（任务 A 约定：该会话首条消息会自动改标题）→ 会话列表全窗口刷新
  requireStore().appendMessage({ sessionId, role: 'user', content: text })
  broadcast(IPC.sessionChanged)

  // assistant 空占位，拿 messageId 供 delta/done 事件与最终 updateMessage 使用
  const placeholder = requireStore().appendMessage({ sessionId, role: 'assistant', content: '' })
  const messageId = placeholder.id

  const controller = new AbortController()
  active = { sessionId, controller }
  broadcast(IPC.chatBusy, { sessionId } satisfies ChatBusyEvent)
  reportSessionOk() // 消息成功进入生成流水 → 清会话过期标记（托盘联动）

  idleExtractor?.reset(sessionId) // 再次发送 → 重置空闲抽取倒计时（进行中的抽取取消）
  void runGeneration(sessionId, messageId, text, resolved, controller.signal)
  return Promise.resolve({ ok: true })
}

/** 中止 active 且 sessionId 匹配的生成；不匹配静默（单飞保证当前生成即 active） */
export function stopChat(sessionId: string): Promise<void> {
  if (active && active.sessionId === sessionId) {
    active.controller.abort()
  }
  return Promise.resolve()
}

// ===== 生成流水 =====

async function runGeneration(
  sessionId: string,
  messageId: number,
  text: string,
  /** 通道解析结果（{channel, client}）：client 不再内部从 port 重建，意图解析共用同一个 */
  resolved: Extract<ActiveChannel, { ok: true }>,
  signal: AbortSignal
): Promise<void> {
  const s = requireStore()
  const client = resolved.client

  // ===== DEV_PLAN §5.1 三步流水：① 意图 → ② 记忆动作 → ③ 检索注入 → 流式回复 =====

  // ① 意图解析（非流式小调用；parse 内部兜底 chat，这里再包 try/catch 双保险，绝不中断回复）
  let intent: IntentResult = { intent: 'chat' }
  try {
    intent = await createIntentParser(client).parse(text, { signal })
  } catch (err) {
    console.warn('[intent] 意图解析失败，按 chat 继续：', err instanceof Error ? err.message : err)
    intent = { intent: 'chat' }
  }
  // stop 竞态防御：已中止则不执行任何动作（失败路径不写脏数据；streamChat 会立即走 abort 分支）
  if (signal.aborted) intent = { intent: 'chat' }

  // ② 记忆动作（只看 intent 结果；动作异常 → 按 chat 继续，绝不中断回复）
  let actionNote = ''
  try {
    if (intent.intent === 'remember') {
      const content = (intent.payload?.content ?? '').trim()
      if (content !== '') {
        getMemoryStore().add({ content, kind: 'note', sourceSession: sessionId })
        broadcast(IPC.memoryChanged) // remember add 成功 → 面板即时同步
        actionNote = `系统已执行记忆动作：已记住「${content}」。`
      }
    } else if (intent.intent === 'forget') {
      const keyword = (intent.payload?.keyword ?? '').trim()
      if (keyword !== '') {
        const n = getMemoryStore().removeByKeyword(keyword)
        if (n > 0) broadcast(IPC.memoryChanged) // forget 真删了才广播
        actionNote =
          n > 0
            ? `系统已执行记忆动作：已删除 ${n} 条关于「${keyword}」的记忆。`
            : `系统已执行记忆动作：没有找到关于「${keyword}」的记忆（删除 0 条）。`
      }
    }
  } catch (err) {
    console.warn('[memory] 记忆动作失败，按 chat 继续：', err instanceof Error ? err.message : err)
    actionNote = ''
  }

  // ②b 日程动作 + 查询（阶段 5 §5.1/§5.3，与记忆动作并列；异常同样按 chat 继续、不写脏数据）
  // A4 冻结：IntentKind 含 schedule_add/done/cancel/query，payload 含 {title, remindAt(ISO 串，可能缺失/非法), notes, keyword, scope}
  let scheduleNote = '' // 动作结果（进 system，配 confirmNote 确认语指令）
  let confirmNote = '' // 确认语指令（schedule_add 定制「复述准确时间」句；done/cancel 用通用句）
  let scheduleExtra = '' // 非动作注入（无确认语指令）：add 时间非法追问 / query 查询结果
  try {
    const kind = asScheduleKind(intent.intent)
    const p = (intent.payload ?? {}) as ScheduleIntentPayload
    const now = Date.now()

    if (kind === 'schedule_add') {
      const title = typeof p.title === 'string' ? p.title.trim() : ''
      if (title !== '') {
        const rawRemindAt = typeof p.remindAt === 'string' ? p.remindAt : undefined
        const t = rawRemindAt !== undefined ? Date.parse(rawRemindAt) : NaN
        if (!Number.isFinite(t) || t < now - 60_000) {
          // §5.1「非法则追问一次」：不写库、不加确认语指令，回复即追问
          scheduleExtra = `【系统】用户想添加日程但时间无法解析（模型给的时间表达：${rawRemindAt ?? '缺失'}）。请向用户追问一次具体的日期和时间，只追问这一次，不要声称已安排。`
        } else {
          const notes = typeof p.notes === 'string' && p.notes.trim() !== '' ? p.notes.trim() : null
          getEventStore().addEvent({ title, remindAt: t, notes })
          broadcast(IPC.eventChanged) // 聊天管道写库 → 面板即时同步
          scheduleNote = `系统已执行日程动作：已安排「${title}」于 ${formatEventTime(t)}（${relativeDayLabel(t)}）${notes ? `，备注：${notes}` : ''}。`
          confirmNote = '请在回复开头确认并复述准确时间（例如：已帮你安排：9/28 10:00 交周报 ✓），再自然衔接。'
        }
      }
    } else if (kind === 'schedule_done' || kind === 'schedule_cancel') {
      const keyword = typeof p.keyword === 'string' ? p.keyword.trim() : ''
      if (keyword !== '') {
        const store = getEventStore()
        const matched = store.matchEvents({
          keyword,
          scope: normalizeScope(p.scope),
          includeDone: false,
          now
        })
        for (const ev of matched) {
          if (kind === 'schedule_done') store.completeEvent(ev.id, true)
          else store.removeEvent(ev.id)
        }
        broadcast(IPC.eventChanged)
        const list = matched.map((ev: EventRecord) => `${formatEventTime(ev.remindAt)} ${ev.title}`).join('、')
        if (matched.length === 0) {
          scheduleNote = `系统已执行日程动作：没有找到匹配的日程（关键词：${keyword}）。`
        } else if (kind === 'schedule_done') {
          scheduleNote = `系统已执行日程动作：已标记 ${matched.length} 条完成：${list}。`
        } else {
          scheduleNote = `系统已执行日程动作：已取消 ${matched.length} 条：${list}。`
        }
        confirmNote = '请在回复开头先用一句话向用户确认系统执行的结果，再自然衔接话题。'
      }
    } else if (kind === 'schedule_query') {
      // 非动作（§5.3）：查询结果注入 systemExtra 让模型自然语言总结，不加确认语指令
      const keyword = typeof p.keyword === 'string' ? p.keyword.trim() : ''
      if (keyword !== '' || p.scope !== undefined) {
        const matched = getEventStore().matchEvents({
          keyword,
          scope: normalizeScope(p.scope),
          includeDone: false,
          now
        })
        scheduleExtra =
          matched.length > 0
            ? `【相关日程】\n${matched
                .map(
                  (ev: EventRecord) =>
                    `- ${formatEventTime(ev.remindAt)}（${relativeDayLabel(ev.remindAt)}）${ev.title}${ev.notes ? `；${ev.notes}` : ''}`
                )
                .join('\n')}`
            : '【相关日程】（没有找到相关日程）'
      }
    }
  } catch (err) {
    console.warn('[calendar] 日程动作失败，按 chat 继续：', err instanceof Error ? err.message : err)
    scheduleNote = ''
    confirmNote = ''
    scheduleExtra = ''
  }

  // ③ 记忆检索注入（top-8 FTS5）+ 动作确认语（§5.2 注入格式）
  const extraParts: string[] = []
  try {
    const memories = getMemoryStore().search(text, { topK: MEMORY_TOP_K })
    extraParts.push(formatMemoryBlock(memories))
  } catch (err) {
    console.warn('[memory] 记忆检索失败：', err instanceof Error ? err.message : err)
  }
  if (actionNote !== '') {
    extraParts.push(actionNote)
    extraParts.push('请在回复开头先用一句话给用户确认（例如：已帮你记下了 ✓），再自然衔接话题。')
  }
  if (scheduleExtra !== '') {
    extraParts.push(scheduleExtra) // 日程查询结果 / 时间非法追问（无确认语指令）
  }
  if (scheduleNote !== '') {
    extraParts.push(scheduleNote)
    extraParts.push(confirmNote)
  }
  const systemExtra = extraParts.filter((part) => part.trim() !== '').join('\n\n')

  // buildContext 含刚落的 user 消息（system 提示词在 core 内拼接，不落库）
  const messages = s.buildContext(sessionId, { systemExtra })
  const startedAt = Date.now()

  let content = ''
  let reasoning = ''

  const emitDelta = (kind: ChatDeltaEvent['kind'], text: string): void => {
    broadcast(IPC.chatDelta, { sessionId, messageId, kind, text } satisfies ChatDeltaEvent)
  }
  const emitDone = (event: ChatDoneEvent): void => {
    broadcast(IPC.chatDone, event)
  }

  try {
    const result = await client.streamChat(
      messages,
      {
        onContentDelta: (t) => {
          content += t
          emitDelta('content', t)
        },
        onReasoningDelta: (t) => {
          reasoning += t
          emitDelta('reasoning', t)
        }
      },
      { signal }
    )
    const elapsedMs = Date.now() - startedAt
    s.updateMessage(messageId, {
      content: content || result.content,
      // reasoning 也留痕（meta JSON），主窗口重开会话时可自行决定展示
      meta: {
        elapsedMs,
        finishReason: result.finishReason ?? 'stop',
        ...(reasoning ? { reasoning } : {})
      }
    })
    emitDone({ sessionId, messageId, ok: true, elapsedMs })
    idleExtractor?.reset(sessionId) // §5.2 沉淀时机 2：chatDone ok 非中止 → 空闲抽取倒计时
  } catch (err) {
    const elapsedMs = Date.now() - startedAt

    if (isAbortError(err, signal)) {
      // 用户主动 stop：保留已生成部分，非错误
      s.updateMessage(messageId, { content, meta: { aborted: true, elapsedMs } })
      emitDone({ sessionId, messageId, ok: true, aborted: true, elapsedMs })
      return
    }

    if (err instanceof SessionExpiredError && resolved.channel === 'web') {
      // 会话过期（持续 429 overloaded）：仅网页通道上报托盘红（§5.6.4 指纹仅对网页生效）
      s.updateMessage(messageId, { content, meta: { error: err.message } })
      emitDone({
        sessionId,
        messageId,
        ok: false,
        error: '会话已过期（持续 429 overloaded），请在设置页重新保存账号配置',
        elapsedMs
      })
      reportSessionExpired()
      return
    }

    const message = err instanceof Error ? err.message : String(err)
    s.updateMessage(messageId, { content, meta: { error: message } })
    emitDone({ sessionId, messageId, ok: false, error: message, elapsedMs })
  } finally {
    active = null
    broadcast(IPC.chatBusy, { sessionId: null } satisfies ChatBusyEvent)
  }
}

// ===== 阶段 5：日程意图辅助（A4 冻结：IntentKind 含 schedule_*，payload 含 {title, remindAt, notes, keyword, scope}） =====

const SCHEDULE_KINDS = ['schedule_add', 'schedule_done', 'schedule_cancel', 'schedule_query'] as const
type ScheduleIntentKind = (typeof SCHEDULE_KINDS)[number]

/** 宽字符串收窄（core 意图扩展落地前后均可编译；非 schedule_* 返回 null） */
function asScheduleKind(kind: string): ScheduleIntentKind | null {
  return (SCHEDULE_KINDS as readonly string[]).includes(kind) ? (kind as ScheduleIntentKind) : null
}

/** 日程 payload（防御式取值：缺失/类型不对一律按空处理；remindAt 为 ISO 字符串，可能缺失/非法） */
interface ScheduleIntentPayload {
  title?: string
  remindAt?: string
  notes?: string
  keyword?: string
  scope?: ScheduleScope
}

/** scope 缺失/非法一律 'all'（与 schedule_query 的 payload.scope ?? 'all' 语义一致） */
function normalizeScope(value: unknown): ScheduleScope {
  return value === 'today' || value === 'tomorrow' || value === 'week' || value === 'all'
    ? value
    : 'all'
}

/** LLM 客户端对 AbortSignal 的两种兑现方式：signal.reason（Error）或 DOMException AbortError */
function isAbortError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  return err instanceof DOMException && err.name === 'AbortError'
}
