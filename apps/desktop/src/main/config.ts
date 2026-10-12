/**
 * 本地配置（DEV_PLAN §7 + §6.6.2 阶段 6 硬化）。
 *
 * 两份文件，职责分离：
 * - `config.json`（明文，可安全进诊断报告）：channel / api.baseUrl / api.model；
 * - `secrets.dpapi.json`（DPAPI 密文，见 secrets.ts）：API Key、MCP env。
 *
 * 内存里的 `FairyConfig` 仍是**合并后的明文视图**（channel / chat 读写不变），
 * 只有落盘这一层做剥离与解密：saveConfig 拆出密件，loadConfig 合并回来。
 *
 * 迁移（幂等，只在老结构上触发一次）：
 * - 旧明文 config.json 里若有 api.apiKey → 自动搬进 DPAPI 密件并重写 config.json；
 * - 已移除的网页通道遗留字段（gatewayBin / 网关 apiKey / account；channel:'web'）→ 一次性清出两份文件。
 *
 * 并发/损坏策略：
 * - main 是单实例锁下的唯一写者；保存走 tmp + rename（同卷近原子），
 *   读端永远不会看到半截文件；
 * - JSON 解析失败 → 原文件备份为 .bak 后按"不存在"重建，绝不崩溃。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ApiChannelConfig,
  ChannelKind,
  PermissionsConfig,
  WebAccessConfig
} from '@fairy/core'
import { normalizePermissionsConfig, normalizeWebAccessConfig } from '@fairy/core'
import { hadLegacyGatewaySecrets, readSecrets, writeSecrets } from './secrets'
import type { SecretValues } from './secrets'

export interface FairyConfig {
  /** 接入通道（DEV_PLAN §5.6）：仅 'api'；缺省/null = 尚未配置（设置页引导填写 API 配置） */
  channel?: ChannelKind | null
  /** OpenAI 兼容 API 供应商配置（baseUrl/apiKey/model；apiKey 走 DPAPI）；缺省 = 未配置 */
  api?: ApiChannelConfig
  /**
   * 阶段 8：Skill 启用状态（key = manifest.name）。
   * enabled = 用户显式启用（新发现恒 false，默认禁用）；
   * fingerprint = 启用时的内容指纹（manifest+entry 脚本 sha256）——
   * 内容一变即识别为「已变更」自动回禁用，需重新启用。
   */
  skills?: Record<string, SkillStateEntry>
  /** 阶段 8：MCP 服务器配置（env 内存视图来自 DPAPI 密件，明文落盘时剥离） */
  mcpServers?: McpServerConfig[]
  /**
   * 阶段 10：联网检索配置（DEV_PLAN §5.10；明文，无凭据字段）。
   * 缺省 = 未显式配置 → getWebConfig() 返回 core 的默认值。
   */
  web?: WebAccessConfig
  /**
   * 工具权限档位（ADR-0002）：决定哪些工具调用仍需用户确认。
   * 缺省 = 'default'（逐工具按声明的 approval 判定，与引入档位前一致）。
   */
  permissions?: PermissionsConfig
}

/** 单个技能的启用状态（config.json 明文字段，无凭据） */
export interface SkillStateEntry {
  enabled: boolean
  /** 启用时记录的内容指纹；'' = 从未启用 */
  fingerprint: string
}

/**
 * MCP 服务器配置（内存合并视图）。
 * 明文 config.json 只落 name/command/args/cwd；**env（可能含 token）走 DPAPI 密件**
 * （与 api.apiKey 同一模式），诊断报告天然不含凭据。
 */
export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  cwd?: string
  /** 追加环境变量（凭据只在内存/密件中出现，绝不回传 renderer、不写日志） */
  env?: Record<string, string>
}

/** config.json 的明文部分（密件字段一律不落这里） */
interface PlaintextConfig {
  channel?: ChannelKind | null
  api?: { baseUrl: string; model: string; style?: string }
  skills?: Record<string, SkillStateEntry>
  /** MCP 明文部分：env 一律剥离（进密件） */
  mcpServers?: { name: string; command: string; args: string[]; cwd?: string }[]
  /** 阶段 10：联网检索配置（无凭据，整份明文）；原始形态，归一在 assemble 里做 */
  web?: unknown
  /** 工具权限档位（无凭据）；原始形态，归一在 assemble 里做 */
  permissions?: unknown
}

export function configFilePath(): string {
  return join(app.getPath('userData'), 'config.json')
}

/**
 * DEV_PLAN §7：userData = %APPDATA%/fairy（小写 fairy）。
 * 必须在 index.ts 顶部尽早调用（whenReady 之前），目录自动创建。
 */
