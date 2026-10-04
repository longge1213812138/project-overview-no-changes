/**
 * 阶段 9：cron 定时引擎驱动（main 进程侧，DEV_PLAN §5.9 + §6 阶段 9）。
 *
 * 职责划分：触发计算/状态机在 @fairy/core 的 agent/cron（纯逻辑可单测）；
 * 本文件只做编排——恢复、tick、串行执行、通道门控、超范围暂停通知、IPC 面。
 *
 * 已确认语义（验收对照）：
 * - **幂等**：claim 以 (task_id, scheduled_for) 为唯一键，重复触发/tick 竞态只执行一次；
 * - **并发**：同任务上一轮未结束 → 新触发记 skipped；全局串行队列（一次只跑一个任务）；
 * - **重启恢复**：启动先收敛 running→interrupted（执行中退出不伪装成功），再按任务 catchup
 *   补跑最近一次错过（或记 missed），陈旧 pending 按 catchup 执行或记 missed；
 * - **错过合并**：停机窗口内的多次错过只补最近一次（不补一长串）；
 * - **无人值守权限**：只暴露预授权工具，越界/未预授权 → 拒绝 + **暂停任务并通知**（不绕过审批）；
 * - **通道门控**：仅 API 通道执行（阶段 7 范围决定）；不可用 → 暂停 + 通知（原因可见）；
 * - **失败策略**：失败按任务 maxRetries 重试（指数退避）；重试耗尽计入连续失败，
 *   达 failure_limit → 自动暂停 + 通知。
 *
 * 依赖单向：cron → agent-tools/channel/windows/logger（均不回 import cron）。
 */
import { app, Notification } from 'electron'
import { join } from 'node:path'
import {
  IPC,
  buildCronMessages,
  createCronAuthorizer,
  createCronStore,
  planRecovery,
  planTrigger,
  runAgent,
  truncateCronOutput
} from '@fairy/core'
import type {
  CronActionResult,
  CronCreateInput,
  CronEscalation,
  CronListResult,
  CronRun,
  CronStore,
  CronTask,
  CronToolOption,
  CronUpdateInput
} from '@fairy/core'
import { getToolRegistry, probeToolsSupportCached } from './agent-tools'
import { resolveActiveChannel } from './channel'
import { broadcast, showMainWindow } from './windows'
import { log } from './logger'

/** tick 间隔：分钟粒度的表达式 + 10s 误差可接受（notify-loop 是 30s，此处更密） */
const TICK_MS = 10_000

let store: CronStore | null = null
let timer: NodeJS.Timeout | null = null
let initialized = false
/** 退出流程标记：执行中被中止 → interrupted（而非普通取消） */
let shuttingDown = false

/** 待执行运行 id 串行队列（全局一次一个，可观测、防 LLM/副作用并发风暴） */
const queue: number[] = []
let draining = false
let activeRun: { runId: number; controller: AbortController } | null = null

// ===== 存储（懒加载：IPC handler 可能先于 initCron 被 renderer 调用） =====

export function getCronStore(): CronStore {
  if (!store) {
    store = createCronStore({ dbPath: join(app.getPath('userData'), 'fairy.db') })
  }
  return store
}

// ===== 启动恢复 + tick =====

/** whenReady 调（initChat 之后），幂等 */
export function initCron(): void {
  if (initialized) return
  initialized = true
  try {
    recover()
  } catch (err) {
    log.warn('[cron] 启动恢复失败：', err instanceof Error ? err.message : err)
  }
  timer = setInterval(() => tick(), TICK_MS)
  timer.unref?.() // 不阻止退出（与 notify-loop/extract 同规则）
  void drain()
}

/** 退出时调（before-quit 最前）；同步、尽力而为 */
export function shutdownCron(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  shuttingDown = true
  activeRun?.controller.abort(new Error('应用退出，运行中断'))
  try {
    const n = store?.recoverInterruptedRuns('应用退出，运行中断')
    if (n !== undefined && n > 0) log.info(`[cron] 退出：${n} 条运行中标记为 interrupted`)
  } catch (err) {
    log.warn('[cron] 退出收敛失败：', err instanceof Error ? err.message : err)
  }
}

/**
 * 启动恢复（DEV_PLAN 阶段 9 验收「重启恢复且避免重复执行」）：
 * ① running → interrupted（上次退出/崩溃遗留，绝不伪装成成功）；
 * ② 陈旧 pending：任务已删/已暂停 或 catchup 关闭 → 记 missed 不执行；
 * ③ active 任务按 planRecovery 决策：catchup 开 → 补跑最近一次错过；关 → 记 missed；
 *    next_run_at 一律推进到未来。
 */
