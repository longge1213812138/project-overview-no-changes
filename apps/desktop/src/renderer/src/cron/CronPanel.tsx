import { useCallback, useEffect, useState } from 'react'
import type { CronRun, CronTask, CronToolOption } from '@fairy/core'

/**
 * 阶段 9 · 定时任务面板（DEV_PLAN 阶段 9 第 3 条：查看/暂停/恢复/编辑/删除入口；
 * 与日程提醒分开建模——日程是一次性提醒，这里是可重复触发的无人值守 Agent 任务）。
 * 数据来源 `window.fairy.cron`（契约见 packages/core/src/ipc.ts）。
 *
 * 权限模型（§5.2/§5.9，面板可见）：任务只用「预授权工具集」无人值守执行；
 * 越界/未预授权 → main 侧暂停任务并系统通知，面板展示暂停原因（绝不静默绕过审批）。
 */

/** 运行状态 → 徽章文案/样式 */
const RUN_LABEL: Record<CronRun['status'], { text: string; cls: string }> = {
  pending: { text: '待执行', cls: 'cron-badge-pending' },
  running: { text: '运行中', cls: 'cron-badge-running' },
  success: { text: '成功', cls: 'cron-badge-success' },
  failed: { text: '失败', cls: 'cron-badge-failed' },
  denied: { text: '超范围被拒', cls: 'cron-badge-denied' },
  missed: { text: '已错过', cls: 'cron-badge-missed' },
  skipped: { text: '并发跳过', cls: 'cron-badge-skipped' },
  interrupted: { text: '运行中断', cls: 'cron-badge-interrupted' }
}