export function initUserDataPath(): void {
  const dir = join(app.getPath('appData'), 'fairy')
  app.setPath('userData', dir)
  mkdirSync(dir, { recursive: true })
}

/** api 字段（baseUrl/apiKey/model）全为非空字符串才认；缺一即「api 未配置」（configured=false）
 *  style：'chat' | 'responses'，脏值/缺省一律归一为 'chat'（老配置升级自动落 chat） */
function normalizeApi(
  baseUrl: unknown,
  apiKey: unknown,
  model: unknown,
  style: unknown
): ApiChannelConfig | undefined {
  const b = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  const k = typeof apiKey === 'string' ? apiKey.trim() : ''
  const m = typeof model === 'string' ? model.trim() : ''
  if (b === '' || k === '' || m === '') return undefined
  return {
    baseUrl: b,
    apiKey: k,
    model: m,
    apiStyle: style === 'responses' ? 'responses' : 'chat'
  }
}

/** skills 状态归一：仅接受 {enabled:boolean, fingerprint:string} 形状，脏数据丢弃 */
function normalizeSkills(raw: unknown): Record<string, SkillStateEntry> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Record<string, SkillStateEntry> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof name !== 'string' || name === '' || typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    if (typeof entry.enabled !== 'boolean' || typeof entry.fingerprint !== 'string') continue
    out[name] = { enabled: entry.enabled, fingerprint: entry.fingerprint }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** MCP 明文条目归一：name/command 非空、args 字符串数组、cwd 绝对路径；脏数据丢弃 */
function normalizeMcpPlain(raw: unknown): { name: string; command: string; args: string[]; cwd?: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { name: string; command: string; args: string[]; cwd?: string }[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    if (typeof o.name !== 'string' || o.name.trim() === '' || seen.has(o.name)) continue
    if (typeof o.command !== 'string' || o.command.trim() === '') continue
    if (!Array.isArray(o.args) || o.args.some((a) => typeof a !== 'string')) continue
    const entry: { name: string; command: string; args: string[]; cwd?: string } = {
      name: o.name.trim(),
      command: o.command.trim(),
      args: o.args as string[]
    }
    if (typeof o.cwd === 'string' && o.cwd !== '') entry.cwd = o.cwd
    seen.add(entry.name)
    out.push(entry)
  }
  return out
}

/** 密件 mcpEnv 归一：{server: {KEY: VALUE}}，坏结构丢弃 */
function normalizeMcpEnv(raw: unknown): Record<string, Record<string, string>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Record<string, Record<string, string>> = {}
  for (const [server, env] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) continue
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (key.trim() !== '' && typeof value === 'string') clean[key] = value
    }
    if (Object.keys(clean).length > 0) out[server] = clean
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 合并明文 config.json 与 DPAPI 密件 → 内存视图（apiKey 缺失就补一个新的） */
function assemble(plain: PlaintextConfig, secrets: SecretValues): FairyConfig {
  const cfg: FairyConfig = {
    channel: plain.channel === 'api' ? 'api' : null
  }
  const api = normalizeApi(plain.api?.baseUrl, secrets.apiApiKey, plain.api?.model, plain.api?.style)
  if (api) cfg.api = api
  const skills = normalizeSkills(plain.skills)
  if (skills) cfg.skills = skills
  const mcpPlain = normalizeMcpPlain(plain.mcpServers)
  if (mcpPlain.length > 0) {
    const mcpEnv = normalizeMcpEnv(secrets.mcpEnv) ?? {}
    cfg.mcpServers = mcpPlain.map((s) => ({
      ...s,
      ...(mcpEnv[s.name] !== undefined ? { env: mcpEnv[s.name] } : {})
    }))
  }
  // 阶段 10：联网配置容脏（缺字段按 core 默认值补齐，越界值夹取，绝不因脏配置崩溃）
  cfg.web = normalizeWebAccessConfig(plain.web)
  // 工具权限档位同样容脏：缺省/脏值一律回落 default（老配置升级后行为不变）
  cfg.permissions = normalizePermissionsConfig(plain.permissions)
  return cfg
}

/** 明文视图 → 只留非密字段（saveConfig 落盘用） */
function strip(cfg: FairyConfig): PlaintextConfig {
  const plain: PlaintextConfig = { channel: cfg.channel ?? null }
  if (cfg.api) {
    plain.api = {
      baseUrl: cfg.api.baseUrl,
      model: cfg.api.model,
      style: cfg.api.apiStyle ?? 'chat' // 显式落盘（接口风格是非敏感配置）
    }
  }
  if (cfg.skills && Object.keys(cfg.skills).length > 0) plain.skills = cfg.skills
  if (cfg.mcpServers && cfg.mcpServers.length > 0) {
    // env 一律剥离（进密件），明文只留连接参数
    plain.mcpServers = cfg.mcpServers.map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args,
      ...(s.cwd !== undefined ? { cwd: s.cwd } : {})
    }))
  }
  plain.web = normalizeWebAccessConfig(cfg.web)
  plain.permissions = normalizePermissionsConfig(cfg.permissions)
  return plain
}