function recover(): void {
  const s = getCronStore()
  const now = Date.now()
  const ALL = Number.MAX_SAFE_INTEGER // 取全部 pending（含未到重试点的）

  const interrupted = s.recoverInterruptedRuns('上次运行期间应用退出/崩溃，未完成')
  if (interrupted > 0) {
    log.info(`[cron] 恢复：${interrupted} 条运行中记录收敛为 interrupted`)
  }

  // ② 陈旧 pending（上次已 claim 未执行）：任务没了/暂停了/catchup 关 → missed；
  //    否则若已到执行/重试时间 → 入队（幂等键已占用，至多执行一次）
  for (const run of s.duePendingRuns(ALL)) {
    const task = s.getTask(run.taskId)
    if (!task) {
      s.markRunMissed(run.id, '任务已删除，未执行', now)
      continue
    }
    if (task.status !== 'active') {
      s.markRunMissed(run.id, '任务已暂停，未执行', now)
      continue
    }
    if (!task.catchup) {
      s.markRunMissed(run.id, '停机期间错过（任务未开启补跑）', now)
      log.info(`[cron] 恢复：run=${run.id} 任务「${task.name}」catchup 关闭 → missed`)
      continue
    }
    if (run.nextRetryAt === null || run.nextRetryAt <= now) enqueue(run.id)
  }

  // ③ 计划恢复；同任务已有 pending（② 入队的）则不再补 claim，避免同轮双执行
  const pendingTaskIds = new Set(s.duePendingRuns(ALL).map((r) => r.taskId))
  let changed = false
  for (const task of s.listTasks()) {
    if (task.status !== 'active') continue
    const plan = planRecovery(task, now)
    if (!plan) continue
    if (plan.missedAt !== null) {
      s.insertMissed(task.id, plan.missedAt, now, '停机期间错过（任务未开启补跑）')
      log.info(`[cron] 恢复：「${task.name}」错过 ${new Date(plan.missedAt).toISOString()} → missed（不补跑）`)
    }
    if (plan.claimAt !== null && !pendingTaskIds.has(task.id)) {
      const outcome = s.claim(task.id, plan.claimAt)
      if (outcome.claimed) {
        log.info(
          `[cron] 恢复：「${task.name}」补跑错过触发 ${new Date(plan.claimAt).toISOString()}（合并更早错过）`
        )
        enqueue(outcome.run.id)
      }
    }
    s.advance(task.id, plan.nextRunAt, plan.claimAt ?? task.lastFiredAt)
    changed = true
  }
  if (changed) broadcast(IPC.cronChanged)
}

/** 一轮 tick：到期计划 → claim+advance；到期 pending（重试/恢复）→ 入队 */
function tick(): void {
  let changed = false
  try {
    const s = getCronStore()
    const now = Date.now()

    for (const task of s.dueTasks(now)) {
      const plan = planTrigger(task, now)
      if (!plan) continue
      let claimedRun: CronRun | null = null
      if (plan.claimAt !== null) {
        const outcome = s.claim(task.id, plan.claimAt)
        if (outcome.claimed) {
          claimedRun = outcome.run
          log.info(
            `[cron] 触发：「${task.name}」计划时刻 ${new Date(plan.claimAt).toISOString()}（run=${outcome.run.id}）`
          )
          enqueue(outcome.run.id)
          changed = true
        } else {
          // duplicate（重复触发，幂等吞掉）/ busy（并发防护已记 skipped）
          log.info(`[cron] 触发跳过：「${task.name}」 reason=${outcome.reason}`)
        }
      }
      s.advance(task.id, plan.nextRunAt, claimedRun ? claimedRun.scheduledFor : task.lastFiredAt)
      changed = true
    }

    // 重试到期 / 恢复期遗留的 pending
    for (const run of s.duePendingRuns(now)) {
      if (!queue.includes(run.id) && activeRun?.runId !== run.id) {
        const task = s.getTask(run.taskId)
        if (task && task.status === 'active') enqueue(run.id)
      }
    }
  } catch (err) {
    log.warn('[cron] tick 失败：', err instanceof Error ? err.message : err)
  }
  if (changed) broadcast(IPC.cronChanged)
}

// ===== 串行执行队列 =====

function enqueue(runId: number): void {
  if (queue.includes(runId)) return
  queue.push(runId)
  void drain()
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    for (;;) {
      const runId = queue.shift()
      if (runId === undefined) break
      try {
        await executeRun(runId)
      } catch (err) {
        log.warn(`[cron] run=${runId} 执行异常：`, err instanceof Error ? err.message : err)
      }
    }
  } finally {
    draining = false
  }
}

