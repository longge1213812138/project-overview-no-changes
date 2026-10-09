/**
 * 阶段 7：内置工具注册表装配 + tools 能力探测缓存（main 进程侧，DEV_PLAN §5.7）。
 *
 * - initAgentTools（initChat 调，幂等）：建工作区目录 %APPDATA%/fairy/workspace
 *   （mkdirSync recursive，已存在无操作）并把三个内置工具注册进 ToolRegistry。
 *   阶段 10：联网开关开启时再注册 web_search / web_fetch（网络执行器同样只允许 main 持有；
 *   实现注入 core/web 的 searchWeb/fetchWebPage，配置由 web.ts 统一提供）。
 * - getToolRegistry：聊天流水取注册表（registry.list().map(r => r.tool) → runAgent tools）。
 * - syncWebTools：联网配置变更后重新装配（关 → 卸载，开 → 注册），**不静默保留**旧工具。
 * - probeToolsSupportCached：按 capabilityKey（channel.ts 的 api:${baseUrl}|${model} / 'web'）
 *   缓存探测结论，同端点+模型只探测一次；结果含 detail 供 capabilityHint 展示。
 *   探测被中止（signal aborted）产生的 unknown 不缓存，下次生成重新探测。
 *
 * 依赖单向：agent-tools → core / logger / web（只读配置），不回 import chat。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  ToolRegistry,
  createBuiltinTools,
  createWebTools,
  fetchWebPage,
  probeToolsSupport,
  searchWeb
} from '@fairy/core'
import type { CapabilityProbe, LlmClient, WebFetchResult, WebSearchResult } from '@fairy/core'
import { getWebConfig } from './web'
import { log } from './logger'

let registry: ToolRegistry | null = null

/** 已注册进注册表的联网工具名（卸载用；保证开关与注册状态双向一致） */
let registeredWebTools: string[] = []

const WEB_TOOL_NAMES = ['web_search', 'web_fetch']

/** whenReady 调（initChat 内），幂等 */
export function initAgentTools(): void {
  if (registry) return
  const workspaceRoot = join(app.getPath('userData'), 'workspace')
  mkdirSync(workspaceRoot, { recursive: true }) // 幂等：目录已存在时为无操作
  const reg = new ToolRegistry()
  for (const registration of createBuiltinTools({ workspaceRoot })) {
    reg.register(registration)
  }
  registry = reg
  log.info(
    '[tools]',
    `内置工具已注册：${reg
      .list()
      .map((r) => `${r.tool.definition.function.name}(${r.approval}/${r.risk})`)
      .join(', ')} | workspaceRoot=${workspaceRoot}`
  )
  syncWebTools() // 阶段 10：按联网开关装配/卸载联网工具
}

export function getToolRegistry(): ToolRegistry {
  if (!registry) throw new Error('工具注册表未初始化（initAgentTools 应先于聊天流水调用）')
  return registry
}

/**
 * 阶段 10：按当前联网配置重新装配 web_search / web_fetch（幂等）。
 * 先卸载再按需注册：既避免重复注册抛错，也避免开关关闭后模型仍持有联网能力。
 * 网络实现每次读最新配置（改完即时生效），不缓存 client。
 */
export function syncWebTools(): ToolRegistry {
  const reg = getToolRegistry()
  for (const name of registeredWebTools) {
    reg.unregister(name)
  }
  registeredWebTools = []

  if (!getWebConfig().enabled) {
    log.info('[tools]', '联网开关已关闭：web_search / web_fetch 未注册')
    return reg
  }
  const registrations = createWebTools({
    search: (
      query: string,
      opts: { maxResults?: number; signal?: AbortSignal }
    ): Promise<WebSearchResult> =>
      searchWeb(query, getWebConfig(), {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.maxResults !== undefined ? { maxResults: opts.maxResults } : {})
      }),
    fetchPage: (
      url: string,
      opts: { maxChars?: number; signal?: AbortSignal }
    ): Promise<WebFetchResult> =>
      fetchWebPage(url, getWebConfig(), {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {})
      })
  })
  for (const registration of registrations) {
    reg.register(registration)
  }
  registeredWebTools = [...WEB_TOOL_NAMES]
  log.info('[tools]', `联网工具已注册：${registeredWebTools.join(', ')}（approval=ask / risk=read）`)
  return reg
}

/** 探测结论缓存：capabilityKey → 结果（含 detail，供 unsupported hint 使用） */
const probeCache = new Map<string, CapabilityProbe>()

/**
 * 按 capabilityKey 缓存的 tools 能力探测（同 baseUrl+model 只探测一次）。
 * SessionExpiredError / LlmAuthError 原样冒泡（probeToolsSupport 约定，调用方既有 catch 分类）。
 */
export async function probeToolsSupportCached(
  client: LlmClient,
  capabilityKey: string,
  options: { signal?: AbortSignal } = {}
): Promise<CapabilityProbe> {
  const cached = probeCache.get(capabilityKey)
  if (cached) return cached

  const probe = await probeToolsSupport(client, options)
  // 中止导致的 unknown 不是端点能力结论：不缓存，下轮重新探测
  if (options.signal?.aborted !== true) {
    probeCache.set(capabilityKey, probe)
  }
  log.info(
    '[capability]',
    `探测 key=${capabilityKey} → ${probe.support}` +
      `${probe.detail !== undefined ? `（${probe.detail}）` : ''}` +
      `${options.signal?.aborted === true ? '（signal 已中止，不缓存）' : ''}`
  )
  return probe
}
