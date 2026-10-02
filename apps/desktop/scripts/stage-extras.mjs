/**
 * 打包前置资源 staging（阶段 6 / DEV_PLAN §6.6）。
 *
 * electron-builder 的 extraResources 需要一个确定的源目录，而 ds-free-api 网关
 * 二进制（~31MB）本机装在用户目录、不入 git。本脚本在 `package:win` 之前把它
 * 预置到 `apps/desktop/resources/ds-free-api/`（已 gitignore）：
 *
 *   来源优先级：① 环境变量 FAIRY_GATEWAY_DIR ② 本机已知安装目录（附录 C）
 *   复制内容：ds-free-api.exe + LICENSE + README*.md + config.example.toml
 *   **绝不复制 config.toml / logs / *.log**（config.toml 含 DeepSeek 明文凭据）
 *
 * 缺二进制时默认**失败**（打包产物必须自带网关，验收要「干净虚拟机首次登录 < 10 分钟」）；
 * 确实要出一个不带网关的产物时，用 `FAIRY_SKIP_GATEWAY=1` 显式跳过。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const resourcesDir = join(scriptDir, '..', 'resources')
const targetDir = join(resourcesDir, 'ds-free-api')

/** 本机已知 ds-free-api 安装目录（docs/llm-bridge-notes.md §2 / 附录 C） */
const KNOWN_GATEWAY_DIR =
  'C:\\Users\\91533\\.fairy-tools\\ds-free-api\\ds-free-api-v0.2.11-windows-x86_64'

/** 允许复制的文件名（白名单）；config.toml/日志等一概不带 */
const ALLOW = /^(ds-free-api\.exe|LICENSE|README.*\.md|config\.example\.toml)$/i

function fail(msg) {
  console.error(`[stage-extras] 失败：${msg}`)
  process.exit(1)
}

function findSourceDir() {
  const candidates = [process.env.FAIRY_GATEWAY_DIR, KNOWN_GATEWAY_DIR].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'ds-free-api.exe'))) return dir
  }
  return null
}

const srcDir = findSourceDir()
if (!srcDir) {
  if (process.env.FAIRY_SKIP_GATEWAY === '1') {
    console.warn('[stage-extras] 未找到 ds-free-api.exe，FAIRY_SKIP_GATEWAY=1 → 产物将不带网关二进制')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(
      join(targetDir, 'MISSING.txt'),
      'ds-free-api.exe 未随包分发（构建时 FAIRY_SKIP_GATEWAY=1）。\n',
      'utf8'
    )
    process.exit(0)
  }
  fail(
    `未找到 ds-free-api 网关二进制（找过：${[process.env.FAIRY_GATEWAY_DIR, KNOWN_GATEWAY_DIR]
      .filter(Boolean)
      .join(' , ')}）。设置 FAIRY_GATEWAY_DIR 指向含 ds-free-api.exe 的目录，或 FAIRY_SKIP_GATEWAY=1 出不带网关的包。`
  )
}

mkdirSync(targetDir, { recursive: true })

// 清掉白名单之外的历史残留（尤其是 config.toml / 日志），再重新复制
for (const name of readdirSync(targetDir)) {
  if (!ALLOW.test(name)) {
    rmSync(join(targetDir, name), { recursive: true, force: true })
    console.log(`[stage-extras] 清理非白名单残留：${name}`)
  }
}

const srcExe = join(srcDir, 'ds-free-api.exe')
const dstExe = join(targetDir, 'ds-free-api.exe')
const needCopy = !existsSync(dstExe) || statSync(dstExe).mtimeMs < statSync(srcExe).mtimeMs

if (needCopy) {
  for (const name of readdirSync(srcDir)) {
    if (!ALLOW.test(name)) continue
    copyFileSync(join(srcDir, name), join(targetDir, name))
    console.log(`[stage-extras] 复制 ${name}`)
  }
} else {
  console.log('[stage-extras] resources/ds-free-api/ 已是最新，跳过复制')
}

const sizeMb = (statSync(dstExe).size / 1024 / 1024).toFixed(1)
console.log(`[stage-extras] 网关二进制就绪：${dstExe}（${sizeMb}MB），来源：${srcDir}`)
