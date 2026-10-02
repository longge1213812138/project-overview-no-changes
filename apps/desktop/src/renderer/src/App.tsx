import { APP_NAME, FAIRY_VERSION, QUICK_SESSION_ID } from '@fairy/core'
import { useCallback, useEffect, useState } from 'react'
import SettingsTab from './SettingsTab'
import CalendarPanel from './calendar/CalendarPanel'
import ChatPane from './chat/ChatPane'
import SessionSidebar from './chat/SessionSidebar'
import MemoryPanel from './memory/MemoryPanel'

/**
 * 阶段 3：主窗口 = 顶栏（logo + 版本）→ 中部内容区 → 底部 tab（聊天/日程/记忆/设置）。
 * 浮窗模式（?float=1，main/windows.ts 载入）= 仅聊天面板（快速会话 QUICK_SESSION_ID），
 * 无侧栏无 tab，底部一行快捷键提示（Esc 由 main 侧 before-input-event 处理）。
 */
type Tab = 'chat' | 'calendar' | 'memory' | 'settings'

const TABS: { key: Tab; label: string; phase: string }[] = [
  { key: 'chat', label: '聊天', phase: '阶段 3' },
  { key: 'calendar', label: '日程', phase: '阶段 5' },
  { key: 'memory', label: '记忆', phase: '阶段 4' },
  { key: 'settings', label: '设置', phase: '阶段 2' }
]

/** 浮窗判定：URL query `float=1`（main 侧 loadURL/loadFile 的 search 参数） */
const IS_FLOAT = new URLSearchParams(window.location.search).get('float') === '1'

function App() {
  return IS_FLOAT ? <FloatWindow /> : <MainWindow />
}

/** 浮窗：仅聊天面板 + 快捷键提示 */
function FloatWindow() {
  return (
    <div className="float-shell">
      <ChatPane sessionId={QUICK_SESSION_ID} float />
      <div className="float-hint">Alt+Space 呼出/隐藏 · Esc 关闭</div>
    </div>
  )
}

/** 主窗口：底部 tab 切换内容区 */
function MainWindow() {
  const [tab, setTab] = useState<Tab>('chat')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const handleSelect = useCallback((id: string) => setSessionId(id), [])

  // 点系统通知 → main 指定切到对应 tab（阶段 5 通知联动）；仅主窗口订阅，卸载退订
  useEffect(() => window.fairy.onOpenTab((key) => setTab(key)), [])

  return (
    <div className="shell">
      <header className="titlebar">
        <span className="logo">🧚 {APP_NAME}</span>
        <span className="version">v{FAIRY_VERSION} · 阶段 3</span>
      </header>

      <main className={tab === 'chat' ? 'content content-chat' : 'content'}>
        {tab === 'chat' && (
          <div className="chat-layout">
            <SessionSidebar currentId={sessionId} onSelect={handleSelect} />
            {sessionId !== null ? (
              <ChatPane key={sessionId} sessionId={sessionId} />
            ) : (
              <div className="placeholder">
                <h2>聊天</h2>
                <p>点击左侧「＋ 新建会话」开始对话。</p>
              </div>
            )}
          </div>
        )}
        {tab === 'calendar' && <CalendarPanel />}
        {tab === 'memory' && <MemoryPanel />}
        {tab === 'settings' && <SettingsTab />}
      </main>

      <nav className="tabbar">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? 'tab active' : 'tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}

export default App
