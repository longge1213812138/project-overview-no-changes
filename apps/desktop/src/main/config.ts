/**
 * 本地配置（DEV_PLAN §5.5 / §7 + §6.6.2 阶段 6 硬化）。
 *
 * 两份文件，职责分离：
 * - `config.json`（明文，可安全进诊断报告）：gatewayBin / channel / api.baseUrl / api.model；
 * - `secrets.dpapi.json`（DPAPI 密文，见 secrets.ts）：账号 + 密码 + device_id、网关 apiKey、API Key。
 *
 * 内存里的 `FairyConfig` 仍是**合并后的明文视图**（sidecar / channel / chat 读写不变），
 * 只有落盘这一层做剥离与解密：saveConfig 拆出密件，loadConfig 合并回来。
 *
 * 迁移（幂等，只在老结构上触发一次）：
 * - 旧明文 config.json 里若有 apiKey / account.password / api.apiKey → 自动搬进 DPAPI 密件并重写 config.json；
 * - 首启（config.json 不存在）：探测网关二进制 + 从已知 ds-free-api config.toml 一次性迁移账号。
 *
 * 并发/损坏策略：
 * - main 是单实例锁下的唯一写者；保存走 tmp + rename（同卷近原子），
 *   读端永远不会看到半截文件；
 * - JSON 解析失败 → 原文件备份为 .bak 后按"不存在"重建，绝不崩溃。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { ApiChannelConfig, ChannelKind, GatewayAccountConfig } from '@fairy/core'
import { readSecrets, writeSecrets } from './secrets'
import type { SecretValues } from './secrets'

export interface FairyConfig {
  /** ds-free-api 网关二进制路径；空/缺 = 未找到（网关状态报「未找到网关二进制」） */
  gatewayBin?: string
  /** 网关 [[api_keys]] 用的 key，首启自动生成（DPAPI 存储） */
  apiKey: string
  /** DeepSeek 账号池凭据（账号/密码/device_id，DPAPI 存储） */
  account?: GatewayAccountConfig
  /** 接入通道（DEV_PLAN §5.6）：'api' | 'web'；缺省/null = 尚未选择（设置页展示双通道选择卡） */
  channel?: ChannelKind | null
  /** OpenAI 兼容 API 供应商配置（baseUrl/apiKey/model；apiKey 走 DPAPI）；缺省 = 未配置 */
  api?: ApiChannelConfig
}

/** config.json 的明文部分（密件字段一律不落这里） */
interface PlaintextConfig {
  gatewayBin?: string
  channel?: ChannelKind | null
  api?: { baseUrl: string; model: string }
}

/** 本机已知 ds-free-api 安装目录（docs/llm-bridge-notes.md §2/§6，阶段 2 探测位 ②） */
const KNOWN_GATEWAY_DIR = 'C:\\Users\\91533\\.fairy-tools\\ds-free-api\\ds-free-api-v0.2.11-windows-x86_64'

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
function normalizeApi(baseUrl: unknown, apiKey: unknown, model: unknown): ApiChannelConfig | undefined {
  const b = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  const k = typeof apiKey === 'string' ? apiKey.trim() : ''
  const m = typeof model === 'string' ? model.trim() : ''
  if (b === '' || k === '' || m === '') return undefined
  return { baseUrl: b, apiKey: k, model: m }
}

/** 合并明文 config.json 与 DPAPI 密件 → 内存视图（apiKey 缺失就补一个新的） */
function assemble(plain: PlaintextConfig, secrets: SecretValues): FairyConfig {
  const cfg: FairyConfig = {
    apiKey: secrets.apiKey ?? newApiKey(),
    channel: plain.channel === 'api' || plain.channel === 'web' ? plain.channel : null
  }
  if (plain.gatewayBin !== undefined && plain.gatewayBin !== '') cfg.gatewayBin = plain.gatewayBin
  if (secrets.account) cfg.account = secrets.account
  const api = normalizeApi(plain.api?.baseUrl, secrets.apiApiKey, plain.api?.model)
  if (api) cfg.api = api
  return cfg
}

/** 明文视图 → 只留非密字段（saveConfig 落盘用） */
function strip(cfg: FairyConfig): PlaintextConfig {
  const plain: PlaintextConfig = { channel: cfg.channel ?? null }
  if (cfg.gatewayBin) plain.gatewayBin = cfg.gatewayBin
  if (cfg.api) plain.api = { baseUrl: cfg.api.baseUrl, model: cfg.api.model }
  return plain
}

/** 明文视图 → 密件内容（与 strip 严格互补：saveConfig 写完两份后无任何凭据残留在 config.json） */
function toSecrets(cfg: FairyConfig): SecretValues {
  const secrets: SecretValues = { apiKey: cfg.apiKey }
  if (cfg.account) secrets.account = cfg.account
  if (cfg.api) secrets.apiApiKey = cfg.api.apiKey
  return secrets
}

function writePlaintext(plain: PlaintextConfig): void {
  const p = configFilePath()
  writeFileSync(`${p}.tmp`, `${JSON.stringify(plain, null, 2)}\n`, 'utf8')
  renameSync(`${p}.tmp`, p)
}

/** 读配置；文件不存在 → 首启自动创建（含二进制探测 + 一次性迁移）；损坏 → .bak 备份后重建 */
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

      // ===== 旧明文自动迁移（幂等：搬走后字段即从 config.json 消失，下次不再触发） =====
      let migrated = false
      if (typeof o['apiKey'] === 'string' && o['apiKey'] !== '' && !secrets.apiKey) {
        secrets.apiKey = o['apiKey']
        migrated = true
      }
      const legacyAccount = normalizeAccount(o['account'])
      if (legacyAccount && !secrets.account) {
        secrets.account = legacyAccount
        migrated = true
      }
      const legacyApi = o['api'] as Record<string, unknown> | undefined
      const legacyApiKey =
        typeof legacyApi === 'object' && legacyApi !== null ? legacyApi['apiKey'] : undefined
      if (typeof legacyApiKey === 'string' && legacyApiKey !== '' && !secrets.apiApiKey) {
        secrets.apiApiKey = legacyApiKey
        migrated = true
      }

      const plain: PlaintextConfig = {
        gatewayBin: typeof o['gatewayBin'] === 'string' ? o['gatewayBin'] : undefined,
        channel: o['channel'] === 'api' || o['channel'] === 'web' ? o['channel'] : null,
        api:
          typeof legacyApi === 'object' && legacyApi !== null
            ? {
                baseUrl: typeof legacyApi['baseUrl'] === 'string' ? legacyApi['baseUrl'] : '',
                model: typeof legacyApi['model'] === 'string' ? legacyApi['model'] : ''
              }
            : undefined
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
  // 首启自动创建（§5.6：channel 缺省 null，不默认任何通道；api 缺省 = configured:false）
  const secrets: SecretValues = { apiKey: newApiKey() }
  const migrated = migrateFromGatewayToml()
  if (migrated) secrets.account = migrated
  const cfg = assemble({ channel: null }, secrets)
  saveConfig(cfg)
  return cfg
}

/** 保存配置：密件（DPAPI）+ 明文两份各自 tmp + rename 原子替换 */
export function saveConfig(cfg: FairyConfig): void {
  writeSecrets(toSecrets(cfg))
  writePlaintext(strip(cfg))
}
