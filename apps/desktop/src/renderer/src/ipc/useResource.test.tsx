/**
 * `useResource` 单测（jsdom）：首载、订阅触发重取、过期响应丢弃、读失败保留旧数据。
 * 这三条内部规则是引入 hook 的核心理由，面板层测不到，只能在这里钉死。
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FairyClient, IpcResult } from '@fairy/core'
import { useResource } from './useResource'

type LoadResult = IpcResult<string>

/** 可调用次数的假 loader（避免 vi.fn 的泛型噪音） */
function loader(impl: (call: number) => Promise<LoadResult>): ResourceLoaderOfTest {
  let calls = 0
  const fn = (async () => {
    calls += 1
    return impl(calls)
  }) as unknown as ResourceLoaderOfTest
  fn.count = () => calls
  return fn
}

type ResourceLoaderOfTest = ((client: FairyClient) => Promise<LoadResult>) & { count: () => number }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** 被测 hook 只从 client 上取数据源，这里给个空替身即可 */
const client = {} as unknown as FairyClient

function captureSubscribe(): { subscribe: (c: FairyClient, refresh: () => void) => () => void; fire: () => void } {
  let refresh: (() => void) | null = null
  return {
    subscribe: (_c, r) => {
      refresh = r
      return () => undefined
    },
    fire: () => {
      if (refresh === null) throw new Error('订阅尚未注册')
      refresh()
    }
  }
}

describe('useResource', () => {
  it('首载成功 → data 就位，loading 收敛，error 为空', async () => {
    const load = loader(async () => ({ ok: true, value: 'A' }))
    const { result } = renderHook(() => useResource<string>(load, null, [], client))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toBe('A')
    expect(result.current.error).toBeNull()
  })

  it('订阅回调触发重新取数', async () => {
    const load = loader(async (call) => ({ ok: true, value: `v${call}` }))
    const sub = captureSubscribe()
    const { result } = renderHook(() => useResource<string>(load, sub.subscribe, [], client))

    await waitFor(() => expect(result.current.data).toBe('v1'))

    await act(async () => {
      sub.fire()
    })

    await waitFor(() => expect(result.current.data).toBe('v2'))
    expect(load.count()).toBe(2)
  })

  it('过期响应被丢弃：先发起的慢响应不得覆盖后发起的结果', async () => {
    const stale = deferred<LoadResult>()
    const fresh = deferred<LoadResult>()
    const load = loader(async (call) => (call === 1 ? stale.promise : fresh.promise))
    const sub = captureSubscribe()
    const { result } = renderHook(() => useResource<string>(load, sub.subscribe, [], client))

    await act(async () => {
      sub.fire() // 第二次刷新先返回
      fresh.resolve({ ok: true, value: 'NEW' })
    })
    await waitFor(() => expect(result.current.data).toBe('NEW'))

    await act(async () => {
      stale.resolve({ ok: true, value: 'OLD' }) // 过期响应后到
    })
    expect(result.current.data).toBe('NEW')
  })

  it('读失败保留旧数据（stale-while-error）', async () => {
    const load = loader(async (call) =>
      call === 1 ? { ok: true, value: 'A' } : { ok: false, error: '读盘失败' }
    )
    const { result } = renderHook(() => useResource<string>(load, null, [], client))

    await waitFor(() => expect(result.current.data).toBe('A'))

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.data).toBe('A')
    expect(result.current.error).toBe('读盘失败')
  })
})
