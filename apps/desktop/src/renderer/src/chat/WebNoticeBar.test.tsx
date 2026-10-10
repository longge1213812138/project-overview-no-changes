/**
 * 联网结论提示条单测（jsdom）：文案来自 main（渲染层不自行编造），
 * 这里钉死「能看见结论 + 重试入口可用/在生成中禁用 + 没有用户消息时不给重试」。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WebNotice } from '@fairy/core'
import WebNoticeBar from './WebNoticeBar'

const timeoutNotice: WebNotice = {
  kind: 'timeout',
  message: '联网超时（已等 25.0s）：仅用已取到的 2 条来源作答，结果可能不完整'
}

describe('WebNoticeBar', () => {
  it('渲染结论原文（超时结论一眼可见，不必从模型正文里猜）', () => {
    render(<WebNoticeBar notice={timeoutNotice} busy={false} />)
    const bar = screen.getByRole('status')
    expect(bar.textContent).toContain('联网超时')
    expect(bar.textContent).toContain('2 条来源')
    expect(bar.className).toContain('timeout')
  })

  it('重试按钮：点击回调；生成的按钮挂在提示条内（不撑破气泡）', () => {
    const onRetry = vi.fn()
    render(<WebNoticeBar notice={timeoutNotice} busy={false} onRetry={onRetry} />)
    const btn = screen.getByRole('button', { name: '重新联网' })
    fireEvent.click(btn)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('生成中禁用重试（不排队并发发送）', () => {
    const onRetry = vi.fn()
    render(<WebNoticeBar notice={timeoutNotice} busy onRetry={onRetry} />)
    const btn = screen.getByRole('button', { name: '重新联网' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('没有重试入口（历史里找不到对应用户消息）时只显示结论', () => {
    render(<WebNoticeBar notice={{ kind: 'failed', message: '联网失败：检索源不可达' }} busy={false} />)
    expect(screen.getByRole('status').textContent).toContain('检索源不可达')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('部分完成（partial）用中性样式，不当失败报', () => {
    render(
      <WebNoticeBar
        notice={{ kind: 'partial', message: '联网部分完成：2 条来源可用，1 项未取到' }}
        busy={false}
      />
    )
    expect(screen.getByRole('status').className).toContain('partial')
  })

  it('降级（degraded）说明换了源，同样不是报错样式', () => {
    render(
      <WebNoticeBar
        notice={{
          kind: 'degraded',
          message: '联网已降级：主检索源 duckduckgo 不可达（检索失败：fetch failed），本次结果来自备用源 bing'
        }}
        busy={false}
      />
    )
    const bar = screen.getByRole('status')
    expect(bar.className).toContain('degraded')
    expect(bar.textContent).toContain('备用源 bing')
  })
})