/** 明文视图 → 密件内容（与 strip 严格互补：saveConfig 写完两份后无任何凭据残留在 config.json） */
function toSecrets(cfg: FairyConfig): SecretValues {
  const secrets: SecretValues = {}
  if (cfg.api) secrets.apiApiKey = cfg.api.apiKey
  const mcpEnv: Record<string, Record<string, string>> = {}
  for (const server of cfg.mcpServers ?? []) {
    if (server.env && Object.keys(server.env).length > 0) mcpEnv[server.name] = server.env
  }
  if (Object.keys(mcpEnv).length > 0) secrets.mcpEnv = mcpEnv
  return secrets
}

function writePlaintext(plain: PlaintextConfig): void {
  const p = configFilePath()
  writeFileSync(`${p}.tmp`, `${JSON.stringify(plain, null, 2)}\n`, 'utf8')
  renameSync(`${p}.tmp`, p)
}

/** 读配置；文件不存在 → 首启自动创建；损坏 → .bak 备份后重建 */
export function loadConfig(): FairyConfig {
  const p = configFilePath()
  if (existsSync(p)) {
    let raw: unknown
    let parseOk = false
    try {
      raw = JSON.parse(readFileSync(p, 'utf8'))
      parseOk = typeof raw === 'object' && raw !== null
    } catch {
      parseOk = false
    }
    if (parseOk) {
      const o = raw as Record<string, unknown>
      const secrets = readSecrets()

      const legacyApi = o['api'] as Record<string, unknown> | undefined

      // ===== 旧明文自动迁移（幂等：搬走后字段即从 config.json 消失，下次不再触发） =====
      let migrated = false
      const legacyApiKey =
        typeof legacyApi === 'object' && legacyApi !== null ? legacyApi['apiKey'] : undefined
      if (typeof legacyApiKey === 'string' && legacyApiKey !== '' && !secrets.apiApiKey) {
        secrets.apiApiKey = legacyApiKey
        migrated = true
      }
      // 已移除的网页通道遗留项：gatewayBin / 网关 apiKey / account 明文、channel:'web'，
      // 以及密件里的网关 apiKey + 账号 → 一次性清出两份文件（channel 归一 null，需重新配置）
      const hadWebChannelLegacy =
        o['gatewayBin'] !== undefined ||
        o['apiKey'] !== undefined ||
        o['account'] !== undefined ||
        o['channel'] === 'web'
      if (hadWebChannelLegacy || hadLegacyGatewaySecrets()) migrated = true

      const plain: PlaintextConfig = {
        channel: o['channel'] === 'api' ? 'api' : null,
        api:
          typeof legacyApi === 'object' && legacyApi !== null
            ? {
                baseUrl: typeof legacyApi['baseUrl'] === 'string' ? legacyApi['baseUrl'] : '',
                model: typeof legacyApi['model'] === 'string' ? legacyApi['model'] : '',
                style: typeof legacyApi['style'] === 'string' ? legacyApi['style'] : undefined
              }
            : undefined,
        skills: normalizeSkills(o['skills']),
        mcpServers: normalizeMcpPlain(o['mcpServers']),
        web: o['web'],
        permissions: o['permissions']
      }
      const cfg = assemble(plain, secrets)
      if (migrated) {
        try {
          writeSecrets(toSecrets(cfg))
          writePlaintext(strip(cfg))
        } catch {
          /* 迁移写失败：内存视图照常返回，下次启动再迁 */
        }
      }
      return cfg
    }
    try {
      renameSync(p, `${p}.bak`) // 备份损坏的原件，排查用
    } catch {
      /* 备份失败则保持现状（重建会原子覆盖） */
    }
  }
  // 首启自动创建（§5.6：channel 缺省 null，不默认任何接入方式；api 缺省 = configured:false）
  const cfg = assemble({ channel: null }, {})
  saveConfig(cfg)
  return cfg
}

/** 保存配置：密件（DPAPI）+ 明文两份各自 tmp + rename 原子替换 */
export function saveConfig(cfg: FairyConfig): void {
  writeSecrets(toSecrets(cfg))
  writePlaintext(strip(cfg))
}
