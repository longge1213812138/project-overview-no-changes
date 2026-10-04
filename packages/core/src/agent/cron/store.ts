/**
 * 阶段 9：cron 任务与执行历史的 SQLite 持久化（DEV_PLAN §5.9 任务 1/2）。
 *
 * 表结构 = 迁移 v4（store/index.ts：cron_tasks / cron_runs）。要点：
 * - **幂等键**：cron_runs UNIQUE(task_id, scheduled_for)——重复触发、重启恢复、
 *   tick 竞态对同一计划时刻只会 claim 一次（at-most-once，验收「重复触发无重复副作用」）；
 * - **并发防护**：claim 时同任务已有 running → 插入 skipped 行（可见）并拒绝 claim；
 * - **调度状态持久化**：next_run_at / last_fired_at 落库，重启恢复不依赖内存；
 * - **状态迁移一律带 WHERE 守卫**（running → finished 只允许一次），防止迟到的完成回调
 *   覆盖 shutdown/recovery 已写入的 interrupted；
 * - 失败策略：consecutive_failures 达 failure_limit → status=paused + pause_reason（可恢复）。
 *
 * 本层只管数据与状态机；触发计算在 schedule.ts，执行编排在 main/cron.ts。
 */
import type { Database as Db } from 'better-sqlite3';
import type { CronCreateInput, CronRun, CronTask, CronUpdateInput } from '../../ipc';
import { openDatabase } from '../../store';
import { CronScheduleError, isValidTimezone, nextOccurrence, parseCron, systemTimezone, validateSchedule } from './schedule';

export type ClaimReason = 'busy' | 'duplicate';

export type ClaimOutcome =
  | { claimed: true; run: CronRun }
  | { claimed: false; reason: ClaimReason };

export interface CronStore {
  listTasks(): CronTask[];
  getTask(id: string): CronTask | null;
  /** 校验（表达式/时区/字段范围）+ 计算首次触发；失败抛 CronScheduleError */
  createTask(input: CronCreateInput): CronTask;
  /** 局部编辑；改表达式/时区重算 nextRunAt；任何编辑重置连续失败计数 */
  updateTask(id: string, patch: CronUpdateInput): CronTask;
  /** 暂停/恢复（恢复 = 重算下次触发 + 清空失败计数与暂停原因） */
  setTaskEnabled(id: string, enabled: boolean): CronTask;
  /** 无人值守策略触发的暂停（超范围/连续失败/通道门控），带可见原因 */
  pauseTask(id: string, reason: string): void;
  removeTask(id: string): boolean;

  /** 到期任务（active 且 next_run_at <= now） */
  dueTasks(now?: number): CronTask[];
  /**
   * 幂等 claim：插入 pending 行（UNIQUE(task_id, scheduled_for) 冲突 = duplicate）；
   * 同任务已有 running → 插入 skipped 行并返回 busy（并发防护可见）。
   */
  claim(taskId: string, scheduledFor: number, options?: { manual?: boolean }): ClaimOutcome;
  /** 手动「立即运行」：以 now 为基准找未被占用的 scheduled_for（+1ms 递增，≤100 次） */
  claimManual(taskId: string, now?: number): ClaimOutcome;
  /** claim 后推进调度状态（next_run_at + last_fired_at） */
  advance(taskId: string, nextRunAt: number | null, lastFiredAt: number | null): void;
  /** 记录一次 missed（catchup 关闭的恢复场景；INSERT OR IGNORE 防重复） */
  insertMissed(taskId: string, scheduledFor: number, now: number, reason: string): void;

  /** 到期待执行（pending 且重试时间已到）：含启动恢复的陈旧 pending */
  duePendingRuns(now?: number): CronRun[];
  /** pending → running（带守卫；已被恢复流程处理过则返回 false） */
  startRun(runId: number, now?: number): boolean;
  /** running → 终态（带守卫，只允许兑现一次） */
  finishRun(
    runId: number,
    result: { status: 'success' | 'failed' | 'denied' | 'interrupted'; output?: string; error?: string },
    now?: number
  ): boolean;
  /** running → pending（下轮重试，attempt+1；带守卫） */
  retryRun(runId: number, nextRetryAt: number): boolean;
  /** pending → missed（启动恢复时 catchup 关闭；带守卫） */
  markRunMissed(runId: number, reason: string, now?: number): boolean;
  /** 启动/退出：running → interrupted（执行中退出不伪装成成功/失败），返回处理条数 */
  recoverInterruptedRuns(reason: string, now?: number): number;

