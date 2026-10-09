import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 用 .mts 而不是 .ts：apps/desktop/package.json 没有 "type": "module"，
// vite 会把 .ts 配置按 CommonJS 加载并给出告警（ESM 语法在 CJS 文件里）。
const root = import.meta.dirname

// @fairy/core 是 workspace 源码包，按环境选入口（与 electron.vite.config.ts 的 alias 规则一致）：
// - main 侧用完整入口（含 store / cron 的 node 依赖）；
// - renderer 侧必须用 web-safe 的 index.web.ts，否则会把 better-sqlite3 拉进 jsdom。
const coreSrc = join(root, '../../packages/core/src/index.ts')
const coreSrcWeb = join(root, '../../packages/core/src/index.web.ts')

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: { '@fairy/core': coreSrc } },
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts']
        }
      },
      {
        plugins: [react()],
        resolve: { alias: { '@fairy/core': coreSrcWeb } },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['./src/renderer/test-setup.ts']
        }
      }
    ]
  }
})