const RISK_LABEL: Record<CronToolOption['risk'], string> = {
  read: '只读',
  write: '写入',
  exec: '执行'
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `M/D HH:MM`（本地时区展示；任务触发时区在任务行单独标注） */
function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface FormState {
  name: string
  prompt: string
  schedule: string
  timezone: string
  preauthorized: string[]
  catchup: boolean
  maxRetries: number
}

function defaultForm(): FormState {
  return {
    name: '',
    prompt: '',
    schedule: '0 9 * * *',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    preauthorized: [],
    catchup: true,
    maxRetries: 0
  }
}

export default function CronPanel() {
  const [tasks, setTasks] = useState<CronTask[]>([])
  const [tools, setTools] = useState<CronToolOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // 新建/编辑表单
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CronTask | null>(null)
  const [form, setForm] = useState<FormState>(defaultForm)
  const [submitting, setSubmitting] = useState(false)

  // 运行历史（展开行）
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [runs, setRuns] = useState<CronRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  const reload = useCallback(async () => {
    try {
      const result = await window.fairy.cron.list()
      setTasks(result.tasks)
      setTools(result.tools)
      setError(null)
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const reloadRuns = useCallback(async (taskId: string) => {
    setRunsLoading(true)
    try {
      setRuns(await window.fairy.cron.runs(taskId, 20))
    } catch (e) {
      setError(errText(e))
    } finally {
      setRunsLoading(false)
    }
  }, [])

  // 挂载拉取 + 订阅变更（触发/完成/暂停/编辑都会广播）；展开的历史同步刷新
  useEffect(() => {
    void reload()
    return window.fairy.cron.onChanged(() => {
      void reload()
      if (expandedId !== null) void reloadRuns(expandedId)
    })
  }, [reload, reloadRuns, expandedId])

  const runAction = async (
    id: string,
    action: () => Promise<{ ok?: boolean; error?: string } | void>
  ): Promise<void> => {
    setBusyId(id)
    setError(null)
    setNotice(null)
    try {
      const result = await action()
      if (result && result.ok === false) {
        setError(result.error ?? '操作失败')
      }
      await reload()
      if (expandedId !== null) await reloadRuns(expandedId)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  const openCreate = (): void => {
    setEditing(null)
    setForm(defaultForm())
    setFormOpen(true)
    setError(null)
  }

  const openEdit = (task: CronTask): void => {
    setEditing(task)
    setForm({
      name: task.name,
      prompt: task.prompt,
      schedule: task.schedule,
      timezone: task.timezone,
      preauthorized: [...task.preauthorized],
      catchup: task.catchup,
      maxRetries: task.maxRetries
    })
    setFormOpen(true)
    setError(null)
  }

  const submitForm = async (): Promise<void> => {
    if (submitting) return
    if (form.name.trim() === '' || form.prompt.trim() === '') {
      setError('请填写任务名称与任务指令')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const payload = {
        name: form.name.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule.trim(),
        timezone: form.timezone.trim(),
        preauthorized: form.preauthorized,
        catchup: form.catchup,
        maxRetries: form.maxRetries
      }
      const result =
        editing !== null
          ? await window.fairy.cron.update(editing.id, payload)
          : await window.fairy.cron.create(payload)
      if (!result.ok) {
        setError(result.error ?? '保存失败')
        return
      }
      setFormOpen(false)
      setEditing(null)
      setNotice(editing !== null ? `已保存「${payload.name}」` : `已创建「${payload.name}」`)
      await reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setSubmitting(false)
    }
  }

  const toggleExpand = (id: string): void => {
    if (expandedId === id) {
      setExpandedId(null)
      setRuns([])
      return
    }
    setExpandedId(id)
    void reloadRuns(id)
  }

  return (
    <div className="cron-panel">
      <div className="cron-toolbar">
        <div className="cron-toolbar-info">
          定时任务（cron）：无人值守自动执行；与「日程」的一次性提醒分开建模。
        </div>
        <button className="btn btn-primary" onClick={openCreate}>
          ＋ 新建任务
        </button>
      </div>

      {/* 新建 / 编辑表单 */}
      {formOpen && (
        <form
          className="cron-form"
          onSubmit={(e) => {
            e.preventDefault()
            void submitForm()
          }}
        >
          <div className="cron-form-title">{editing !== null ? `编辑任务「${editing.name}」` : '新建定时任务'}</div>
          <div className="cron-form-row">
            <input
              className="cron-input-name"
              placeholder="任务名称，如：晨间收件箱整理"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <input
              className="cron-input-schedule"
              placeholder="cron 表达式，如 0 9 * * 1-5"
              value={form.schedule}
              onChange={(e) => setForm({ ...form, schedule: e.target.value })}
              title="5 字段：分 时 日 月 周；支持 */n、a-b、逗号列表与 @daily 等宏"
            />
            <input
              className="cron-input-tz"
              placeholder="时区（IANA，如 Asia/Shanghai）"
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
            />
          </div>
          <div className="cron-form-row">
            <textarea
              className="cron-input-prompt"
              placeholder="任务指令：到达时间后交给 Agent 执行的内容，如「总结昨天的收件箱未读并给出三条行动建议」"
              rows={3}
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            />
          </div>
          <div className="cron-form-row cron-form-opts">
            <label className="cron-opt" title="停机期间错过的触发：开启=启动后补跑最近一次（更早的合并），关闭=记为「已错过」不补跑">
              <input
                type="checkbox"
                checked={form.catchup}
                onChange={(e) => setForm({ ...form, catchup: e.target.checked })}
              />
              错过触发时补跑一次
            </label>
            <label className="cron-opt">
              失败重试：
              <select
                value={form.maxRetries}
                onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })}
              >
                <option value={0}>不重试</option>
                <option value={1}>1 次</option>
                <option value={2}>2 次</option>
                <option value={3}>3 次</option>
              </select>
            </label>
          </div>

          {/* 预授权工具（无人值守只允许这些工具；越界永不授予） */}
          <div className="cron-form-block">
            <div className="cron-form-block-title">
              预授权工具<span className="cron-form-block-hint">（无人值守只允许下列工具，随时可撤销；越界操作一律暂停任务并通知）</span>
            </div>
            {tools.length === 0 ? (
              <div className="cron-form-no-tools">当前没有已注册的工具</div>
            ) : (
              <div className="cron-tool-grid">
                {tools.map((tool) => (
                  <label className="cron-tool" key={tool.name} title={tool.description}>
                    <input
                      type="checkbox"
                      checked={form.preauthorized.includes(tool.name)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          preauthorized: e.target.checked
                            ? [...form.preauthorized, tool.name]
                            : form.preauthorized.filter((n) => n !== tool.name)
                        })
                      }
                    />
                    <span className="cron-tool-name">{tool.name}</span>
                    <span className={`cron-risk cron-risk-${tool.risk}`}>{RISK_LABEL[tool.risk]}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="cron-form-row">
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? '保存中…' : editing !== null ? '保存修改' : '创建任务'}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setFormOpen(false)
                setEditing(null)
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}

      {error && <div className="banner banner-err">{error}</div>}
      {notice && <div className="banner">{notice}</div>}

      {loading && tasks.length === 0 ? (
        <div className="cal-loading">任务加载中…</div>
      ) : tasks.length === 0 ? (
        <div className="cal-empty">
          <div>还没有定时任务</div>
          <div className="cal-empty-hint">
            定时任务会按 cron 计划无人值守执行；只使用你预授权的工具，超范围操作会暂停并通知你。
          </div>
        </div>
      ) : (
        <div className="cron-list">
          {tasks.map((task) => {
            const paused = task.status === 'paused'
            return (
              <div className={paused ? 'cron-row cron-row-paused' : 'cron-row'} key={task.id}>
                <div className="cron-row-main">
                  <div className="cron-row-head">
                    <span className="cron-name">{task.name}</span>
                    <span className={paused ? 'cron-badge cron-badge-paused' : 'cron-badge cron-badge-active'}>
                      {paused ? '已暂停' : '运行中'}
                    </span>
                    {task.consecutiveFailures > 0 && !paused && (
                      <span className="cron-badge cron-badge-failed" title="连续失败计数（达上限自动暂停）">
                        连续失败 {task.consecutiveFailures}
                      </span>
                    )}
                  </div>
                  <div className="cron-schedule">
                    <code>{task.schedule}</code>
                    <span className="cron-tz">{task.timezone}</span>
                    <span className="cron-next">
                      下次：{task.nextRunAt !== null && task.status === 'active' ? fmtTime(task.nextRunAt) : '—'}
                    </span>
                    <span className="cron-catchup" title="停机错过是否补跑">
                      {task.catchup ? '错过补跑' : '错过不补'}
                    </span>
                    {task.maxRetries > 0 && <span className="cron-catchup">重试 {task.maxRetries} 次</span>}
                  </div>
                  <div className="cron-prompt">{task.prompt}</div>
                  <div className="cron-preauth">
                    预授权：
                    {task.preauthorized.length === 0
                      ? '无（任务不会调用任何工具）'
                      : task.preauthorized.map((n) => (
                          <code className="cron-preauth-chip" key={n}>
                            {n}
                          </code>
                        ))}
                  </div>
                  {paused && task.pauseReason && (
                    <div className="cron-pause-reason">⏸ 暂停原因：{task.pauseReason}</div>
                  )}
                </div>

                <div className="cron-actions">
                  <button
                    className="btn"
                    disabled={busyId === task.id}
                    onClick={() =>
                      void runAction(task.id, () =>
                        window.fairy.cron.setEnabled(task.id, task.status === 'paused')
                      )
                    }
                  >
                    {paused ? '恢复' : '暂停'}
                  </button>
                  <button
                    className="btn"
                    disabled={busyId === task.id || paused}
                    title={paused ? '恢复后才能运行' : '立即运行一次（同样走预授权策略）'}
                    onClick={() => void runAction(task.id, () => window.fairy.cron.trigger(task.id))}
                  >
                    立即运行
                  </button>
                  <button className="btn" disabled={busyId === task.id} onClick={() => openEdit(task)}>
                    编辑
                  </button>
                  <button
                    className="btn cron-del"
                    disabled={busyId === task.id}
                    onClick={() => {
                      if (!window.confirm(`确定删除定时任务「${task.name}」？运行历史会一并删除。`)) return
                      void runAction(task.id, async () => {
                        await window.fairy.cron.remove(task.id)
                      })
                    }}
                  >
                    删除
                  </button>
                  <button className="btn btn-link" onClick={() => toggleExpand(task.id)}>
                    {expandedId === task.id ? '收起历史' : '运行历史'}
                  </button>
                </div>

                {expandedId === task.id && (
                  <div className="cron-runs">
                    <div className="cron-runs-title">运行历史（最近 20 条）</div>
                    {runsLoading && runs.length === 0 ? (
                      <div className="cal-loading">加载中…</div>
                    ) : runs.length === 0 ? (
                      <div className="cron-runs-empty">尚无运行记录</div>
                    ) : (
                      runs.map((run) => {
                        const meta = RUN_LABEL[run.status]
                        const elapsed =
                          run.startedAt !== null && run.finishedAt !== null
                            ? `${Math.round((run.finishedAt - run.startedAt) / 100) / 10}s`
                            : null
                        return (
                          <div className="cron-run" key={run.id}>
                            <div className="cron-run-head">
                              <span className={`cron-badge ${meta.cls}`}>{meta.text}</span>
                              <span className="cron-run-time">
                                计划 {fmtTime(run.scheduledFor)}
                                {run.manual ? '（手动）' : ''}
                              </span>
                              {run.attempt > 0 && <span className="cron-run-attempt">第 {run.attempt + 1} 次尝试</span>}
                              {elapsed !== null && <span className="cron-run-elapsed">{elapsed}</span>}
                            </div>
                            {run.error && <div className="cron-run-error">{run.error}</div>}
                            {run.output && <pre className="cron-run-output">{run.output}</pre>}
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