/** 单个运行的完整生命周期（串行，故无同任务竞争；幂等键在 claim 期已定） */
async function executeRun(runId: number): Promise<void> {
  const s = getCronStore()
  const run = s.getRun(runId)
  if (!run || run.status !== 'pending') return // 已被恢复/暂停流程处理
  const task = s.getTask(run.taskId)
  if (!task) {
    s.markRunMissed(runId, '任务已删除，未执行')
    return
  }
  if (task.status !== 'active') {
    s.markRunMissed(runId, '任务已暂停，未执行')
    return
  }
  if (!s.startRun(runId)) return
  broadcast(IPC.cronChanged)
  log.info(
    `[cron] 开始：「${task.name}」run=${runId} scheduled=${new Date(run.scheduledFor).toISOString()}` +
      ` attempt=${run.attempt}${run.manual ? ' manual' : ''}`
  )

  const controller = new AbortController()
  activeRun = { runId, controller }
  const startedAt = Date.now()

  // 超范围升级：记录并立刻中止本轮（暂停+通知在收尾处统一处理）
  let escalated: CronEscalation | null = null

  try {
    // ===== 通道门控：仅 API 通道（阶段 7 范围决定；不可用/网页 → 暂停 + 通知） =====
    const resolved = resolveActiveChannel()
    if (!resolved.ok || resolved.channel !== 'api') {
      const reason = !resolved.ok
        ? `通道不可用：${resolved.error}`
        : '定时任务仅支持 OpenAI 兼容 API 通道（当前为 DeepSeek 网页通道）'
      s.pauseTask(task.id, reason)
      s.finishRun(runId, { status: 'failed', error: reason })
      log.warn(`[cron] 通道门控：「${task.name}」已暂停 —— ${reason}`)
      notifyPaused(task, reason)
      return
    }

    // ===== 只暴露预授权工具（未预授权的对模型不可见；授权链还有第二道校验） =====
    const registry = getToolRegistry()
    const toolNames = task.preauthorized.filter((name) => registry.get(name) !== undefined)
    const tools = toolNames.map((name) => registry.get(name)!.tool)

    let capabilityNote: string | undefined
    if (tools.length > 0) {
      const probe = await probeToolsSupportCached(resolved.client, resolved.capabilityKey, {
        signal: controller.signal
      })
      if (probe.support === 'unsupported') {
        capabilityNote = `当前 API 端点不支持工具调用（${probe.detail ?? '探测未通过'}），本轮未启用工具`
        tools.length = 0
        log.info('[cron]', capabilityNote)
      } else if (probe.support === 'unknown') {
        capabilityNote = `工具能力探测未知（${probe.detail ?? '无详情'}），本轮带工具尝试`
      }
    }

    const authorize = createCronAuthorizer(registry, {
      preauthorized: toolNames,
      onEscalation: (escalation) => {
        escalated = escalation
        log.warn(`[cron] 超范围升级：「${task.name}」${escalation.kind} ${escalation.reason}`)
        controller.abort(new Error(escalation.reason)) // 立即中止，不继续无人值守执行
      }
    })

    const messages = buildCronMessages(task, {
      now: Date.now(),
      toolNames,
      ...(capabilityNote !== undefined ? { capabilityNote } : {})
    })

    const result = await runAgent(resolved.client, messages, tools, undefined, {
      signal: controller.signal,
      authorize,
      onToolEvent: (e) => log.info('[cron:tool]', { task: task.name, runId, ...e })
    })

    const output = truncateCronOutput(result.content.trim() || '（模型无文本输出）')
    s.finishRun(runId, { status: 'success', output })
    s.recordSuccess(task.id)
    log.info(`[cron] 成功：「${task.name}」run=${runId} 耗时 ${Date.now() - startedAt}ms`)
  } catch (err) {
    handleRunError(runId, task, err, escalated, controller.signal)
  } finally {
    activeRun = null
    broadcast(IPC.cronChanged)
  }
}