  listRuns(taskId: string, limit?: number): CronRun[];
  lastRun(taskId: string): CronRun | null;
  /** 按 id 取单条运行（main 驱动执行时用） */
  getRun(id: number): CronRun | null;

  /** 成功 → 连续失败清零 */
  recordSuccess(taskId: string): void;
  /** 失败 +1；达 failure_limit → 自动暂停并写 pause_reason，返回结果供 main 通知 */
  recordFailure(taskId: string, reason: string): { consecutiveFailures: number; paused: boolean };

  /** 关闭底层句柄（测试/退出用） */
  close(): void;
}

export class CronStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronStoreError';
  }
}

// ===== 校验（IPC 边界不信任 renderer；这里统一兜底） =====

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RETRIES_LIMIT = 3;
const FAILURE_LIMIT_MIN = 1;
const FAILURE_LIMIT_MAX = 10;

function requireText(value: unknown, label: string, maxLen: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CronStoreError(`${label} 必须为非空字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLen) {
    throw new CronStoreError(`${label} 超过最大长度（${maxLen}）`);
  }
  return trimmed;
}

function normalizePreauthorized(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CronStoreError('preauthorized 必须是工具名数组');
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !TOOL_NAME_PATTERN.test(item)) {
      throw new CronStoreError(`预授权工具名非法：${String(item)}`);
    }
    seen.add(item);
  }
  return [...seen];
}

function normalizeCount(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new CronStoreError(`${label} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

// ===== 行 → DTO =====

interface CronTaskRow {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  timezone: string;
  status: string;
  preauthorized: string;
  catchup: number;
  max_retries: number;
  retry_backoff_ms: number;
  failure_limit: number;
  consecutive_failures: number;
  pause_reason: string | null;
  last_fired_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface CronRunRow {
  id: number;
  task_id: string;
  scheduled_for: number;
  attempt: number;
  manual: number;
  status: string;
  next_retry_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  output: string | null;
  error: string | null;
  created_at: number;
}

function toTask(row: CronTaskRow): CronTask {
  let preauthorized: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.preauthorized);
    if (Array.isArray(parsed)) preauthorized = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    preauthorized = []; // 损坏即收窄为「无预授权」（更安全，不放大权限）
  }
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    timezone: row.timezone,
    status: row.status === 'paused' ? 'paused' : 'active',
    preauthorized,
    catchup: row.catchup !== 0,
    maxRetries: row.max_retries,
    retryBackoffMs: row.retry_backoff_ms,
    failureLimit: row.failure_limit,
    consecutiveFailures: row.consecutive_failures,
    pauseReason: row.pause_reason,
    lastFiredAt: row.last_fired_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toRun(row: CronRunRow): CronRun {
  return {
    id: row.id,
    taskId: row.task_id,
    scheduledFor: row.scheduled_for,
    attempt: row.attempt,
    manual: row.manual !== 0,
    status: row.status as CronRun['status'],
    nextRetryAt: row.next_retry_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    output: row.output,
    error: row.error,
    createdAt: row.created_at
  };
}

const openDbs = new WeakMap<CronStore, Db>();

export function closeCronStore(store: CronStore): void {
  const db = openDbs.get(store);
  if (db && db.open) db.close();
}

export function createCronStore(opts: { dbPath: string }): CronStore {
  const db = openDatabase(opts.dbPath);

  const getTaskRow = (id: string): CronTaskRow | null =>
    (db.prepare('SELECT * FROM cron_tasks WHERE id = ?').get(id) as CronTaskRow | undefined) ?? null;

  const requireRow = (id: string): CronTaskRow => {
    const row = getTaskRow(id);
    if (!row) throw new CronStoreError(`定时任务不存在：${id}`);
    return row;
  };

  const store: CronStore = {
    listTasks() {
      const rows = db
        .prepare('SELECT * FROM cron_tasks ORDER BY created_at ASC, id ASC')
        .all() as CronTaskRow[];
      return rows.map(toTask);
    },

    getTask(id) {
      const row = getTaskRow(id);
      return row ? toTask(row) : null;
    },

    createTask(input) {
      const name = requireText(input?.name, '任务名称', 100);
      const prompt = requireText(input?.prompt, '任务指令', 4000);
      const timezone = input?.timezone === undefined || input.timezone === '' ? systemTimezone() : input.timezone;
      const preauthorized = normalizePreauthorized(input?.preauthorized);
      const catchup = input?.catchup === undefined ? true : Boolean(input.catchup);
      const maxRetries = normalizeCount(input?.maxRetries, 0, 0, MAX_RETRIES_LIMIT, '失败重试次数');
      const failureLimit = normalizeCount(input?.failureLimit, 3, FAILURE_LIMIT_MIN, FAILURE_LIMIT_MAX, '失败上限');

      if (!isValidTimezone(timezone)) {
        throw new CronScheduleError(`无效的时区（IANA 名称）：${timezone}`);
      }
      const schedule = requireText(input?.schedule, 'cron 表达式', 200);
      const now = Date.now();
      const { nextRunAt } = validateSchedule(schedule, timezone, now);
      const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const sql = `INSERT INTO cron_tasks(
          id, name, prompt, schedule, timezone, status, preauthorized, catchup,
          max_retries, retry_backoff_ms, failure_limit, consecutive_failures,
          pause_reason, last_fired_at, next_run_at, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, 'active', ?, ?, ?, 30000, ?, 0, NULL, NULL, ?, ?, ?)`;
      db.prepare(sql).run(
        id, name, prompt, schedule, timezone, JSON.stringify(preauthorized), catchup ? 1 : 0,
        maxRetries, failureLimit, nextRunAt, now, now
      );
      return toTask(requireRow(id));
    },

    updateTask(id, patch) {
      const row = requireRow(id);
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (col: string, value: unknown): void => {
        sets.push(`${col} = ?`);
        params.push(value);
      };

      let schedule = row.schedule;
      let timezone = row.timezone;
      if (patch?.name !== undefined) push('name', requireText(patch.name, '任务名称', 100));
      if (patch?.prompt !== undefined) push('prompt', requireText(patch.prompt, '任务指令', 4000));
      if (patch?.schedule !== undefined) schedule = requireText(patch.schedule, 'cron 表达式', 200);
      if (patch?.timezone !== undefined && patch.timezone !== '') timezone = patch.timezone;
      if (patch?.preauthorized !== undefined) {
        push('preauthorized', JSON.stringify(normalizePreauthorized(patch.preauthorized)));
      }
      if (patch?.catchup !== undefined) push('catchup', patch.catchup ? 1 : 0);
      if (patch?.maxRetries !== undefined) {
        push('max_retries', normalizeCount(patch.maxRetries, 0, 0, MAX_RETRIES_LIMIT, '失败重试次数'));
      }
      if (patch?.failureLimit !== undefined) {
        push('failure_limit', normalizeCount(patch.failureLimit, 3, FAILURE_LIMIT_MIN, FAILURE_LIMIT_MAX, '失败上限'));
      }

      const scheduleChanged = schedule !== row.schedule || timezone !== row.timezone;
      let nextRunAt = row.next_run_at;
      if (scheduleChanged) {
        if (!isValidTimezone(timezone)) {
          throw new CronScheduleError(`无效的时区（IANA 名称）：${timezone}`);
        }
        // 重算：编辑期以「现在」为锚点（改期任务不补跑旧计划）
        nextRunAt = nextOccurrence(parseCron(schedule), timezone, Date.now());
        push('schedule', schedule);
        push('timezone', timezone);
        push('next_run_at', nextRunAt);
      }
      // 编辑 = 用户已介入：连续失败计数清零（恢复与否仍由显式 setEnabled 决定）
      push('consecutive_failures', 0);
      push('updated_at', Date.now());
      db.prepare(`UPDATE cron_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      return toTask(requireRow(id));
    },

    setTaskEnabled(id, enabled) {
      const row = requireRow(id);
      const now = Date.now();
      if (enabled) {
        const nextRunAt = nextOccurrence(parseCron(row.schedule), row.timezone, now);
        db.prepare(
          `UPDATE cron_tasks SET status = 'active', pause_reason = NULL,
             consecutive_failures = 0, next_run_at = ?, updated_at = ? WHERE id = ?`
        ).run(nextRunAt, now, id);
      } else {
        db.prepare(
          `UPDATE cron_tasks SET status = 'paused',
             pause_reason = COALESCE(pause_reason, '用户暂停'), updated_at = ? WHERE id = ?`
        ).run(now, id);
      }
      return toTask(requireRow(id));
    },

    pauseTask(id, reason) {
      const now = Date.now();
      db.prepare(
        `UPDATE cron_tasks SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ?`
      ).run(reason, now, id);
    },

    removeTask(id) {
      return db.transaction(() => {
        db.prepare('DELETE FROM cron_runs WHERE task_id = ?').run(id);
        const info = db.prepare('DELETE FROM cron_tasks WHERE id = ?').run(id);
        return info.changes > 0;
      })();
    },

    dueTasks(now) {
      const nowMs = now ?? Date.now();
      const rows = db
        .prepare(
          `SELECT * FROM cron_tasks
             WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
             ORDER BY next_run_at ASC, id ASC`
        )
        .all(nowMs) as CronTaskRow[];
      return rows.map(toTask);
    },

    claim(taskId, scheduledFor, options) {
      const manual = options?.manual === true ? 1 : 0;
      return db.transaction((): ClaimOutcome => {
        const running = db
          .prepare(`SELECT * FROM cron_runs WHERE task_id = ? AND status = 'running' LIMIT 1`)
          .get(taskId) as CronRunRow | undefined;
        if (running) {
          // 并发防护：上一轮未结束 → 本次计划记 skipped（可见），不执行
          db.prepare(
            `INSERT OR IGNORE INTO cron_runs(task_id, scheduled_for, attempt, manual, status, error, created_at)
             VALUES(?, ?, 0, ?, 'skipped', ?, ?)`
          ).run(taskId, scheduledFor, manual, '并发防护：同一任务上一轮仍在运行', Date.now());
          return { claimed: false, reason: 'busy' };
        }
        const info = db
          .prepare(
            `INSERT OR IGNORE INTO cron_runs(task_id, scheduled_for, attempt, manual, status, created_at)
             VALUES(?, ?, 0, ?, 'pending', ?)`
          )
          .run(taskId, scheduledFor, manual, Date.now());
        if (info.changes === 0) {
          return { claimed: false, reason: 'duplicate' };
        }
        const row = db
          .prepare('SELECT * FROM cron_runs WHERE task_id = ? AND scheduled_for = ?')
          .get(taskId, scheduledFor) as CronRunRow;
        return { claimed: true, run: toRun(row) };
      })();
    },

    claimManual(taskId, now) {
      let at = now ?? Date.now();
      for (let i = 0; i < 100; i++) {
        const outcome = store.claim(taskId, at, { manual: true });
        if (outcome.claimed) return outcome;
        if (outcome.reason === 'busy') return outcome;
        at += 1; // duplicate：同毫秒已被占用（与计划触发撞点）→ 顺延 1ms 保证唯一
      }
      return { claimed: false, reason: 'duplicate' };
    },

    advance(taskId, nextRunAt, lastFiredAt) {
      db.prepare(
        'UPDATE cron_tasks SET next_run_at = ?, last_fired_at = ?, updated_at = ? WHERE id = ?'
      ).run(nextRunAt, lastFiredAt, Date.now(), taskId);
    },

    insertMissed(taskId, scheduledFor, now, reason) {
      db.prepare(
        `INSERT OR IGNORE INTO cron_runs(task_id, scheduled_for, attempt, manual, status, error, created_at)
         VALUES(?, ?, 0, 0, 'missed', ?, ?)`
      ).run(taskId, scheduledFor, reason, now);
    },

    duePendingRuns(now) {
      const nowMs = now ?? Date.now();
      const rows = db
        .prepare(
          `SELECT * FROM cron_runs
             WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
             ORDER BY scheduled_for ASC, id ASC`
        )
        .all(nowMs) as CronRunRow[];
      return rows.map(toRun);
    },

    startRun(runId, now) {
      const info = db
        .prepare(
          `UPDATE cron_runs SET status = 'running', started_at = ?, next_retry_at = NULL
             WHERE id = ? AND status = 'pending'`
        )
        .run(now ?? Date.now(), runId);
      return info.changes > 0;
    },

    finishRun(runId, result, now) {
      const finishedAt = now ?? Date.now();
      const info = db
        .prepare(
          `UPDATE cron_runs SET status = ?, output = COALESCE(?, output), error = ?,
             finished_at = ?, next_retry_at = NULL
             WHERE id = ? AND status = 'running'`
        )
        .run(result.status, result.output ?? null, result.error ?? null, finishedAt, runId);
      return info.changes > 0;
    },

    retryRun(runId, nextRetryAt) {
      const info = db
        .prepare(
          `UPDATE cron_runs SET status = 'pending', attempt = attempt + 1, next_retry_at = ?,
             started_at = NULL, finished_at = NULL
             WHERE id = ? AND status = 'running'`
        )
        .run(nextRetryAt, runId);
      return info.changes > 0;
    },

    markRunMissed(runId, reason, now) {
      const info = db
        .prepare(
          `UPDATE cron_runs SET status = 'missed', error = ?, finished_at = ? WHERE id = ? AND status = 'pending'`
        )
        .run(reason, now ?? Date.now(), runId);
      return info.changes > 0;
    },

    recoverInterruptedRuns(reason, now) {
      const info = db
        .prepare(
          `UPDATE cron_runs SET status = 'interrupted', error = ?, finished_at = ?
             WHERE status = 'running'`
        )
        .run(reason, now ?? Date.now());
      return info.changes;
    },

    listRuns(taskId, limit) {
      const cap =
        typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
      const rows = db
        .prepare('SELECT * FROM cron_runs WHERE task_id = ? ORDER BY scheduled_for DESC, id DESC LIMIT ?')
        .all(taskId, cap) as CronRunRow[];
      return rows.map(toRun);
    },

    lastRun(taskId) {
      const row = db
        .prepare('SELECT * FROM cron_runs WHERE task_id = ? ORDER BY scheduled_for DESC, id DESC LIMIT 1')
        .get(taskId) as CronRunRow | undefined;
      return row ? toRun(row) : null;
    },

    getRun(id) {
      const row = db.prepare('SELECT * FROM cron_runs WHERE id = ?').get(id) as CronRunRow | undefined;
      return row ? toRun(row) : null;
    },

    recordSuccess(taskId) {
      db.prepare('UPDATE cron_tasks SET consecutive_failures = 0, updated_at = ? WHERE id = ?').run(
        Date.now(),
        taskId
      );
    },

    recordFailure(taskId, reason) {
      return db.transaction(() => {
        const row = requireRow(taskId);
        const consecutive = row.consecutive_failures + 1;
        const paused = consecutive >= row.failure_limit;
        if (paused) {
          db.prepare(
            `UPDATE cron_tasks SET consecutive_failures = ?, status = 'paused',
               pause_reason = ?, updated_at = ? WHERE id = ?`
          ).run(consecutive, reason, Date.now(), taskId);
        } else {
          db.prepare('UPDATE cron_tasks SET consecutive_failures = ?, updated_at = ? WHERE id = ?').run(
            consecutive,
            Date.now(),
            taskId
          );
        }
        return { consecutiveFailures: consecutive, paused };
      })();
    },

    close() {
      closeCronStore(store);
    }
  };

  openDbs.set(store, db);
  return store;
}
