/**
 * 一键诊断导出（阶段 6 / DEV_PLAN §6.6.3）。
 *
 * 产出单个 JSON 报告（用户自选保存位置），内容 = 版本 / 系统信息 / 通道与网关状态 /
 * 存储与日志清单 / 当天日志尾部（脱敏）。
 *
 * **绝不包含凭据**：不读 config.json / secrets.dpapi.json 内容，只报"存在与否"；
 * 日志尾部再过一遍脱敏（API Key / password / sk- 前缀 / 邮箱 / 手机号），
 * 即便日志里意外打过敏感串，报告里也是 `***`。
 */
import { app, dialog, shell } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { FAIRY_VERSION } from '@fairy/core'
import type { DiagnosticsExportResult } from '@fairy/core'
import { configFilePath, loadConfig } from './config'
import { getChannelState } from './channel'
import { logsDir } from './logger'
import { isSecretsProtected } from './secrets'

const LOG_TAIL_LINES = 200

function bytes(path: string): number | null {
  try {
    return existsSync(path) ? statSync(path).size : null
  } catch {
    return null
  }
}

/** 敏感串脱敏：key / password / token / sk- 前缀 / 邮箱 / 手机号 */
function redact(line: string): string {
  return line
    .replace(/((?:api[_-]?key|password|passwd|token|secret|authorization)"?\s*[:=]\s*"?)[^",\s}]+/gi, '$1***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '***手机号***')
}

function logFiles(): { name: string; bytes: number; modifiedAt: string }[] {
  const dir = logsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => /^fairy-.*\.log$/.test(n))
    .map((n) => {
      const st = statSync(join(dir, n))
      return { name: n, bytes: st.size, modifiedAt: st.mtime.toISOString() }
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, 10)
}

function logTail(): string[] {
  const files = logFiles()
  if (files.length === 0) return []
  try {
    const text = readFileSync(join(logsDir(), files[0].name), 'utf8')
    return text.split(/\r?\n/).slice(-LOG_TAIL_LINES).map(redact)
  } catch {
    return []
  }
}

function buildReport(): Record<string, unknown> {
  const channel = getChannelState()
  const userData = app.getPath('userData')
  const cfg = loadConfig()
  return {
    generatedAt: new Date().toISOString(),
    fairy: {
      version: FAIRY_VERSION,
      appId: 'com.fairy.assistant',
      packaged: app.isPackaged,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      locale: app.getLocale()
    },
    os: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      type: os.type(),
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMB: Math.round(os.freemem() / 1024 / 1024),
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      uptimeMin: Math.round(os.uptime() / 60)
    },
    paths: { userData, exe: app.getPath('exe'), resourcesPath: process.resourcesPath },
    autostart: {
      openAtLogin: app.getLoginItemSettings({ path: process.execPath }).openAtLogin
    },
    // 通道状态只含 baseUrl/model/网关状态，**不含** apiKey / 账号 / 密码
    channel: {
      channel: channel.channel,
      api: channel.api,
      web: { accountConfigured: channel.web.accountConfigured, gateway: channel.web.gateway }
    },
    storage: {
      configExists: existsSync(configFilePath()),
      configBytes: bytes(configFilePath()),
      secretsExists: existsSync(join(userData, 'secrets.dpapi.json')),
      secretsBytes: bytes(join(userData, 'secrets.dpapi.json')),
      secretsProtected: isSecretsProtected(),
      dbExists: existsSync(join(userData, 'fairy.db')),
      dbBytes: bytes(join(userData, 'fairy.db')),
      // 网关二进制只报“有没有”，不报完整路径（路径含用户名）
      gatewayBinConfigured: Boolean(cfg.gatewayBin),
      gatewayBinExists: Boolean(cfg.gatewayBin && existsSync(cfg.gatewayBin)),
      gatewayConfigBytes: bytes(join(userData, 'gateway', 'config.toml'))
    },
    logs: logFiles(),
    logTail: logTail()
  }
}

/** 一键诊断导出（IPC `app:diagnosticsExport`）：弹保存框 → 写 JSON → 回传路径 */
export async function exportDiagnostics(): Promise<DiagnosticsExportResult> {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const result = await dialog.showSaveDialog({
      title: '导出诊断信息（不含账号凭据）',
      defaultPath: join(app.getPath('documents'), `fairy-diagnostic-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return { ok: false, error: '已取消' }
    writeFileSync(result.filePath, `${JSON.stringify(buildReport(), null, 2)}\n`, 'utf8')
    return { ok: true, path: result.filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 打开日志目录（设置页「打开日志目录」） */
export async function openLogsDir(): Promise<void> {
  await shell.openPath(logsDir())
}
