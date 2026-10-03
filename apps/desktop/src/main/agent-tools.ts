/**
 * 阶段 7：内置工具注册表装配 + tools 能力探测缓存（main 进程侧，DEV_PLAN §5.7）。
 *
 * - initAgentTools（initChat 调，幂等）：建工作区目录 %APPDATA%/fairy/workspace
 *   （mkdirSync recursive，已存在无操作）并把三个内置工具注册进 ToolRegistry。
 * - getToolRegistry：聊天流水取注册表（registry.list().map(r => r.tool) → runAgent tools）。
 * - probeToolsSupportCached：按 capabilityKey（channel.ts 的 api:${baseUrl}|${model} / 'web'）
 *   缓存探测结论，同端点+模型只探测一次；结果含 detail 供 capabilityHint 展示。
 *   探测被中止（signal aborted）产生的 unknown 不缓存，下次生成重新探测。
 *
 * 依赖单向：agent-tools → logger（不回 import chat）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { ToolRegistry, createBuiltinTools, probeToolsSupport } from '@fairy/core'
import type { CapabilityProbe, LlmClient } from '@fairy/core'
import { log } from './logger'

let registry: ToolRegistry | null = null

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
}

export function getToolRegistry(): ToolRegistry {
  if (!registry) throw new Error('工具注册表未初始化（initAgentTools 应先于聊天流水调用）')
  return registry
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
