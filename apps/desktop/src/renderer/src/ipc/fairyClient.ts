/**
 * 渲染层默认 Fairy client：把 preload 暴露的 `window.fairy` 适配一次并缓存（ADR-0001）。
 *
 * 只有组件/hook 的默认参数走这里；测试直接把替身 client 传给 hook 或面板，不经过本文件。
 */
import { createFairyClient } from '@fairy/core'
import type { FairyClient } from '@fairy/core'

let cached: FairyClient | null = null

export function defaultFairyClient(): FairyClient {
  if (cached === null) cached = createFairyClient(window.fairy)
  return cached
}
