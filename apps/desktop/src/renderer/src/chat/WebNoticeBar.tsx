import type { WebNotice } from '@fairy/core'

/**
 * 阶段 10 硬化：气泡下方的「联网结论」提示条。
 *
 * 为什么需要它：联网失败/超时/只取到部分资料时，过去只有模型正文里的一句转述，
 * 用户无法区分「这次没联网」和「联了但没查到」——提示条把结论摆在气泡下方，
 * 并给一个明确出口（重新联网 = 重发上一条用户消息）。
 *
 * 纯展示组件（无副作用、不碰 window.fairy）：文案来自 main 的 WebNotice.message，
 * 渲染层不自行编造措辞；`busy` 期间禁用重试（生成中不排队）。
 */
const KIND_ICON: Record<WebNotice['kind'], string> = {
  timeout: '⏱',
  partial: '⚠️',
  failed: '⚠️',
  // 降级不是错误：主源不可达但资料完整（中性色，见 style.css 的 .web-notice.degraded）
  degraded: '🔀'
}

export interface WebNoticeBarProps {
  notice: WebNotice
  /** 生成中：重试按钮禁用（避免并发发送） */
  busy: boolean
  /** 重试动作（重发上一条用户消息）；缺省 = 不给重试入口（如历史里找不到用户消息） */
  onRetry?: (() => void) | undefined
}

export default function WebNoticeBar({ notice, busy, onRetry }: WebNoticeBarProps) {
  return (
    <div className={`web-notice ${notice.kind}`} role="status">
      <span className="web-notice-text">
        {KIND_ICON[notice.kind]} {notice.message}
      </span>
      {onRetry !== undefined && (
        <button className="web-notice-retry" disabled={busy} onClick={onRetry}>
          重新联网
        </button>
      )}
    </div>
  )
}
