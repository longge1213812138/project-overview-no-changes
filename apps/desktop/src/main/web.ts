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
  WebPageContent,
  WebSearchTestResult,
  WebSourceRef
} from '@fairy/core'
import { loadConfig, saveConfig } from './config'
import { log } from './logger'

/** 「直达链接」模式最多抓几个链接（避免一条消息塞满十几个网页） */
const MAX_DIRECT_URLS = 2

/**
 * 检索阶段总预算（ms）：一次检索 + 至多 N 次抓取的顺序耗时上限。
 * 单次 HTTP 有自己的超时（cfg.timeoutMs），这里再兜一层整体预算——
 * 防止「每步都刚好卡到超时」把一轮生成拖到几分钟。
 */
function retrievalBudgetMs(cfg: { timeoutMs: number; fetchTopN: number }): number {
  return cfg.timeoutMs * (1 + Math.max(cfg.fetchTopN, MAX_DIRECT_URLS)) + 3000
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
  const result = await searchWeb(trimmed, cfg)
  if (result.error !== undefined && result.items.length === 0) {
    return { ok: false, error: result.error, engine: result.engine, items: [] }
  }
  return { ok: true, engine: result.engine, items: toSources(result.items) }
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
}

/**
 * 按用户消息取外部资料（触发判定在此完成）。
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

  const retrievedAt = new Date()
  const warnings: string[] = []
  const deadline = withDeadline(signal, retrievalBudgetMs(cfg))

  try {
    // ===== 路径 A：用户直接给了链接 → 抓该页面 =====
    if (decision.kind === 'link' && decision.urls.length > 0) {
      const pages: WebPageContent[] = []
      for (const url of decision.urls.slice(0, MAX_DIRECT_URLS)) {
        const page = await fetchWebPage(url, cfg, { signal: deadline.signal })
        if (page.error !== undefined || page.content.trim() === '') {
          warnings.push(`${url} 抓取失败（${page.error ?? '无正文'}）`)
          continue
        }
        pages.push({ url: page.url, title: page.title, content: page.content, truncated: page.truncated })
      }
      const sources: WebSourceRef[] = pages.map((p, i) => ({
        id: i + 1,
        title: p.title === '' ? p.url : p.title,
        url: p.url
      }))
      if (sources.length === 0) {
        const note = buildWebFailureNote(warnings.join('；') || '给出的链接无法访问')
        return { block: note, sources: [], reason: decision.reason, query: decision.query }
      }
      const block = buildWebContextBlock({
        query: decision.query,
        retrievedAt,
        sources,
        pages,
        warnings
      })
      log.info('[web]', `链接模式完成：${pages.length} 页正文进入上下文`)
      return { block, sources, reason: decision.reason, query: decision.query }
    }

    // ===== 路径 B：常规检索 → 按需抓前 N 页正文 =====
    const result = await searchWeb(decision.query, cfg, { signal: deadline.signal })
    if (result.items.length === 0) {
      const note = buildWebFailureNote(result.error ?? '没有检索到可用结果')
      log.warn('[web]', `检索无结果：${result.error ?? '引擎未返回条目'}`)
      return { block: note, sources: [], reason: decision.reason, query: decision.query }
    }
    if (result.error !== undefined) warnings.push(result.error)

    const sources = toSources(result.items)
    const pages: WebPageContent[] = []
    const topN = Math.min(cfg.fetchTopN, sources.length)
    for (const source of sources.slice(0, topN)) {
      const page = await fetchWebPage(source.url, cfg, { signal: deadline.signal })
      if (page.error !== undefined || page.content.trim() === '') {
        warnings.push(`${source.url} 正文抓取失败（${page.error ?? '无正文'}）`)
        continue
      }
      pages.push({ url: page.url, title: page.title, content: page.content, truncated: page.truncated })
    }
    const block = buildWebContextBlock({ query: decision.query, retrievedAt, sources, pages, warnings })
    log.info(
      '[web]',
      `检索完成：${sources.length} 条来源 / ${pages.length} 页正文 / 警告 ${warnings.length} 条`
    )
    return { block, sources, reason: decision.reason, query: decision.query }
  } catch (err) {
    if (signal?.aborted) {
      // 用户停止 → 交给生成流水的既有 abort 分支（不被「按失败处理」吞掉）
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    log.warn('[web]', `联网异常，按失败处理：${message}`)
    return {
      block: buildWebFailureNote(message),
      sources: [],
      reason: decision.reason,
      query: decision.query
    }
  } finally {
    deadline.dispose()
  }
}
