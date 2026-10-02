/**
 * 阶段 5 任务 A4：日程存储（SQLite events 表，docs/DEV_PLAN.md §7 表结构 / §5.3 通知与查询）。
 * 类型复用 ipc.ts 的 EventRecord / EventListFilter / ScheduleScope（契约冻结，B4/C4 按此调用）。
 * 建表在迁移 v3（store/index.ts）；本层只管 events 表。
 * DTO 转换：done/fired INT→boolean（非 0 为 true），输入 boolean→INT（true=1）。
 * scope 窗口一律本地时区：today=[今日 00:00, 明日 00:00)、tomorrow=[明日, 后日)、
 * week=[今日 00:00, +7 日 00:00)、all 不限。
 */

import type { Database as Db } from 'better-sqlite3';
import type { EventListFilter, EventRecord, ScheduleScope } from '../ipc';
import { openDatabase } from '../store';

export interface CalendarStore {
  listEvents(filter?: EventListFilter): EventRecord[];
  /** title trim 后非空、remindAt 必须有限数字，否则抛错 */
  addEvent(input: { title: string; remindAt: number; notes?: string | null }): EventRecord;
  /** 不存在抛错 */
  completeEvent(id: number, done: boolean): void;
  /** 不存在静默 */
  removeEvent(id: number): void;
  /** 不存在静默 */
  markFired(id: number): void;
  /** remindAt<=now && !fired && !done，remindAt ASC */
  dueEvents(now?: number): EventRecord[];
  /** 启动清扫：把 due 全部置 fired=1（§8 已过期不补弹），返回处理条数 */
  sweepMissed(now?: number): number;
  /** !done && !fired（退出前「未触发日程」提示用）；now 为对齐签名的保留参数，不参与过滤 */
  pendingEvents(now?: number): EventRecord[];
  /**
   * 意图 done/cancel/query 匹配：keyword → title LIKE %kw%；scope → remindAt 落入本地时区日历窗；
   * 可并存（AND）；includeDone 缺省 false；按 remindAt ASC（同刻 id ASC）。
   */
  matchEvents(query: {
    keyword?: string;
    scope?: ScheduleScope;
    includeDone?: boolean;
    now?: number;
  }): EventRecord[];
}

/** events 表原始行（snake_case，INT 标志位） */
export interface EventRow {
  id: number;
  title: string | null;
  notes: string | null;
  remind_at: number | null;
  done: number | null;
  fired: number | null;
  created_at: number | null;
}

function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    title: row.title ?? '',
    notes: row.notes,
    remindAt: row.remind_at ?? 0,
    done: (row.done ?? 0) !== 0,
    fired: (row.fired ?? 0) !== 0,
    createdAt: row.created_at ?? 0
  };
}

const SCHEDULE_SCOPES = ['today', 'tomorrow', 'week', 'all'] as const;

function isScheduleScope(value: unknown): value is ScheduleScope {
  return typeof value === 'string' && (SCHEDULE_SCOPES as readonly string[]).includes(value);
}

