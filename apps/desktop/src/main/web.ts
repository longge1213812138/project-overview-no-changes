/**
 * 阶段 10：API 通道联网检索编排（main 进程侧，DEV_PLAN §5.10）。
 *
 * 职责边界（单向依赖：web → config / logger，不 import chat / agent-tools）：
 * - 配置：读/写 config.json 的 `web` 段（明文无凭据；脏值由 core 的
 *   normalizeWebAccessConfig 夹取，老配置缺省即拿默认值）；
 * - 编排：`runWebRetrieval(text)` = 触发判定 → 检索/抓取 → 过滤 → 引用块，
 *   给聊天管线一块可直接进 systemExtra 的文本 + 一份供 UI 展示的来源列表；
 * - 自检：`testWebSearch(query)` 给设置页「试跑一次」按钮（不落会话、不改消息）。
 *
 * **通道门控**：仅 API 通道联网（与阶段 7「工具调用仅 API 通道」同取向）。
 * 是否 api 通道的判断在 chat.ts（它手上有 resolveActiveChannel 的结果）——
 * 本模块不反向依赖 channel.ts，保持单向。
 *
 * **失败可见**：检索失败/部分失败都以文本块形式注入让模型如实回答，
 * 不静默跳过、不返回伪装的空资料。
 *
 * **超时硬化（2026-10）**：等待必须有界、部分结果不丢、超时对用户可见——
 * ① 总预算封顶 RETRIEVAL_BUDGET_CAP_MS，每步之前查剩余预算（MIN_STEP_BUDGET_MS）；
 * ② 单页超时/失败只记 warning，不推翻已取到的来源与正文（部分结果照样注入）；
 * ③ 每次非正常收场都产出 WebNotice（气泡下方提示条 + 重试入口），
 *    超时与其它失败分开口径（`kind: 'timeout' | 'partial' | 'failed'`）。
 * 单次 HTTP 的重试与归类在 core/web/search.ts（快失败才重试，慢失败一次就够）。
 */
import {
  decideWebSearch,
  fetchWebPage,
  buildWebContextBlock,
  buildWebFailureNote,
  normalizeWebAccessConfig,
  searchWeb,
  toSources
} from '@fairy/core'
import type {
  WebAccessConfig,
  WebActionResult,
  WebEngineFallback,
  WebErrorKind,
  WebFetchResult,
  WebNotice,
  WebPageContent,
  WebSearchEngine,
  WebSearchResult,
  WebSearchTestResult,
  WebSourceRef,
  WebToolDeps
} from '@fairy/core'
import { loadConfig, saveConfig } from './config'
import { log } from './logger'

/** 「直达链接」模式最多抓几个链接（避免一条消息塞满十几个网页） */
const MAX_DIRECT_URLS = 2

/**
 * 单次联网检索的用户可感知等待上限（ms）。预算本身由配置派生（timeoutMs × 步数），
 * 但**必须封顶**：默认配置的派生值（12s×3+3s=39s）会让首 token 前的等待接近半分钟，
 * 用户只会以为程序卡死。超时不是错的收场，但必须是有界的——到点就用已有资料作答
 * 并给出明确提示（气泡下方提示条），而不是继续无声地等。
 */
export const RETRIEVAL_BUDGET_CAP_MS = 25_000

/**
 * 剩余预算低于此值就不再发起新的 HTTP 请求：发出去也大概率赶不上预算，
 * 只会把「已取到的资料」拖成「整体超时失败」——宁可少抓一页，也要把已有结果用上。
 */
export const MIN_STEP_BUDGET_MS = 3_000

/**
 * 单次 HTTP 调用的总预算（检索 / 单页抓取共用；含一次「快失败」重试的机会）。
 * 与运行时「单次工具执行 15s」上限相容：慢失败（耗时接近单请求超时，典型是目标
 * 不可达）不会触发重试（见 core/web 的 RETRY_FAST_FAILURE_MS），所以实际等待 ≈ timeoutMs。
 */
export function webCallBudgetMs(cfg: Pick<WebAccessConfig, 'timeoutMs'>): number {
  return cfg.timeoutMs * 2
}

/**
 * 检索阶段总预算（ms）：一次检索 + 至多 N 次抓取的顺序耗时上限。
 * 单次 HTTP 有自己的超时（cfg.timeoutMs），这里再兜一层整体预算——
 * 防止「每步都刚好卡到超时」把一轮生成拖到几分钟。
 */
