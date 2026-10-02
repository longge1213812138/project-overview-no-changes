/**
 * 本地配置：%APPDATA%/fairy/config.json（DEV_PLAN §5.5 / §7）。
 *
 * 结构：{ gatewayBin?, apiKey, account?, channel?, api? }，UTF-8 JSON，MVP 明文（阶段 6 上 DPAPI）。
 *
 * 并发/损坏策略：
 * - main 是单实例锁下的唯一写者；保存走 tmp + rename（同卷近原子），
 *   读端（loadConfig / sidecar）永远不会看到半截文件；
 * - JSON 解析失败 → 原文件备份为 .bak 后按"不存在"重建，绝不崩溃。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { ApiChannelConfig, ChannelKind, GatewayAccountConfig } from '@fairy/core'

export interface FairyConfig {
  /** ds-free-api 网关二进制路径；空/缺 = 未找到（网关状态报「未找到网关二进制」） */
  gatewayBin?: string
  /** 网关 [[api_keys]] 用的 key，首启自动生成 */
  apiKey: string
  /** DeepSeek 账号池凭据（账号/密码/device_id） */
  account?: GatewayAccountConfig
  /** 接入通道（DEV_PLAN §5.6）：'api' | 'web'；缺省/null = 尚未选择（设置页展示双通道选择卡） */
  channel?: ChannelKind | null
  /** OpenAI 兼容 API 供应商配置（baseUrl/apiKey/model；与网关用的 apiKey 字段不同名，嵌套无冲突）；缺省 = 未配置 */
  api?: ApiChannelConfig
}

/** 本机已知 ds-free-api 安装目录（docs/llm-bridge-notes.md §2/§6，阶段 2 探测位 ②） */
const KNOWN_GATEWAY_DIR = 'C:\\Users\\91533\\.fairy-tools\\ds-free-api\\ds-free-api-v0.2.11-windows-x86_64'

function configPath(): string {
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

function newApiKey(): string {
  return `sk-fairy-${randomBytes(16).toString('hex')}` // sk-fairy- + 32 位随机 hex
}

/** 探测顺序：① 环境变量 ② 本机已知安装位置 ③ 打包产物 extraResources；都没有 → 留空 */
function probeGatewayBin(): string {
  const fromEnv = process.env['FAIRY_GATEWAY_BIN']
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const known = join(KNOWN_GATEWAY_DIR, 'ds-free-api.exe')
  if (existsSync(known)) return known
  const inResources = join(process.resourcesPath, 'ds-free-api', 'ds-free-api.exe')
  if (existsSync(inResources)) return inResources
  return ''
}

/**
 * 一次性迁移（仅当 config.json 不存在时触发）：
 * 已知 ds-free-api 开发目录里有 config.toml 时，用简单正则从第一个
 * [[ds_core.accounts]] 段提取 email/mobile/password/device_id 写入 account。
 * 缺哪项不写哪项；读不到 / 提取不到就当没有。后续不会再跑。
 */
function migrateFromGatewayToml(): GatewayAccountConfig | null {
  try {
    const raw = readFileSync(join(KNOWN_GATEWAY_DIR, 'config.toml'), 'utf8')
    // 取第一个 accounts 段：从 [[ds_core.accounts]] 到下一个 [[...]] 或文件尾
    const section = raw.match(/\[\[ds_core\.accounts\]\][\s\S]*?(?=\n\s*\[\[|$)/)?.[0]
    if (!section) return null
    const pick = (key: string): string | undefined => {
      const m = section.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))
      return m?.[1]?.trim() || undefined
    }
    const account = pick('email') ?? pick('mobile')
    const password = pick('password')
    if (!account || !password) return null
    const out: GatewayAccountConfig = { account, password }
    const deviceId = pick('device_id')
    if (deviceId) out.deviceId = deviceId
    return out
  } catch {
    return null
  }
}

function normalizeAccount(v: unknown): GatewayAccountConfig | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  if (typeof o['account'] !== 'string' || o['account'].trim() === '') return undefined
  if (typeof o['password'] !== 'string') return undefined
  const out: GatewayAccountConfig = { account: o['account'].trim(), password: o['password'] }
  if (typeof o['deviceId'] === 'string' && o['deviceId'].trim() !== '') {
    out.deviceId = o['deviceId'].trim()
  }
  return out
}

/** api 三字段（baseUrl/apiKey/model）全为非空字符串才认；缺一即「api 未配置」（configured=false） */
function normalizeApi(v: unknown): ApiChannelConfig | undefined {
  if (typeof v !== 'object' || v === null) return undefined
  const o = v as Record<string, unknown>
  const baseUrl = typeof o['baseUrl'] === 'string' ? o['baseUrl'].trim() : ''
  const apiKey = typeof o['apiKey'] === 'string' ? o['apiKey'].trim() : ''
  const model = typeof o['model'] === 'string' ? o['model'].trim() : ''
  if (baseUrl === '' || apiKey === '' || model === '') return undefined
  return { baseUrl, apiKey, model }
}

function normalizeConfig(raw: unknown): FairyConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const cfg: FairyConfig = { apiKey: newApiKey() }
  if (typeof o['gatewayBin'] === 'string' && o['gatewayBin'] !== '') cfg.gatewayBin = o['gatewayBin']
  // apiKey 缺失/损坏就补一个新的（网关 401 时重新保存配置也能恢复）
  cfg.apiKey = typeof o['apiKey'] === 'string' && o['apiKey'] !== '' ? o['apiKey'] : newApiKey()
  cfg.account = normalizeAccount(o['account'])
  // channel 只接受 'api'/'web'，其余（含缺省/坏值）一律 null = 尚未选择
  cfg.channel = o['channel'] === 'api' || o['channel'] === 'web' ? o['channel'] : null
  cfg.api = normalizeApi(o['api'])
  return cfg
}

/** 读配置；文件不存在 → 首启自动创建（含二进制探测 + 一次性迁移）；损坏 → .bak 备份后重建 */
export function loadConfig(): FairyConfig {
  const p = configPath()
  if (existsSync(p)) {
    try {
      const cfg = normalizeConfig(JSON.parse(readFileSync(p, 'utf8')))
      if (cfg) return cfg
    } catch {
      /* JSON 解析失败 / 结构不对：落到备份 + 重建 */
    }
    try {
      renameSync(p, `${p}.bak`) // 备份损坏的原件，排查用
    } catch {
      /* 备份失败则保持现状（重建会原子覆盖） */
    }
  }
  // 首启自动创建（§5.6：channel 缺省 null，不默认任何通道；api 缺省 = configured:false）
  const cfg: FairyConfig = { gatewayBin: probeGatewayBin(), apiKey: newApiKey(), channel: null }
  const migrated = migrateFromGatewayToml()
  if (migrated) cfg.account = migrated
  saveConfig(cfg)
  return cfg
}

/** 保存配置：tmp + rename 原子替换（防并发读端 / 写一半崩溃产生半截 JSON） */
export function saveConfig(cfg: FairyConfig): void {
  const p = configPath()
  writeFileSync(`${p}.tmp`, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  renameSync(`${p}.tmp`, p)
}
