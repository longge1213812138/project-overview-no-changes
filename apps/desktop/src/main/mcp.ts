/**
 * 阶段 8：MCP 服务器管理器（main 进程侧，DEV_PLAN §5.8）。
 *
 * - 配置：config.json 明文（name/command/args/cwd）+ DPAPI 密件 env（token 不落明文）；
 * - 生命周期：**用户驱动连接**（v1 不自动连接——外部进程必须显式启用，
 *   对应「默认不把凭据交给未授权服务」）；连接成功 → 工具注册进统一 ToolRegistry；
 *   断开/保存/意外退出 → 注册表回滚 + mcp:changed 广播；
 * - 安全不变量：MCP 工具恒 approval:'ask' + risk:'exec'（builder 强制）；
 *   env 值只在 main 内存与密件，绝不回传 renderer、绝不写日志；
 * - 退出：shutdownMcp 树杀全部子进程（before-quit 调）。
 *
 * 依赖单向：mcp → config/agent-tools/windows/logger（均不回 import mcp）。
 */
import { app } from 'electron'
import { isAbsolute, join } from 'node:path'
import { McpClient, buildMcpRegistrations, IPC } from '@fairy/core'
import type { McpActionResult, McpServerListItem } from '@fairy/core'
import type { McpServerConfig } from './config'
import { loadConfig, saveConfig } from './config'
import { getToolRegistry } from './agent-tools'
import { log } from './logger'
import { broadcast } from './windows'

let inited = false
/** 当前配置（含 env 内存视图） */
let configs: McpServerConfig[] = []
/** name → 运行时（client 常驻直到移除，状态跨调用保留） */
const clients = new Map<string, McpClient>()
/** 当前注册进 ToolRegistry 的 MCP 工具名（回滚用） */
let registeredTools: string[] = []
/** 每服务器装配期可见错误（list 汇入 warnings） */
const buildErrors = new Map<string, string[]>()

function persist(): void {
  const cfg = loadConfig()
  cfg.mcpServers = configs
  saveConfig(cfg)
}

function notify(): void {
  broadcast(IPC.mcpChanged)
}

/** 连接参数（cwd 缺省工作区根；env 来自 DPAPI 合并视图） */
function launchOf(config: McpServerConfig): {
  name: string
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
} {
  return {
    name: config.name,
    command: config.command,
    args: config.args,
    cwd: config.cwd ?? join(app.getPath('userData'), 'workspace'),
    ...(config.env !== undefined ? { env: config.env } : {})
  }
}

/** 注册表回滚 + 按各 ready 客户端重建（skills 注册互不影响，各自管各自的卸载名单） */
function applyRegistrations(): void {
  const registry = getToolRegistry()
  for (const name of registeredTools) registry.unregister(name)
  registeredTools = []
  buildErrors.clear()

  const existingNames = registry.list().map((r) => r.tool.definition.function.name)
  for (const config of configs) {
    const client = clients.get(config.name)
    if (client === undefined || client.state !== 'ready') continue
    const built = buildMcpRegistrations(client, { existingNames })
    for (const reg of built.registrations) {
      try {
        registry.register(reg)
        registeredTools.push(reg.tool.definition.function.name)
        existingNames.push(reg.tool.definition.function.name)
      } catch (err) {
        const message = `注册失败：${(err as Error).message}`
        buildErrors.set(config.name, [...(buildErrors.get(config.name) ?? []), message])
        log.warn('[mcp]', `服务 ${config.name} ${message}`)
      }
    }
    for (const errItem of built.errors) {
      buildErrors.set(config.name, [...(buildErrors.get(config.name) ?? []), errItem.message])
      log.warn('[mcp]', `服务 ${errItem.server} ${errItem.message}`)
    }
  }
}

/** 懒建 client（保留连接状态）；onExit = 意外退出 → 注册表回滚 + 广播可见 */
function ensureClient(config: McpServerConfig): McpClient {
  let client = clients.get(config.name)
  if (client === undefined) {
    client = new McpClient(config.name)
    client.onExit = (reason) => {
      log.warn('[mcp]', `服务「${config.name}」意外退出：${reason}`)
      applyRegistrations()
      notify()
    }
    clients.set(config.name, client)
  }
  return client
}

/** initChat 内调（幂等）；v1 不自动连接，配置读入即可 */
export function initMcp(): void {
  if (inited) return
  inited = true
  configs = loadConfig().mcpServers ?? []
  if (configs.length > 0) {
    log.info('[mcp]', `已载入 ${configs.length} 个服务器配置（不自动连接，设置页手动连接）：${configs.map((c) => c.name).join('、')}`)
  }
}

