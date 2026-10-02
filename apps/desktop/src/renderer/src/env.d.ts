import type { FairyApi } from '@fairy/core'

declare module '*.css' {
  const css: string
  export default css
}

declare global {
  interface Window {
    /** preload 暴露的 IPC 面（契约见 packages/core/src/ipc.ts）+ 应用元信息 */
    fairy: FairyApi & { name: string; version: string }
  }
}

export {}
