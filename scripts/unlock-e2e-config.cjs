/**
 * 阶段 7 端到端验收辅助：解密 DPAPI 密件 + 合并通道配置，写入临时 JSON 供测试读取。
 *
 * - 输出文件默认 %TEMP%/fairy-e2e-config.json（0600），**不把 key 打到 stdout**；
 *   stdout 只打印输出文件路径。
 * - 运行方式（必须是 Electron 主进程上下文，safeStorage 才可用）：
 *     npx electron scripts/unlock-e2e-config.cjs
 *   注意附录 C：不要设置 ELECTRON_RUN_AS_NODE（会退化为纯 Node，safeStorage 不存在）。
 * - 密件格式见 apps/desktop/src/main/secrets.ts：{ v:1, protected, data:base64 }。
 */
const { app, safeStorage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// safeStorage 的 DPAPI 熵绑定 app name（productName=Fairy）；本脚本在仓库根运行时
// app name 会解析成根 package.json 的 fairy，必须显式对齐，否则解不开应用写的密件。
app.setName('Fairy')

app.whenReady().then(() => {
  try {
    const dir = path.join(process.env.APPDATA, 'fairy')
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
    if (!cfg.api || cfg.channel !== 'api') {
      throw new Error(`当前通道不是 api（channel=${cfg.channel}），跳过 E2E 配置导出`)
    }
    const sec = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.dpapi.json'), 'utf8'))
    const raw = Buffer.from(sec.data, 'base64')
    const plain = sec.protected ? safeStorage.decryptString(raw) : raw.toString('utf8')
    const secrets = JSON.parse(plain)
    if (!secrets.apiApiKey) throw new Error('secrets 中无 apiApiKey')

    const out = path.join(os.tmpdir(), 'fairy-e2e-config.json')
    fs.writeFileSync(
      out,
      JSON.stringify(
        { baseUrl: cfg.api.baseUrl, model: cfg.api.model, apiKey: secrets.apiApiKey },
        null,
        2
      ),
      { mode: 0o600 }
    )
    console.log(out)
    app.exit(0)
  } catch (err) {
    console.error('[unlock-e2e] ' + (err && err.message ? err.message : String(err)))
    app.exit(1)
  }
})
