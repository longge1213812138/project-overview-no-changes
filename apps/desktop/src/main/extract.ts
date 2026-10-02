/**
 * 空闲记忆抽取（DEV_PLAN §5.2 沉淀时机 2，main 进程侧）。
 *
 * - 5 分钟单例定时器（全局一个，非 per-session）：chatDone（ok 非中止）/再次发送时 reset（重置倒计时 + 记录目标会话）。
 * - 到点时若生成中（isBusy）→ 顺延 1 分钟重试；空闲则取目标会话最近 20 条消息做一次非流式抽取调用。
 * - 解析：首个 balanced [...] → JSON.parse → 逐项校验 kind ∈ {preference,fact,decision,topic}
 *   （不含 note——note 是 remember 意图专用）且 content 非空 → memoryStore.add（add 自带去重，重复不炸）。
 * - 解析失败/异常 → console.warn 一行静默，绝不影响主流程；抽取期间用户发新消息 → reset 取消（AbortController）。
 * - 成功 add ≥1 条 → onChanged（chat.ts 注入 → broadcast IPC.memoryChanged）。
 * - 退出安全：定时器 unref?.()；shutdown() 清定时器 + 取消进行中的抽取（chat.ts shutdownChat → before-quit）。
 *
 * 依赖单向：extract 不回 import chat（依赖经 createIdleExtractor 注入；createClient 由 chat.ts
 * 用 channel.ts 的 resolveActiveChannel 提供，api 通道也能抽取，无环）。
 */
import type { LlmClient, MemoryKind, MemoryStore, MessageDto } from '@fairy/core'

/** §5.2：空闲 5 分钟触发 */
export const IDLE_DELAY_MS = 5 * 60_000
/** 到点仍有生成中 → 顺延 1 分钟重试 */
export const BUSY_DEFER_MS = 60_000

/** §5.2 抽取类别（刻意不含 note） */
const EXTRACT_KINDS = ['preference', 'fact', 'decision', 'topic'] as const
type ExtractKind = (typeof EXTRACT_KINDS)[number]

/** §5.2 system prompt（原文照抄，勿改字面） */
const EXTRACT_SYSTEM_PROMPT =
  '从以下对话中抽取值得长期记住的信息：用户偏好、事实、决定、项目背景。' +
  '没有就输出 []。只输出 JSON 数组：[{"kind":"preference|fact|decision|topic","content":"一句话"}]'

export interface IdleExtractionDeps {
  memoryStore: Pick<MemoryStore, 'add'>
  /** 目标会话最近 N 条消息（升序） */
  listHistory(sessionId: string, limit: number): MessageDto[]
  /** 通道不可用（未选通道/网关未启动等）返回 null → 本次抽取跳过 */
  createClient(): LlmClient | null
  /** 生成中（active 非空）→ 到点顺延 */
  isBusy(): boolean
  /** 成功 add ≥1 条时回调（广播 IPC.memoryChanged） */
  onChanged(): void
}

export interface IdleExtractor {
  /** chatDone（ok 非中止）/再次发送时调用：记录目标会话 + 重置 5 分钟定时器（进行中的抽取取消） */
  reset(sessionId: string): void
  /** 退出前清理：清定时器 + 取消进行中的抽取 */
  shutdown(): void
}

/** 提取首个 balanced [...] 片段（字符串感知，容忍前后 ```json / 解释文字）；无则 null */
export function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf('[')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 逐项校验 kind/content，坏项丢弃（不抛）；整体非数组 → [] */
export function parseExtractionItems(raw: string): Array<{ kind: ExtractKind; content: string }> {
  const json = extractFirstJsonArray(raw)
  if (json === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const items: Array<{ kind: ExtractKind; content: string }> = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue
    const { kind, content } = entry as { kind?: unknown; content?: unknown }
    if (typeof kind !== 'string' || !(EXTRACT_KINDS as readonly string[]).includes(kind)) continue
    if (typeof content !== 'string' || content.trim() === '') continue
    items.push({ kind: kind as ExtractKind, content: content.trim() })
  }
  return items
}

export function createIdleExtractor(deps: IdleExtractionDeps): IdleExtractor {
  let timer: NodeJS.Timeout | null = null
  let targetSessionId: string | null = null
  /** 进行中的抽取（reset/shutdown 时 abort 取消） */
  let inflight: AbortController | null = null

  function restart(delayMs: number): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onFire, delayMs)
    timer.unref?.() // 退出安全：不阻止进程退出
  }

  function onFire(): void {
    timer = null
    if (deps.isBusy()) {
      restart(BUSY_DEFER_MS) // 生成中 → 顺延 1 分钟重试
      return
    }
    void runExtraction()
  }

  async function runExtraction(): Promise<void> {
    const sessionId = targetSessionId
    if (!sessionId) return
    const client = deps.createClient()
    if (!client) return // 通道不可用：静默跳过，等下一次 done 重置

    const messages = deps
      .listHistory(sessionId, 20)
      .filter((m) => m.content.trim() !== '')
      .map((m) => `${m.role}: ${m.content}`)
    if (messages.length === 0) return

    const controller = new AbortController()
    inflight = controller
    try {
      const result = await client.chatOnce(
        [
          { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
          { role: 'user', content: messages.join('\n') }
        ],
        { signal: controller.signal }
      )
      if (controller.signal.aborted) return // 抽取期间用户发新消息 → 取消，不写库
      let added = 0
      for (const item of parseExtractionItems(result.content)) {
        try {
          deps.memoryStore.add({
            content: item.content,
            kind: item.kind as MemoryKind,
            sourceSession: sessionId
          })
          added++
        } catch (err) {
          console.warn('[memory-extract] 记忆入库失败：', err instanceof Error ? err.message : err)
        }
      }
      if (added > 0) deps.onChanged()
    } catch (err) {
      if (controller.signal.aborted) return // 取消：静默
      console.warn('[memory-extract] 空闲记忆抽取失败：', err instanceof Error ? err.message : err)
    } finally {
      if (inflight === controller) inflight = null
    }
  }

  return {
    reset(sessionId: string) {
      targetSessionId = sessionId
      inflight?.abort() // 重置逻辑天然覆盖「抽取期间新消息 → 取消」
      inflight = null
      restart(IDLE_DELAY_MS)
    },
    shutdown() {
      if (timer) clearTimeout(timer)
      timer = null
      inflight?.abort()
      inflight = null
    }
  }
}
