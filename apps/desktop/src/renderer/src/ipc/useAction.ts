/**
 * `useAction`：一次会改动状态的写操作（GLOSSARY.md: Action）。
 *
 * 面板只声明「做什么」与「成功后刷新什么」，下面三件事藏在 hook 里：
 * - 按 key 的忙碌态（同一面板里多个实体各自忙碌，如按日程 id）；
 * - 成败归一为一条 Feedback（client 已保证写操作不抛）；
 * - 成功回调（通常传 `resource.refresh`），避免每个面板各写一次 `if (ok) reload()`。
 *
 * `fail` 供本地校验（不经过 IPC 的拒绝，如「标题不能为空」）复用同一条反馈通道。
 */
import { useCallback, useState } from 'react'
import type { FairyClient, Feedback, IpcResult } from '@fairy/core'
import { defaultFairyClient } from './fairyClient'

export interface ActionOptions {
  /** 成功后调用（通常是 `resource.refresh`） */
  onSuccess?: () => void | Promise<void>
  /** 成功后的绿条文案 */
  successNotice?: string
}

export interface Action {
  run<T>(
    key: string | null,
    fn: (client: FairyClient) => Promise<IpcResult<T>>,
    options?: ActionOptions
  ): Promise<IpcResult<T>>
  busy(key?: string | null): boolean
  feedback: Feedback | null
  /** 本地校验失败等：直接给一条红条反馈 */
  fail(text: string): void
  reset(): void
}

/** 不传 key 时的忙碌槽位 */
const SINGLE = '__single__'

export function useAction(client: FairyClient = defaultFairyClient()): Action {
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const run = useCallback(
    async <T,>(
      key: string | null,
      fn: (c: FairyClient) => Promise<IpcResult<T>>,
      options?: ActionOptions
    ): Promise<IpcResult<T>> => {
      const slot = key ?? SINGLE
      setPending((prev) => new Set(prev).add(slot))
      setFeedback(null)
      const result = await fn(client)
      if (result.ok) {
        if (options?.successNotice !== undefined) {
          setFeedback({ kind: 'ok', text: options.successNotice })
        }
        if (options?.onSuccess !== undefined) await options.onSuccess()
      } else {
        setFeedback({ kind: 'err', text: result.error })
      }
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(slot)
        return next
      })
      return result
    },
    [client]
  )

  const busy = useCallback((key?: string | null) => pending.has(key ?? SINGLE), [pending])
  const fail = useCallback((text: string) => setFeedback({ kind: 'err', text }), [])
  const reset = useCallback(() => setFeedback(null), [])

  return { run, busy, feedback, fail, reset }
}