/** scope → 本地时区日历窗 [from, to)（null = 不限） */
function scopeWindow(
  scope: ScheduleScope,
  nowMs: number
): { from: number | null; to: number | null } {
  const base = new Date(nowMs);
  // Date(y, m, d + offset) 自然处理跨月/跨年溢出
  const dayStart = (offset: number): number =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset).getTime();
  switch (scope) {
    case 'today':
      return { from: dayStart(0), to: dayStart(1) };
    case 'tomorrow':
      return { from: dayStart(1), to: dayStart(2) };
    case 'week':
      return { from: dayStart(0), to: dayStart(7) };
    default:
      return { from: null, to: null };
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

const openDbs = new WeakMap<CalendarStore, Db>();

/**
 * 附加设施（非契约 API）：关闭底层 SQLite 句柄。
 * Windows 上删除临时测试目录前必须先关句柄，退出时也可用。
 */
export function closeCalendarStore(store: CalendarStore): void {
  const db = openDbs.get(store);
  if (db && db.open) db.close();
}

export function createCalendarStore(opts: { dbPath: string }): CalendarStore {
  const db = openDatabase(opts.dbPath);

  function selectAll(where: string[], params: unknown[], limit?: number): EventRecord[] {
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const suffix = limit === undefined ? '' : ` LIMIT ${limit}`;
    const rows = db
      .prepare(`SELECT * FROM events${clause} ORDER BY remind_at ASC, id ASC${suffix}`)
      .all(...params) as EventRow[];
    return rows.map(toEventRecord);
  }

  const store: CalendarStore = {
    listEvents(filter) {
      const scope = isScheduleScope(filter?.scope) ? filter.scope : 'all';
      const includeDone = filter?.includeDone ?? true;
      const window = scopeWindow(scope, Date.now());

      const where: string[] = [];
      const params: unknown[] = [];
      if (!includeDone) where.push('done = 0');
      if (window.from !== null) {
        where.push('remind_at >= ?');
        params.push(window.from);
      }
      if (window.to !== null) {
        where.push('remind_at < ?');
        params.push(window.to);
      }
      const limit =
        typeof filter?.limit === 'number' && Number.isFinite(filter.limit) && filter.limit >= 0
          ? Math.floor(filter.limit)
          : undefined;
      return selectAll(where, params, limit);
    },

    addEvent(input) {
      const title = requireText(input?.title, 'addEvent: title');
      const remindAt = input?.remindAt;
      if (typeof remindAt !== 'number' || !Number.isFinite(remindAt)) {
        throw new Error('addEvent: remindAt 必须是有限数字（epoch ms）');
      }
      const notes = typeof input.notes === 'string' ? input.notes : null;
      const createdAt = Date.now();

      const info = db
        .prepare('INSERT INTO events(title, notes, remind_at, done, fired, created_at) VALUES(?, ?, ?, 0, 0, ?)')
        .run(title, notes, remindAt, createdAt);
      return {
        id: Number(info.lastInsertRowid),
        title,
        notes,
        remindAt,
        done: false,
        fired: false,
        createdAt
      };
    },

    completeEvent(id, done) {
      const row = db.prepare('SELECT id FROM events WHERE id = ?').get(id) as { id: number } | undefined;
      if (!row) {
        throw new Error(`completeEvent: 日程 ${id} 不存在`);
      }
      db.prepare('UPDATE events SET done = ? WHERE id = ?').run(done ? 1 : 0, id);
    },

    removeEvent(id) {
      db.prepare('DELETE FROM events WHERE id = ?').run(id);
    },

    markFired(id) {
      db.prepare('UPDATE events SET fired = 1 WHERE id = ?').run(id);
    },

    dueEvents(now) {
      const nowMs = now ?? Date.now();
      return selectAll(['remind_at <= ?', 'fired = 0', 'done = 0'], [nowMs]);
    },

    sweepMissed(now) {
      const nowMs = now ?? Date.now();
      const info = db
        .prepare('UPDATE events SET fired = 1 WHERE remind_at <= ? AND fired = 0 AND done = 0')
        .run(nowMs);
      return info.changes;
    },

    pendingEvents(now) {
      void now; // 保留参数：过滤语义固定为 !done && !fired，不随时间变化
      return selectAll(['done = 0', 'fired = 0'], []);
    },

    matchEvents(query) {
      const nowMs = query?.now ?? Date.now();
      const keyword = typeof query?.keyword === 'string' ? query.keyword.trim() : '';
      const scope = isScheduleScope(query?.scope) ? query.scope : undefined;
      const includeDone = query?.includeDone ?? false;

      const where: string[] = [];
      const params: unknown[] = [];
      if (!includeDone) where.push('done = 0');
      if (keyword !== '') {
        where.push("title LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(keyword)}%`);
      }
      if (scope !== undefined) {
        const window = scopeWindow(scope, nowMs);
        if (window.from !== null) {
          where.push('remind_at >= ?');
          params.push(window.from);
        }
        if (window.to !== null) {
          where.push('remind_at < ?');
          params.push(window.to);
        }
      }
      return selectAll(where, params);
    }
  };

  openDbs.set(store, db);
  return store;
}