function retrievalBudgetMs(cfg: { timeoutMs: number; fetchTopN: number }): number {
  const derived = cfg.timeoutMs * (1 + Math.max(cfg.fetchTopN, MAX_DIRECT_URLS)) + 3000
  return Math.max(webCallBudgetMs(cfg), Math.min(derived, RETRIEVAL_BUDGET_CAP_MS))
}

/** 组合信号：父信号（用户停止）+ 总预算定时器（到点即中止，避免整轮生成被网络拖住） */
function withDeadline(
  parent: AbortSignal | undefined,
  budgetMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(parent?.reason)
  if (parent?.aborted) abortFromParent()
  else parent?.addEventListener('abort', abortFromParent, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('联网检索超出总预算')), budgetMs)
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abortFromParent)
    }
  }
}

/**
 * 失败归类 → 用户可读措辞（提示条与注入模型的失败块共用同一口径，两处说法不漂移）。
 * 带 engine 时把「哪个源」写进去（降级场景下主源与备用源都要能分清）。
 */
export function describeWebFailure(failure: {
  message: string
  kind?: WebErrorKind
  engine?: WebSearchEngine
}): string {
  const who = failure.engine !== undefined ? `${failure.engine}：` : ''
  switch (failure.kind) {
    case 'timeout':
      return `检索超时（${who}${failure.message}）`
    case 'network':
      return `检索源不可达（${who}${failure.message}）`
    case 'parse':
      return `检索结果页解析失败（${who}${failure.message}）`
    case 'blocked':
      return `URL 被安全守卫拒绝（${failure.message}）`
    default:
      return failure.message
  }
}

/**
 * 组装用户可见的联网结论（气泡下方提示条）。
 * 返回 undefined = 正常拿到资料，不必打扰用户。
 * 口径：超时与其它失败分开（超时是「等太久」，失败是「系统性地拿不到」）；
 * 拿到部分资料时也要说清「用了多少、缺了什么」，而不是让用户以为一切正常。
 */
export function buildWebNotice(input: {
  /** 是否发生过超时（单请求超时或总预算耗尽） */
  timedOut: boolean
  /** **实际**给出资料的引擎（降级时是备用源） */
  engine: WebSearchEngine
  sources: WebSourceRef[]
  /** 本轮注入块里的提示条目（部分失败/跳过的原因） */
  warnings: string[]
  /** 完全没取到资料时的失败原因（有资料时不参与措辞） */
  failure?: { message: string; kind?: WebErrorKind }
  /** 主引擎不可达 → 备用源顶替（observedNow 才提示一次，之后安静运行） */
  fallback?: WebEngineFallback
  elapsedMs: number
}): WebNotice | undefined {
  const { timedOut, engine, sources, warnings, failure, fallback, elapsedMs } = input
  const seconds = Math.max(0, elapsedMs) / 1000
  if (sources.length === 0) {
    if (timedOut) {
      return {
        kind: 'timeout',
        message:
          `联网超时（已等 ${seconds.toFixed(1)}s，上限 ${RETRIEVAL_BUDGET_CAP_MS / 1000}s）：` +
          '本次没有取到外部资料，可稍后重试'
      }
    }
    return {
      kind: 'failed',
      message: `联网失败：${describeWebFailure(failure ?? { message: '没有检索到可用结果' })}`
    }
  }
  if (timedOut) {
    return {
      kind: 'timeout',
      message: `联网超时（已等 ${seconds.toFixed(1)}s）：仅用已取到的 ${sources.length} 条来源作答，结果可能不完整`
    }
  }
  if (warnings.length > 0) {
    return {
      kind: 'partial',
      message: `联网部分完成：${sources.length} 条来源可用，${warnings.length} 项未取到（${warnings[0]}）`
    }
  }
  // 资料完整但换了源：本轮亲自观察到主源失败 → 提示一次；命中短期记忆时保持安静
  if (fallback !== undefined && fallback.observedNow) {
    return {
      kind: 'degraded',
      message:
        `联网已降级：主检索源 ${fallback.from} 不可达（${fallback.reason}），` +
        `本次结果来自备用源 ${engine}`
    }
  }
  return undefined
}

