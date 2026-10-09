/**
 * `useResource`：一份从 main 取来、并随 main 的变更声明而重新取的数据（GLOSSARY.md: Resource）。
 *
 * 面板只声明「取什么」与「何时重载」，下面三件事藏在 hook 里：
 * - 首载与订阅的接线（订阅退订随组件卸载）；
 * - 过期响应丢弃（后发起的刷新结果一定胜过先发起的，无论谁先返回）；
 * - 读失败保留上一次数据（stale-while-error），只更新 error。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FairyClient, IpcResult } from '@fairy/core'
import { defaultFairyClient } from './fairyClient'

export type ResourceLoader<T> = (client: FairyClient) => Promise<IpcResult<T>>
export type ResourceSubscriber = (client: FairyClient, refresh: () => void) => () => void

export interface Resource<T> {
  data: T | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

export function useResource<T>(
  load: ResourceLoader<T>,
  subscribe: ResourceSubscriber | null,
  deps: unknown[],
  client: FairyClient = defaultFairyClient()
): Resource<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // load 存 ref：面板不必再写 useCallback，deps 才是重载的唯一开关
  const loadRef = useRef(load)
  loadRef.current = load
  const seqRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current
    setLoading(true)
    const result = await loadRef.current(client)
    if (seq !== seqRef.current) return // 过期响应：更晚发起的刷新已经落地
    if (result.ok) {
      setData(result.value)
      setError(null)
    } else {
      setError(result.error)
    }
    setLoading(false)
  }, [client])

  useEffect(() => {
    void refresh()
    if (subscribe === null) return undefined
    return subscribe(client, () => void refresh())
    // deps 由调用方声明；load / subscribe 故意不入依赖（走 ref 与稳定引用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, subscribe, client, ...deps])

  return { data, loading, error, refresh }
}
