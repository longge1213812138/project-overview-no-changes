import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionMeta } from '@fairy/core'

/**
 * 阶段 3：会话侧栏（仅主窗口聊天 tab 显示）。
 *
 * 数据来源：`window.fairy.sessions`（契约见 packages/core/src/ipc.ts）：
 * - list() + onChanged 订阅刷新；updatedAt 降序展示
 * - 「＋ 新建会话」→ create() 并选中；悬浮删除按钮 → confirm → remove()
 * - 选中态由父组件持有（props.currentId / onSelect），无全局单例状态
 */
interface SessionSidebarProps {
  currentId: string | null
  onSelect: (id: string) => void
}

export default function SessionSidebar({ currentId, onSelect }: SessionSidebarProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [loaded, setLoaded] = useState(false)
  /** 防 StrictMode / 并发刷新触发重复自动建会话 */
  const selectingRef = useRef(false)
  const currentRef = useRef(currentId)
  currentRef.current = currentId

  const refresh = useCallback(async () => {
    try {
      const list = await window.fairy.sessions.list()
      setSessions([...list].sort((a, b) => b.updatedAt - a.updatedAt))
      setLoaded(true)
    } catch {
      // main 侧未就绪时忽略，由 onChanged / 下一次刷新补齐
    }
  }, [])

  useEffect(() => {
    void refresh()
    return window.fairy.sessions.onChanged(() => {
      void refresh()
    })
  }, [refresh])

  // 自动选中：当前选中项不在列表里 → 切到最新一条；列表为空 → 新建一条并选中
  useEffect(() => {
    if (!loaded || selectingRef.current) return
    if (currentId !== null && sessions.some((s) => s.id === currentId)) return
    selectingRef.current = true
    const run = async (): Promise<void> => {
      try {
        const first = sessions[0] // 已按 updatedAt 降序
        if (first) {
          onSelect(first.id)
        } else {
          const created = await window.fairy.sessions.create()
          onSelect(created.id)
        }
      } catch {
        // 创建失败时留空，用户可手动点「＋ 新建会话」
      } finally {
        selectingRef.current = false
      }
    }
    void run()
  }, [loaded, sessions, currentId, onSelect])

  const handleCreate = useCallback(async () => {
    try {
      const created = await window.fairy.sessions.create()
      onSelect(created.id)
    } catch {
      // noop
    }
  }, [onSelect])

  const handleRemove = useCallback(
    async (id: string) => {
      if (!window.confirm('删除该会话及全部消息？')) return
      try {
        await window.fairy.sessions.remove(id)
        if (id === currentRef.current) {
          const rest = sessions.filter((s) => s.id !== id) // 仍为降序
          if (rest.length > 0) {
            onSelect(rest[0].id)
          } else {
            const created = await window.fairy.sessions.create()
            onSelect(created.id)
          }
        }
        await refresh()
      } catch {
        // noop
      }
    },
    [sessions, onSelect, refresh]
  )

  return (
    <aside className="session-sidebar">
      <div className="sb-head">
        <span className="sb-title-head">会话</span>
        <button className="btn sb-new" onClick={() => void handleCreate()}>
          ＋ 新建会话
        </button>
      </div>
      <div className="session-list">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={s.id === currentId ? 'session-item active' : 'session-item'}
            onClick={() => onSelect(s.id)}
          >
            <span className="sb-title">{s.title.trim() || '新会话'}</span>
            <button
              className="sb-del"
              title="删除会话"
              onClick={(e) => {
                e.stopPropagation()
                void handleRemove(s.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
        {loaded && sessions.length === 0 && <div className="sb-empty">暂无会话</div>}
      </div>
    </aside>
  )
}