export function listMcpServers(): McpServerListItem[] {
  if (!inited) return []
  return configs.map((config) => {
    const client = clients.get(config.name)
    const warnings = [
      ...(client?.schemaWarnings ?? []),
      ...(client?.protocolIssues ?? []),
      ...(buildErrors.get(config.name) ?? [])
    ]
    const item: McpServerListItem = {
      name: config.name,
      command: config.command,
      args: config.args,
      envKeys: Object.keys(config.env ?? {}),
      status: client?.state ?? 'stopped',
      tools: (client?.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
      warnings
    }
    if (config.cwd !== undefined) item.cwd = config.cwd
    if (client?.lastError) item.error = client.lastError
    if (client?.serverInfo && Object.keys(client.serverInfo).length > 0) item.serverInfo = client.serverInfo
    return item
  })
}

export function saveMcpServer(input: {
  name: string
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
}): McpActionResult {
  if (!inited) return { ok: false, error: 'MCP 管理器未初始化' }
  const name = input.name?.trim() ?? ''
  const command = input.command?.trim() ?? ''
  if (name === '') return { ok: false, error: '名称不能为空' }
  if (command === '') return { ok: false, error: '启动命令不能为空' }
  if (!Array.isArray(input.args) || input.args.some((a) => typeof a !== 'string')) {
    return { ok: false, error: '参数必须是字符串数组' }
  }
  if (input.cwd !== undefined && input.cwd !== '' && !isAbsolute(input.cwd)) {
    return { ok: false, error: '工作目录必须是绝对路径' }
  }
  if (input.env !== undefined) {
    for (const [key, value] of Object.entries(input.env)) {
      if (key.trim() === '' || typeof value !== 'string') return { ok: false, error: '环境变量格式非法' }
    }
  }

  const existingIndex = configs.findIndex((c) => c.name === name)
  const existing = existingIndex >= 0 ? configs[existingIndex] : undefined
  const next: McpServerConfig = {
    name,
    command,
    args: [...input.args],
    ...(input.cwd !== undefined && input.cwd !== '' ? { cwd: input.cwd } : {}),
    // env：显传对象 = 整体替换；省略 = 保留已存
    ...(input.env !== undefined
      ? Object.keys(input.env).length > 0
        ? { env: { ...input.env } }
        : {}
      : existing?.env !== undefined
        ? { env: existing.env }
        : {})
  }

  if (existing !== undefined) {
    // 改配置：断开旧连接（参数/env 已变，保持旧进程不安全），保留 client 实例复用状态字段
    const client = clients.get(name)
    if (client !== undefined && client.state !== 'stopped') {
      client.disconnect('配置已更新')
    }
    configs[existingIndex] = next
  } else {
    configs.push(next)
  }
  persist()
  applyRegistrations()
  log.info('[mcp]', `保存服务器配置：${name}（${command} ${next.args.join(' ')}${next.env ? `，env ${Object.keys(next.env).length} 项（已入 DPAPI）` : ''}）`)
  notify()
  return { ok: true }
}

export function removeMcpServer(name: string): McpActionResult {
  if (!inited) return { ok: false, error: 'MCP 管理器未初始化' }
  const index = configs.findIndex((c) => c.name === name)
  if (index < 0) return { ok: false, error: `未找到服务器：${name}` }
  clients.get(name)?.disconnect('已移除')
  clients.delete(name)
  configs.splice(index, 1)
  buildErrors.delete(name)
  persist()
  applyRegistrations()
  log.info('[mcp]', `移除服务器：${name}`)
  notify()
  return { ok: true }
}

/** 连接：initialize + tools/list → 注册工具；失败状态/错误在 list 可见 */
export async function connectMcpServer(name: string): Promise<McpActionResult> {
  if (!inited) return { ok: false, error: 'MCP 管理器未初始化' }
  const config = configs.find((c) => c.name === name)
  if (config === undefined) return { ok: false, error: `未找到服务器：${name}` }
  const client = ensureClient(config)
  if (client.state === 'ready' || client.state === 'connecting') {
    return { ok: false, error: `服务已处于 ${client.state} 状态` }
  }
  log.info('[mcp]', `连接服务器：${name}（${config.command} ${config.args.join(' ')}）`)
  try {
    await client.connect(launchOf(config))
    applyRegistrations()
    log.info(
      '[mcp]',
      `连接成功：${name}（serverInfo=${client.serverInfo.name ?? '?'} v${client.serverInfo.version ?? '?'}，工具 ${client.tools.length} 个：${client.tools.map((t) => t.name).join('、') || '无'}）`
    )
    notify()
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('[mcp]', `连接失败：${name}：${message}`)
    applyRegistrations()
    notify()
    return { ok: false, error: message }
  }
}

export function disconnectMcpServer(name: string): McpActionResult {
  if (!inited) return { ok: false, error: 'MCP 管理器未初始化' }
  const client = clients.get(name)
  if (client === undefined) return { ok: false, error: `服务器未连接：${name}` }
  client.disconnect()
  applyRegistrations()
  log.info('[mcp]', `已断开服务器：${name}`)
  notify()
  return { ok: true }
}

/** before-quit 调：树杀全部子进程（幂等） */
export function shutdownMcp(): void {
  for (const client of clients.values()) {
    if (client.state !== 'stopped') client.disconnect('应用退出')
  }
}
