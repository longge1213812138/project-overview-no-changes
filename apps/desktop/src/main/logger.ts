/**
 * 日志（阶段 6 / DEV_PLAN §6.6.3）：electron-log，**按天滚动，保留 7 天**。
 *
 * - 文件：`%APPDATA%/fairy/logs/fairy-YYYY-MM-DD.log`（resolvePathFn 按写入日取名，
 *   跨天自然滚动）；单文件超 8MB 时 electron-log 归档为 `.old.log`；
 * - 启动时清理 7 天前的 `fairy-*.log` / `fairy-*.old.log`（只删自己命名的日志）；
 * - 顺带留痕：renderer 崩溃 / 子进程退出原因 / 未捕获异常（诊断报告的重要线索）。
 *
 * 约定：main 进程一律 `import { log } from './logger'`，不要直接 console.* ——
 * console 在打包后（无控制台）等于丢日志。
 */
import log from 'electron-log'
import { app } from 'electron'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { FAIRY_VERSION } from '@fairy/core'

export { log }

const KEEP_DAYS = 7
const DAY_RE = /^fairy-\d{4}-\d{2}-\d{2}(\.old)?\.log$/

export function logsDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function dayStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 删除 7 天前的日志（只认 fairy-*.log 命名，绝不误删用户文件） */
function cleanupOldLogs(dir: string): void {
  if (!existsSync(dir)) return
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
  for (const name of readdirSync(dir)) {
    if (!DAY_RE.test(name)) continue
    try {
      if (statSync(join(dir, name)).mtimeMs < cutoff) rmSync(join(dir, name), { force: true })
    } catch {
      /* 单个文件删除失败不影响启动 */
    }
  }
}

/** whenReady 之前调用（initUserDataPath 之后）；幂等（重复调用只重挂 resolvePath） */
export function initLogger(): void {
  const dir = logsDir()
  log.transports.file.resolvePathFn = (): string => join(dir, `fairy-${dayStamp()}.log`)
  log.transports.file.maxSize = 8 * 1024 * 1024
  log.transports.file.level = 'info'
  log.transports.console.level = 'info'
  cleanupOldLogs(dir)

  // renderer 崩溃 / 子进程退出原因留痕（打包后没有控制台，这些只能进日志）
  app.on('web-contents-created', (_e, contents) => {
    contents.on('render-process-gone', (_ev, details) => {
      log.error(`[renderer] render-process-gone: ${details.reason} exitCode=${details.exitCode}`)
    })
  })
  app.on('child-process-gone', (_e, details) => {
    log.error(
      `[child-process] gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`
    )
  })

  // 未捕获异常/未处理 rejection：记日志后不主动退出（托盘常驻 + 待触发日程比"干净崩掉"更值钱）
  process.on('uncaughtException', (err) => log.error('uncaughtException:', err))
  process.on('unhandledRejection', (reason) => log.error('unhandledRejection:', reason))

  log.info(
    `Fairy ${FAIRY_VERSION} 启动 | electron ${process.versions.electron} | node ${process.versions.node} | ` +
      `${process.platform}/${process.arch} | packaged=${app.isPackaged}`
  )
}
