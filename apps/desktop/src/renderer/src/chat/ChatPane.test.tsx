/**
 * 聊天气泡面板：空状态渲染（jsdom）。
 *
 * 只钉**结构不变量**（人设文案会随 SOUL.md 迭代，不做逐字断言）：
 * 无历史时给出待命态 + 三条示例按钮；输入区提示快捷键。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FairyApi } from '@fairy/core'
import ChatPane from './ChatPane'

/** 最小 window.fairy 替身：只为渲染空状态（不触真 IPC） */
function stubFairy(): void {
  const noop = (): (() => void) => () => {}
  const api = {
    chat: {
      history: async () => [],
      send: async () => ({ ok: true }),
      stop: async () => {},
      onDelta: noop,
      onDone: noop,
      onBusy: noop
    },
    agent: undefined,
    openExternal: async () => {}
  }
  ;(window as unknown as { fairy: FairyApi }).fairy = api as unknown as FairyApi
}

afterEach(() => {
  delete (window as unknown as { fairy?: FairyApi }).fairy
})

describe('ChatPane 空状态', () => {
  it('无历史 → 待命态标题 + 示例按钮 + 输入提示', async () => {
    stubFairy()
    render(<ChatPane sessionId="s-empty" />)

    await waitFor(() => expect(screen.getByText(/Fairy 待命中/)).toBeTruthy())
    // 三条能力示例（记忆 / 联网 / 日程）都可点
    const examples = screen.getAllByRole('button').filter((b) => b.className === 'example-btn')
    expect(examples).toHaveLength(3)
    // 输入区仍提示快捷键（可发现性不能因为改文案丢掉）
    expect(screen.getByPlaceholderText(/Enter 发送/)).toBeTruthy()
  })
})
