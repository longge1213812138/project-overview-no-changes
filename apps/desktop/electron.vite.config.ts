import { join } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// @fairy/core 直接以 TS 源码方式引入，由 electron-vite 统一编译
const coreSrc = join(__dirname, '../../packages/core/src/index.ts')
// 渲染层专用安全入口：不含 gateway/（node:child_process 等），避免打包警告与浏览器端副作用
const coreSrcWeb = join(__dirname, '../../packages/core/src/index.web.ts')

// 注意：@fairy/core 是 workspace 源码包，必须**内联**（exclude 外部化），
// 否则运行期 require('@fairy/core') 会去解析 .ts 源文件而崩溃（阶段 2 踩坑记录）
const coreInline = externalizeDepsPlugin({ exclude: ['@fairy/core'] })

export default defineConfig({
  main: {
    plugins: [coreInline],
    resolve: {
      alias: { '@fairy/core': coreSrc }
    }
  },
  preload: {
    plugins: [coreInline],
    resolve: {
      alias: { '@fairy/core': coreSrc }
    }
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@fairy/core': coreSrcWeb,
        '@renderer': join(__dirname, 'src/renderer/src')
      }
    }
  }
})
