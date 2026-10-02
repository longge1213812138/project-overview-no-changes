import { useCallback, useEffect, useState } from 'react'
import type { EventListFilter, EventRecord, ScheduleScope } from '@fairy/core'

/**
 * 阶段 5 · 日程面板（docs/DEV_PLAN.md §5.3 + 阶段 5 第 3 条）：
 * 今天/明天/全部 列表、勾选完成、手动增删（与对话意图写同一张 events 表，数据实时一致）。
 * 过期未完成只展示「已过期」徽章不补弹（§8）。数据来源：`window.fairy.events`
 * （契约见 packages/core/src/ipc.ts；today/tomorrow/all 对应 ScheduleScope）。
 */

/** 面板只暴露三个 scope（ScheduleScope 另有 'week'，供意图 schedule_query 用） */
type Scope = Extract<ScheduleScope, 'today' | 'tomorrow' | 'all'>

const SCOPES: { key: Scope; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'tomorrow', label: '明天' },
  { key: 'all', label: '全部' }
]

/** 单次拉取上限，防止日程量大时列表过长 */
const LIST_LIMIT = 500

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 时间列：`M/D HH:MM` */
function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对标签：今天/明天/昨天/日期（跨年带年份），按本地日历日计算 */
function dayLabel(ms: number, now: number): string {
  const d = new Date(ms)
  const n = new Date(now)
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOf(d) - startOf(n)) / 86_400_000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '明天'
  if (diffDays === -1) return '昨天'
  return d.getFullYear() === n.getFullYear()
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** datetime-local 值：本地格式 `YYYY-MM-DDTHH:mm`（now + 1h 作新增默认值） */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function CalendarPanel() {
  // ===== 列表数据 =====
  const [scope, setScope] = useState<Scope>('today')
  const [events, setEvents] = useState<EventRecord[]>([])
  const [loading, setLoading] = useState(true)

  // ===== 提示条 / pending 防重 =====
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [addBusy, setAddBusy] = useState(false)

  // ===== 手动新增表单 =====
  const [title, setTitle] = useState('')
  const [remindAtInput, setRemindAtInput] = useState(() => toLocalInput(Date.now() + 3_600_000))
  const [notes, setNotes] = useState('')

  // now：30s 一跳，跨天/过期徽章不刷新页面也会更新
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const filter: EventListFilter = { scope, includeDone: true, limit: LIST_LIMIT }
      const list = await window.fairy.events.list(filter)
      // 契约未承诺顺序，前端兜底：未完成在前，再按 remindAt 升序
      setEvents(
        [...list].sort((a, b) =>
          a.done === b.done ? a.remindAt - b.remindAt || a.id - b.id : a.done ? 1 : -1
        )
      )
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [scope])

  // 挂载/scope 变化 → 拉列表；订阅事件变更（意图/通知轮询/面板操作广播）→ 重新拉取
  useEffect(() => {
    void reload()
    return window.fairy.events.onChanged(() => {
      void reload()
    })
  }, [reload])

  // ===== 勾选完成 / 取消完成 =====
  const handleToggle = async (rec: EventRecord) => {
    if (busyId !== null || addBusy) return
    setBusyId(rec.id)
    setError(null)
    try {
      await window.fairy.events.complete(rec.id, !rec.done)
      void reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  // ===== 删除（hover 显示按钮，confirm 二次确认） =====
  const handleRemove = async (rec: EventRecord) => {
    if (busyId !== null || addBusy) return
    if (!window.confirm(`确定删除日程「${rec.title}」？`)) return
    setBusyId(rec.id)
    setError(null)
    try {
      await window.fairy.events.remove(rec.id)
      void reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  // ===== 手动新增 =====
  const handleAdd = async () => {
    if (addBusy) return
    const t = title.trim()
    if (!t) {
      setError('请填写标题')
      return
    }
    // datetime-local 值（YYYY-MM-DDTHH:mm）按本地时区解析
    const ms = Date.parse(remindAtInput)
    if (!remindAtInput || !Number.isFinite(ms)) {
      setError('请选择有效的提醒时间')
      return
    }
    setAddBusy(true)
    setError(null)
    try {
      await window.fairy.events.add({ title: t, remindAt: ms, notes: notes.trim() || undefined })
      setTitle('')
      setNotes('')
      setRemindAtInput(toLocalInput(Date.now() + 3_600_000))
      void reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setAddBusy(false)
    }
  }

  return (
    <div className="calendar-panel">
      {/* 工具栏：scope 切换 */}
      <div className="calendar-toolbar">
        <div className="cal-scope-group">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              className={scope === s.key ? 'btn cal-scope active' : 'btn cal-scope'}
              onClick={() => setScope(s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* 手动新增（顶部固定表单） */}
      <form
        className="cal-form"
        onSubmit={(e) => {
          e.preventDefault()
          void handleAdd()
        }}
      >
        <div className="cal-form-row">
          <input
            className="cal-input-title"
            placeholder="标题，如：交周报"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            className="cal-input-time"
            type="datetime-local"
            value={remindAtInput}
            onChange={(e) => setRemindAtInput(e.target.value)}
          />
        </div>
        <div className="cal-form-row">
          <input
            className="cal-input-notes"
            placeholder="备注（可选）"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={addBusy}>
            {addBusy ? '添加中…' : '添加'}
          </button>
        </div>
      </form>

      {error && <div className="banner banner-err">{error}</div>}

      {loading && events.length === 0 ? (
        <div className="cal-loading">日程加载中…</div>
      ) : events.length === 0 ? (
        <div className="cal-empty">
          <div>{scope === 'today' ? '今天没有日程' : '该时间窗没有日程'}</div>
          <div className="cal-empty-hint">
            可以在对话里说「明天上午十点提醒我…」，或在上方手动添加。
          </div>
        </div>
      ) : (
        <div className="cal-list">
          {events.map((rec) => {
            // §8：过期且未完成 → 仅展示「已过期」，不补弹；fired 不单独出徽章
            const overdue = !rec.done && rec.remindAt < now
            return (
              <div className={rec.done ? 'cal-row cal-row-done' : 'cal-row'} key={rec.id}>
                <input
                  className="cal-check"
                  type="checkbox"
                  checked={rec.done}
                  disabled={busyId !== null || addBusy}
                  title={rec.done ? '取消完成' : '标记完成'}
                  onChange={() => void handleToggle(rec)}
                />
                <div className="cal-time">
                  <div className="cal-time-abs">{fmtTime(rec.remindAt)}</div>
                  <div className="cal-time-rel">{dayLabel(rec.remindAt, now)}</div>
                </div>
                <div className="cal-main">
                  <div className="cal-title">{rec.title}</div>
                  {rec.notes ? <div className="cal-notes">{rec.notes}</div> : null}
                </div>
                {rec.done ? (
                  <span className="cal-badge cal-badge-done">已完成</span>
                ) : overdue ? (
                  <span className="cal-badge cal-badge-overdue">已过期</span>
                ) : null}
                <div className="cal-actions">
                  <button
                    className="btn cal-del"
                    onClick={() => void handleRemove(rec)}
                    disabled={busyId !== null || addBusy}
                  >
                    {busyId === rec.id ? '删除中…' : '删除'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
