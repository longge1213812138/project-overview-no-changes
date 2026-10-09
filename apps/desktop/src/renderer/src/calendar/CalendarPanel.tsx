import { useEffect, useMemo, useState } from 'react'
import type { EventRecord, FairyClient, Feedback, ScheduleScope } from '@fairy/core'
import { defaultFairyClient } from '../ipc/fairyClient'
import { useAction } from '../ipc/useAction'
import { useResource } from '../ipc/useResource'

/**
 * 阶段 5 · 日程面板（docs/DEV_PLAN.md §5.3 + 阶段 5 第 3 条）：
 * 今天/明天/全部 列表、勾选完成、手动增删（与对话意图写同一张 events 表，数据实时一致）。
 * 过期未完成只展示「已过期」徽章不补弹（§8）。
 *
 * 数据与写操作经 Fairy client（ADR-0001）：取数与订阅交 `useResource`，
 * 写操作与忙碌态/反馈交 `useAction`；本组件只留展示与日程自己的规则
 * （scope 过滤、列表排序、跨天时钟、新增表单校验）。
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

/** 契约未承诺顺序，展示层兜底：未完成在前，再按 remindAt 升序 */
function sortEvents(list: EventRecord[]): EventRecord[] {
  return [...list].sort((a, b) =>
    a.done === b.done ? a.remindAt - b.remindAt || a.id - b.id : a.done ? 1 : -1
  )
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

/** 按日程 id 的忙碌槽位（同一面板里多行各自的忙碌态） */
const rowKey = (id: number) => `event:${id}`

export interface CalendarPanelProps {
  /** 数据源；默认取 preload 暴露的 `window.fairy`。测试传替身。 */
  client?: FairyClient
}

export default function CalendarPanel({ client = defaultFairyClient() }: CalendarPanelProps = {}) {
  const [scope, setScope] = useState<Scope>('today')

  // ===== 手动新增表单 =====
  const [title, setTitle] = useState('')
  const [remindAtInput, setRemindAtInput] = useState(() => toLocalInput(Date.now() + 3_600_000))
  const [notes, setNotes] = useState('')

  const resource = useResource(
    (c) => c.events.list({ scope, includeDone: true, limit: LIST_LIMIT }),
    (c, refresh) => c.events.onChanged(refresh),
    [scope],
    client
  )
  const action = useAction(client)

  const list = useMemo(() => sortEvents(resource.data ?? []), [resource.data])
  /** 任一写操作进行中 → 行内与新增按钮一同禁用（与原行为一致：同一时刻只做一个写操作） */
  const anyBusy = action.busy('add') || list.some((rec) => action.busy(rowKey(rec.id)))

  /** 反馈条：最近一次 Action 的结论优先，其次资源读取失败 */
  const notice: Feedback | null =
    action.feedback ?? (resource.error !== null ? { kind: 'err', text: resource.error } : null)

  // now：30s 一跳，跨天/过期徽章不刷新页面也会更新
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])

  // ===== 勾选完成 / 取消完成 =====
  const handleToggle = (rec: EventRecord) => {
    if (anyBusy) return
    void action.run(rowKey(rec.id), (c) => c.events.complete(rec.id, !rec.done), {
      onSuccess: resource.refresh
    })
  }

  // ===== 删除（hover 显示按钮，confirm 二次确认） =====
  const handleRemove = (rec: EventRecord) => {
    if (anyBusy) return
    if (!window.confirm(`确定删除日程「${rec.title}」？`)) return
    void action.run(rowKey(rec.id), (c) => c.events.remove(rec.id), {
      onSuccess: resource.refresh
    })
  }

  // ===== 手动新增 =====
  const handleAdd = () => {
    if (anyBusy) return
    const text = title.trim()
    if (!text) {
      action.fail('请填写标题')
      return
    }
    // datetime-local 值（YYYY-MM-DDTHH:mm）按本地时区解析
    const ms = Date.parse(remindAtInput)
    if (!remindAtInput || !Number.isFinite(ms)) {
      action.fail('请选择有效的提醒时间')
      return
    }
    void action.run(
      'add',
      (c) => c.events.add({ title: text, remindAt: ms, notes: notes.trim() || undefined }),
      {
        onSuccess: () => {
          setTitle('')
          setNotes('')
          setRemindAtInput(toLocalInput(Date.now() + 3_600_000))
          return resource.refresh()
        }
      }
    )
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
          handleAdd()
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
          <button className="btn btn-primary" type="submit" disabled={anyBusy}>
            {action.busy('add') ? '添加中…' : '添加'}
          </button>
        </div>
      </form>

      {notice && (
        <div className={notice.kind === 'ok' ? 'banner banner-ok' : 'banner banner-err'}>
          {notice.text}
        </div>
      )}

      {resource.loading && list.length === 0 ? (
        <div className="cal-loading">日程加载中…</div>
      ) : list.length === 0 ? (
        <div className="cal-empty">
          <div>{scope === 'today' ? '今天没有日程' : '该时间窗没有日程'}</div>
          <div className="cal-empty-hint">
            可以在对话里说「明天上午十点提醒我…」，或在上方手动添加。
          </div>
        </div>
      ) : (
        <div className="cal-list">
          {list.map((rec) => {
            // §8：过期且未完成 → 仅展示「已过期」，不补弹；fired 不单独出徽章
            const overdue = !rec.done && rec.remindAt < now
            return (
              <div className={rec.done ? 'cal-row cal-row-done' : 'cal-row'} key={rec.id}>
                <input
                  className="cal-check"
                  type="checkbox"
                  checked={rec.done}
                  disabled={anyBusy}
                  title={rec.done ? '取消完成' : '标记完成'}
                  onChange={() => handleToggle(rec)}
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
                    onClick={() => handleRemove(rec)}
                    disabled={anyBusy}
                  >
                    {action.busy(rowKey(rec.id)) ? '删除中…' : '删除'}
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