/** 失败分类：超范围 → denied+暂停通知；退出中断 → interrupted；其余 → 重试或失败计数 */
function handleRunError(
  runId: number,
  task: CronTask,
  err: unknown,
  escalated: CronEscalation | null,
  signal: AbortSignal
): void {
  const s = getCronStore()
  const message = err instanceof Error ? err.message : String(err)

  // ① 超范围（未预授权/越界）：该次运行 denied + **暂停任务并通知**（§5.9 不绕过审批）
  if (escalated) {
    s.finishRun(runId, { status: 'denied', error: escalated.reason })
    s.pauseTask(task.id, escalated.reason)
    log.warn(`[cron] 拒绝并暂停：「${task.name}」run=${runId} ${escalated.reason}`)
    notifyPaused(task, escalated.reason)
    return
  }

  // ② 应用退出中止：interrupted（shutdown 已同步收敛过，finishRun 守卫保证不覆盖）
  if (shuttingDown || signal.aborted) {
    const applied = s.finishRun(runId, { status: 'interrupted', error: '应用退出，运行中断' })
    if (applied) log.info(`[cron] 中断：「${task.name}」run=${runId}（应用退出）`)
    return
  }

  // ③ 常规失败：先按 maxRetries 重试（指数退避）；重试耗尽才计入连续失败
  const run = s.getRun(runId)
  const attempt = run?.attempt ?? 0
  if (attempt < task.maxRetries) {
    const delay = task.retryBackoffMs * 2 ** attempt
    if (s.retryRun(runId, Date.now() + delay)) {
      log.warn(
        `[cron] 失败重试：「${task.name}」run=${runId} attempt=${attempt + 1}/${task.maxRetries}，${delay}ms 后 —— ${message}`
      )
      return
    }
  }

  s.finishRun(runId, { status: 'failed', error: message })
  const failure = s.recordFailure(
    task.id,
    `连续失败达上限（${task.failureLimit} 次）：${message}`
  )
  if (failure.paused) {
    const reason = `连续失败达上限（${task.failureLimit} 次）：${message}`
    s.pauseTask(task.id, reason)
    log.warn(`[cron] 连续失败暂停：「${task.name}」${reason}`)
    notifyPaused(task, reason)
  } else {
    log.warn(`[cron] 失败：「${task.name}」run=${runId}（连续 ${failure.consecutiveFailures} 次）—— ${message}`)
  }
}

// ===== 暂停通知（点击 → 主窗口切定时任务 tab） =====

function notifyPaused(task: CronTask, reason: string): void {
  try {
    const notification = new Notification({
      title: `⏸ 定时任务已暂停：${task.name}`,
      body: reason
    })
    notification.on('click', () => {
      showMainWindow()
      broadcast(IPC.appOpenTab, { tab: 'cron' })
    })
    notification.show()
  } catch (err) {
    log.warn('[cron] 暂停通知失败：', err instanceof Error ? err.message : err)
  }
}

// ===== IPC 面（main/ipc.ts handler 直调；变更统一在此广播 cronChanged） =====

export function listCron(): CronListResult {
  let tools: CronToolOption[] = []
  try {
    tools = getToolRegistry()
      .list()
      .map((r) => ({
        name: r.tool.definition.function.name,
        description: r.tool.definition.function.description ?? '',
        risk: r.risk,
        source: r.source
      }))
  } catch {
    tools = [] // 注册表未初始化（不应发生：initChat 先于 renderer 调用）
  }
  return { tasks: getCronStore().listTasks(), tools }
}

export function listCronRuns(taskId: string, limit?: number): CronRun[] {
  return getCronStore().listRuns(taskId, limit)
}

export function createCronTask(input: CronCreateInput): CronActionResult {
  try {
    const task = getCronStore().createTask(input)
    log.info(`[cron] 创建：「${task.name}」${task.schedule} (${task.timezone}) next=${task.nextRunAt}`)
    broadcast(IPC.cronChanged)
    return { ok: true, task }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function updateCronTask(id: string, patch: CronUpdateInput): CronActionResult {
  try {
    const task = getCronStore().updateTask(id, patch)
    log.info(`[cron] 编辑：「${task.name}」`)
    broadcast(IPC.cronChanged)
    return { ok: true, task }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function setCronEnabled(id: string, enabled: boolean): CronActionResult {
  try {
    const task = getCronStore().setTaskEnabled(id, enabled)
    log.info(`[cron] ${enabled ? '恢复' : '暂停'}：「${task.name}」`)
    broadcast(IPC.cronChanged)
    return { ok: true, task }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function removeCronTask(id: string): void {
  const removed = getCronStore().removeTask(id)
  if (!removed) throw new Error(`定时任务不存在：${id}`)
  log.info(`[cron] 删除：${id}`)
  broadcast(IPC.cronChanged)
}

/** 手动「立即运行」：与计划触发同一幂等/预授权/暂停策略 */
export function triggerCronTask(id: string): CronActionResult {
  try {
    const s = getCronStore()
    const task = s.getTask(id)
    if (!task) return { ok: false, error: `定时任务不存在：${id}` }
    if (task.status === 'paused') {
      return { ok: false, error: '任务已暂停，请先恢复再运行' }
    }
    const outcome = s.claimManual(id)
    if (!outcome.claimed) {
      return {
        ok: false,
        error: outcome.reason === 'busy' ? '任务上一轮仍在运行中' : '触发冲突，请稍后重试'
      }
    }
    log.info(`[cron] 手动触发：「${task.name}」run=${outcome.run.id}`)
    enqueue(outcome.run.id)
    broadcast(IPC.cronChanged)
    return { ok: true, task }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