/** 当前联网配置（已归一；config.json 里没有 web 段 → core 默认值） */
export function getWebConfig(): WebAccessConfig {
  return normalizeWebAccessConfig(loadConfig().web)
}

/** 是否允许联网（single source of truth：管线/工具注册共用） */
export function isWebEnabled(): boolean {
  return getWebConfig().enabled
}

/**
 * 保存联网配置（局部更新）。
 * 合并后整体归一（越界值夹取、脏类型回落默认），再落盘。
 */
export function saveWebConfig(patch: Partial<WebAccessConfig>): WebActionResult {
  const cfg = loadConfig()
  const merged = normalizeWebAccessConfig({ ...(cfg.web ?? {}), ...patch })
  try {
    saveConfig({ ...cfg, web: merged })
  } catch (err) {
    return { ok: false, error: `配置写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
  log.info(
    '[web]',
    `配置已更新 enabled=${merged.enabled} engine=${merged.engine} maxResults=${merged.maxResults} fetchTopN=${merged.fetchTopN}`
  )
  return { ok: true, config: merged }
}

/** 设置页「试跑一次检索」：验证链路可达 + 来源过滤生效（不落会话） */
export async function testWebSearch(query: string): Promise<WebSearchTestResult> {
  const trimmed = typeof query === 'string' ? query.trim() : ''
  if (trimmed === '') return { ok: false, error: '检索词为空' }
  const cfg = getWebConfig()
  if (!cfg.enabled) return { ok: false, error: '联网开关当前是关闭的，请先开启再试跑' }
  const result = await searchWeb(trimmed, cfg, {
    deadlineAt: Date.now() + webCallBudgetMs(cfg),
    retries: 1
  })
  if (result.error !== undefined && result.items.length === 0) {
    const failure = {
      message: result.error,
      engine: result.engine,
      ...(result.errorKind !== undefined ? { kind: result.errorKind } : {})
    }
    return { ok: false, error: describeWebFailure(failure), engine: result.engine, items: [] }
  }
  return { ok: true, engine: result.engine, items: toSources(result.items) }
}

/**
 * 内置联网工具（模型在工具循环里调 web_search / web_fetch）的依赖注入。
 * 与预检索共用同一套「总预算 + 快失败重试」策略，避免两条路径的口径漂移
 * （工具路径的额外约束由运行时「单次执行 15s」提供，这里不重复设限）。
 */
export function createWebToolDeps(): WebToolDeps {
  const callOpts = (signal?: AbortSignal): { deadlineAt: number; retries: number; signal?: AbortSignal } => ({
    deadlineAt: Date.now() + webCallBudgetMs(getWebConfig()),
    retries: 1,
    ...(signal !== undefined ? { signal } : {})
  })
  return {
    search: (query, opts) =>
      searchWeb(query, getWebConfig(), {
        ...callOpts(opts.signal),
        ...(opts.maxResults !== undefined ? { maxResults: opts.maxResults } : {})
      }),
    fetchPage: (url, opts) =>
      fetchWebPage(url, getWebConfig(), {
        ...callOpts(opts.signal),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {})
      })
  }
}

/** 一轮检索的完整产出 */
export interface WebRetrieval {
  /** 注入 systemExtra 的文本块（非空：成功 = 引用块，失败 = 失败说明） */
  block: string
  /** 供 UI 展示的来源列表（失败时为空数组） */
  sources: WebSourceRef[]
  /** 触发原因（进日志） */
  reason: string
  query: string
  /** 用户可见结论（超时/部分/失败）；正常完成时 undefined（只列来源，不打扰用户） */
  notice?: WebNotice
}

/**
 * 按用户消息取外部资料（触发判定在此完成）。
 *
 * 超时硬化（阶段 10 硬化）三条不变量：
 * ① **等待有界**：总预算封顶（RETRIEVAL_BUDGET_CAP_MS），每步之前查剩余预算，不够就不发；
 * ② **部分结果不丢**：某一页超时/失败不推翻已取到的来源与正文——超时前一页也要用上；
 * ③ **超时可见**：任何非正常收场都产出 notice（气泡下方提示条），不让用户从模型正文里猜。
 *
 * @returns null = 本条消息不需要联网（调用方应跳过注入，不塞空块）
 */
export async function runWebRetrieval(text: string, signal?: AbortSignal): Promise<WebRetrieval | null> {
  const decision = decideWebSearch(text)
  if (!decision.needed) return null
  const cfg = getWebConfig()
  if (!cfg.enabled) {
    log.info('[web]', `本次未联网（开关关闭）：${decision.reason}`)
    return null
  }
  log.info('[web]', `触发联网 kind=${decision.kind} reason=${decision.reason} query=${decision.query}`)

  const startedAt = Date.now()
  const budgetMs = retrievalBudgetMs(cfg)
  const deadlineAt = startedAt + budgetMs
  const deadline = withDeadline(signal, budgetMs)
  /** 剩余预算（ms）：每步之前查一次，不够就不再发起注定赶不上的请求 */
  const remainingMs = (): number => deadlineAt - Date.now()
  /** 单次 HTTP 调用选项：总预算 + 快失败重试（与工具路径同一策略） */
  const callOpts = { deadlineAt, retries: 1, signal: deadline.signal }
  /** 本轮是否发生过超时（单请求超时 / 总预算耗尽 / 因预算不足主动跳过） */
  let timedOut = false

  /**
   * 抓一页：只有「用户停止」才抛（交给上层中止整轮生成）；
   * 预算到点或抓取失败一律折成 warning 并返回 null —— 已取到的资料必须留住。
   */
  const fetchOne = async (url: string): Promise<WebPageContent | null> => {
    if (remainingMs() < MIN_STEP_BUDGET_MS) {
      timedOut = true
      warnings.push(`${url} 未抓取（剩余预算不足 ${MIN_STEP_BUDGET_MS / 1000}s）`)
      return null
    }
    let page: WebFetchResult
    try {
      page = await fetchWebPage(url, cfg, callOpts)
    } catch (err) {
      if (signal?.aborted) throw err
      timedOut = true // 总预算到点（withDeadline 中止）：停止后续抓取，保住已有结果
      warnings.push(`${url} 抓取中止（${err instanceof Error ? err.message : String(err)}）`)
      return null
    }
    if (page.errorKind === 'timeout') timedOut = true
    if (page.error !== undefined || page.content.trim() === '') {
      warnings.push(`${url} 抓取失败（${page.error ?? '无正文'}）`)
      return null
    }
    return { url: page.url, title: page.title, content: page.content, truncated: page.truncated }
  }

  const retrievedAt = new Date()
  const warnings: string[] = []

  try {
    // ===== 路径 A：用户直接给了链接 → 抓该页面 =====
    if (decision.kind === 'link' && decision.urls.length > 0) {
      const pages: WebPageContent[] = []
      for (const url of decision.urls.slice(0, MAX_DIRECT_URLS)) {
        const page = await fetchOne(url)
        if (page !== null) pages.push(page)
      }
      const sources: WebSourceRef[] = pages.map((p, i) => ({
        id: i + 1,
        title: p.title === '' ? p.url : p.title,
        url: p.url
      }))
      const elapsedMs = Date.now() - startedAt
      if (sources.length === 0) {
        const reason = warnings.join('；') || '给出的链接无法访问'
        log.warn('[web]', `链接模式失败：${reason}`)
        const notice = buildWebNotice({
          timedOut,
          engine: cfg.engine,
          sources,
          warnings,
          failure: { message: reason },
          elapsedMs
        })
        return {
          block: buildWebFailureNote(describeWebFailure({ message: reason })),
          sources: [],
          reason: decision.reason,
          query: decision.query,
          ...(notice !== undefined ? { notice } : {})
        }
      }
      if (timedOut) warnings.push('联网超时：以下资料为超时前已取到的部分结果')
      const block = buildWebContextBlock({
        query: decision.query,
        retrievedAt,
        engine: cfg.engine, // 链接模式不使用搜索引擎，标注主引擎即可
        sources,
        pages,
        warnings
      })
      const notice = buildWebNotice({ timedOut, engine: cfg.engine, sources, warnings, elapsedMs })
      log.info('[web]', `链接模式完成：${pages.length} 页正文进入上下文${timedOut ? '（有超时）' : ''}`)
      return {
        block,
        sources,
        reason: decision.reason,
        query: decision.query,
        ...(notice !== undefined ? { notice } : {})
      }
    }

    // ===== 路径 B：常规检索 → 按需抓前 N 页正文 =====
    // 检索前先看预算：不够就不发（发出去也只能等一次注定超时的失败）
    let result: WebSearchResult
    if (remainingMs() < MIN_STEP_BUDGET_MS) {
      timedOut = true
      result = {
        query: decision.query,
        engine: cfg.engine,
        items: [],
        error: `剩余预算不足 ${MIN_STEP_BUDGET_MS / 1000}s，未发起检索`,
        errorKind: 'timeout'
      }
    } else {
      try {
        result = await searchWeb(decision.query, cfg, callOpts)
      } catch (err) {
        if (signal?.aborted) throw err // 用户停止 → 交给上层中止整轮生成
        timedOut = true // 预算到点（withDeadline 中止）
        result = {
          query: decision.query,
          engine: cfg.engine,
          items: [],
          error: err instanceof Error ? err.message : String(err),
          errorKind: 'timeout'
        }
      }
    }

    if (result.items.length === 0) {
      const failure = {
        message: result.error ?? '没有检索到可用结果',
        engine: result.engine,
        ...(result.errorKind !== undefined ? { kind: result.errorKind } : {})
      }
      log.warn('[web]', `检索无结果（engine=${result.engine}）：${failure.message}`)
      const notice = buildWebNotice({
        timedOut: timedOut || result.errorKind === 'timeout',
        engine: result.engine,
        sources: [],
        warnings,
        failure,
        elapsedMs: Date.now() - startedAt
      })
      return {
        block: buildWebFailureNote(describeWebFailure(failure)),
        sources: [],
        reason: decision.reason,
        query: decision.query,
        ...(notice !== undefined ? { notice } : {})
      }
    }
    if (result.errorKind === 'timeout') timedOut = true
    // 降级不进 warnings：它是「换了源」不是「资料不全」——块头已如实标注（含原因），
    // 混进 warnings 会把正常结果误判成 partial（提示条口径会失真）
    if (result.error !== undefined) {
      // 有结果但也报了问题（如引擎部分失败）：如实进提示条目
      warnings.push(describeWebFailure({
        message: result.error,
        engine: result.engine,
        ...(result.errorKind !== undefined ? { kind: result.errorKind } : {})
      }))
    }

    const sources = toSources(result.items)
    const pages: WebPageContent[] = []
    const topN = Math.min(cfg.fetchTopN, sources.length)
    for (const source of sources.slice(0, topN)) {
      const page = await fetchOne(source.url)
      if (page !== null) pages.push(page)
    }
    if (timedOut) warnings.push('联网超时：以下资料为超时前已取到的部分结果')

    const elapsedMs = Date.now() - startedAt
    const block = buildWebContextBlock({
      query: decision.query,
      retrievedAt,
      engine: result.engine,
      sources,
      pages,
      warnings,
      ...(result.fallback !== undefined ? { engineFallback: result.fallback } : {})
    })
    const notice = buildWebNotice({
      timedOut,
      engine: result.engine,
      sources,
      warnings,
      ...(result.fallback !== undefined ? { fallback: result.fallback } : {}),
      elapsedMs
    })
    log.info(
      '[web]',
      `检索完成：engine=${result.engine}` +
        `${result.fallback !== undefined ? `（由 ${result.fallback.from} 降级：${result.fallback.reason}）` : ''}` +
        ` / ${sources.length} 条来源 / ${pages.length} 页正文 / 警告 ${warnings.length} 条` +
        `${timedOut ? '（含超时）' : ''} / 耗时 ${elapsedMs}ms`
    )
    return {
      block,
      sources,
      reason: decision.reason,
      query: decision.query,
      ...(notice !== undefined ? { notice } : {})
    }
  } catch (err) {
    if (signal?.aborted) {
      // 用户停止 → 交给生成流水的既有 abort 分支（不被「按失败处理」吞掉）
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    log.warn('[web]', `联网异常，按失败处理：${message}`)
    const failure = { message }
    const notice = buildWebNotice({
      timedOut,
      engine: cfg.engine,
      sources: [],
      warnings,
      failure,
      elapsedMs: Date.now() - startedAt
    })
    return {
      block: buildWebFailureNote(describeWebFailure(failure)),
      sources: [],
      reason: decision.reason,
      query: decision.query,
      ...(notice !== undefined ? { notice } : {})
    }
  } finally {
    deadline.dispose()
  }
}
