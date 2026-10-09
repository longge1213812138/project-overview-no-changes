/**
 * 凭据保险箱（阶段 6 / DEV_PLAN §6.6.2）：OpenAI 兼容 API Key、MCP env
 * 一律**不落明文**，走 Windows DPAPI（`safeStorage` 在 win32 下
 * 即 `CryptProtectData`/`CryptUnprotectData`，绑定当前用户账户，换用户/换机器无法解）。
 *
 * 存储：`%APPDATA%/fairy/secrets.dpapi.json`
 *   { "v": 1, "protected": true, "data": "<base64(DPAPI 密文)>" }
 *   data = base64(safeStorage.encryptString(JSON.stringify(SecretValues)))
 *
 * 降级：safeStorage 不可用（极少数组策略/老系统）→ `protected:false` + base64 明文 JSON，
 * 并在诊断报告里如实标注 `secretsProtected:false`（绝不静默假装已加密）。
 *
 * 解密结果在进程内缓存：loadConfig 被高频调用（每次消息发送 / 状态查询），
 * 每次 spawn PowerShell / 解密会拖慢交互，故只在首次读 / 写后解密一次。
 *
 * 损坏/解密失败：原文件改名 `.bak` 保留排查，返回空对象（宁可丢配置，不崩、不写脏数据）。
 */
import { safeStorage } from 'electron'
import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './logger'

/** 明文密件内容（只在 main 进程内存中出现；不回传 renderer，不落明文盘） */
export interface SecretValues {
  /** OpenAI 兼容 API 的 apiKey（config.json 里只留 baseUrl/model） */
  apiApiKey?: string
  /** 阶段 8：MCP 服务器的追加 env（可能含 token；{server: {KEY: VALUE}}，绝不回传 renderer） */
  mcpEnv?: Record<string, Record<string, string>>
}

interface SecretsFile {
  v: 1
  protected: boolean
  data: string
}

let cached: SecretValues | null = null
/** 本次读取是否丢弃了已移除的网页通道遗留密件（config.ts 借此触发一次性重写） */
let droppedLegacyGatewaySecrets = false
/** 是否已读过（区分「没存过」与「没读过」） */
let loaded = false
/** 最近一次写入是否真的走了 DPAPI（诊断报告用） */
let lastProtected = true

function secretsPath(): string {
  return join(app.getPath('userData'), 'secrets.dpapi.json')
}

function canProtect(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function toBase64(buf: Buffer): string {
  return buf.toString('base64')
}

/** JSON → DPAPI 密文 → base64 */
function seal(plain: string): { protected: boolean; data: string } {
  if (canProtect()) {
    return { protected: true, data: toBase64(safeStorage.encryptString(plain)) }
  }
  return { protected: false, data: toBase64(Buffer.from(plain, 'utf8')) }
}

/** base64 → DPAPI 解密 → JSON 字符串；失败抛错（调用方兜底） */
function open(file: SecretsFile): string {
  const raw = Buffer.from(file.data, 'base64')
  return file.protected ? safeStorage.decryptString(raw) : raw.toString('utf8')
}

function normalize(values: unknown): SecretValues {
  if (typeof values !== 'object' || values === null) return {}
  const o = values as Record<string, unknown>
  // 已移除的网页通道遗留密件（网关 apiKey / DeepSeek 账号）：识别并丢弃，由 config.ts 触发一次性重写
  if ((typeof o.apiKey === 'string' && o.apiKey !== '') || o.account !== undefined) {
    droppedLegacyGatewaySecrets = true
  }
  const out: SecretValues = {}
  if (typeof o.apiApiKey === 'string' && o.apiApiKey !== '') out.apiApiKey = o.apiApiKey
  const mcpEnv = normalizeMcpEnv(o.mcpEnv)
  if (mcpEnv) out.mcpEnv = mcpEnv
  return out
}

/** 密件 mcpEnv 归一：只保留 string→string 形状，空值丢弃 */
function normalizeMcpEnv(raw: unknown): Record<string, Record<string, string>> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const out: Record<string, Record<string, string>> = {}
  for (const [server, env] of Object.entries(raw as Record<string, unknown>)) {
    if (server.trim() === '' || typeof env !== 'object' || env === null || Array.isArray(env)) continue
    const clean: Record<string, string> = {}
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (key.trim() !== '' && typeof value === 'string' && value !== '') clean[key] = value
    }
    if (Object.keys(clean).length > 0) out[server] = clean
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 读密件（进程内缓存；文件不存在 = 首启，返回 {}） */
export function readSecrets(): SecretValues {
  if (loaded) return { ...cached }
  loaded = true
  cached = {}
  const p = secretsPath()
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as SecretsFile
    if (parsed?.v !== 1 || typeof parsed.data !== 'string') throw new Error('结构非法')
    cached = normalize(JSON.parse(open(parsed)))
    lastProtected = parsed.protected
  } catch (err) {
    // 解密失败（DPAPI 换用户/损坏）→ 备份原件，绝不覆盖、绝不崩
    try {
      renameSync(p, `${p}.bak`)
    } catch {
      /* 备份失败就保持原样 */
    }
    log.warn('[secrets] 密件读取失败，已备份为 .bak 并按空处理：', (err as Error).message)
  }
  return { ...cached }
}

/** 写密件（tmp + rename 原子替换）；返回本次是否真的 DPAPI 加密 */
export function writeSecrets(values: SecretValues): boolean {
  const file: SecretsFile = { v: 1, ...seal(JSON.stringify(values)) }
  const p = secretsPath()
  writeFileSync(`${p}.tmp`, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(`${p}.tmp`, p)
  cached = { ...values }
  loaded = true
  lastProtected = file.protected
  droppedLegacyGatewaySecrets = false // 已按当前结构重写，不再有遗留字段
  return file.protected
}

/** config.ts 用：上次读取是否丢弃了网页通道遗留密件（网关 apiKey / 账号）→ 触发一次性重写 */
export function hadLegacyGatewaySecrets(): boolean {
  return droppedLegacyGatewaySecrets
}

/** 诊断报告用：密件当前是否受 DPAPI 保护（未落盘过 = true，因为一旦落盘就会加密） */
export function isSecretsProtected(): boolean {
  return loaded ? lastProtected : canProtect()
}
