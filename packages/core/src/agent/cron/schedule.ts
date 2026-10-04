/**
 * 阶段 9：cron 表达式解析与时区/DST 感知的触发计算（DEV_PLAN §5.9 任务 1）。
 *
 * 纯 TS（web-safe，无 node 内建），时区一律走 Intl（不引第三方依赖）。
 *
 * 已确认语义（DEV_PLAN 阶段 9 实施备注同步收录）：
 * - 表达式为标准 5 字段（分 时 日 月 周），支持 `*`、列表 `,`、范围 `-`、步长 `/`、
 *   月份/星期英文名与 `@yearly/@monthly/@weekly/@daily/@hourly` 宏；
 * - 日/周字段同时受限时按 Vixie cron 的 **OR** 语义（`0 9 * * 1-5` 与 `0 9 1 * 1` 都命中）；
 * - 触发时刻 = 任务时区（IANA）墙上时钟匹配后换算的 epoch；系统时区变化不影响已存任务；
 * - DST「不存在的墙上时刻」（春季跳时缺口）→ 该次跳过（不胡乱平移）；
 * - DST「重复的墙上时刻」（秋季回拨重叠）→ 只取**较早**一次，保证每个墙上时刻每天最多触发一次；
 * - 未来无任何触发（如 `0 0 30 2 *`）→ nextOccurrence 返回 null（保存期即拒绝）。
 */
import type { CronSpec } from './types';

export class CronScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronScheduleError';
  }
}

/** 常见宏 → 5 字段展开（大小写不敏感） */
const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

const DAY_MS = 86_400_000;

/** 字段边界：分 0-59 / 时 0-23 / 日 1-31 / 月 1-12 / 周 0-7（7 归一为 0） */
interface FieldDef {
  label: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const FIELDS: FieldDef[] = [
  { label: '分钟', min: 0, max: 59 },
  { label: '小时', min: 0, max: 23 },
  { label: '日', min: 1, max: 31 },
  { label: '月', min: 1, max: 12, names: MONTH_NAMES },
  { label: '星期', min: 0, max: 7, names: DOW_NAMES }
];

/** 解析数字或英文名（大小写不敏感） → 规范整数（越界抛 CronScheduleError） */
function toNumber(raw: string, def: FieldDef): number {
  const named = def.names?.[raw.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(raw)) {
    throw new CronScheduleError(`${def.label}字段含非法值：${raw}`);
  }
  const n = Number.parseInt(raw, 10);
  if (n < def.min || n > def.max) {
    throw new CronScheduleError(`${def.label}字段超出范围 ${def.min}-${def.max}：${raw}`);
  }
  return n;
}

/** 单字段解析：`*` / `a` / `a-b` / 各形态步长 `x/n`，逗号分列表；返回升序去重集合 */
function parseField(token: string, def: FieldDef): { values: number[]; restricted: boolean } {
  const restricted = token !== '*';
  const values = new Set<number>();

  for (const partRaw of token.split(',')) {
    const part = partRaw.trim();
    if (part === '') {
      throw new CronScheduleError(`${def.label}字段含空列表项：${token}`);
    }
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!m) {
      throw new CronScheduleError(`${def.label}字段无法解析：${part}`);
    }
    const [, baseRaw, stepRaw] = m;
    let step = 1;
    if (stepRaw !== undefined) {
      step = Number.parseInt(stepRaw, 10);
      if (step < 1) {
        throw new CronScheduleError(`${def.label}字段步长必须 ≥1：${part}`);
      }
    }

    let from: number;
    let to: number;
    if (baseRaw === '*') {
      from = def.min;
      to = def.max;
    } else if (baseRaw.includes('-')) {
      const segs = baseRaw.split('-');
      if (segs.length !== 2) {
        throw new CronScheduleError(`${def.label}字段范围无法解析：${baseRaw}`);
      }
      const [aRaw, bRaw] = segs;
      from = toNumber(aRaw, def);
      to = toNumber(bRaw, def);
      if (from > to) {
        throw new CronScheduleError(`${def.label}字段范围不支持回绕：${baseRaw}`);
      }
    } else {
      from = toNumber(baseRaw, def);
      // `a/n` = 从 a 到字段最大值按步长（vixie 语义）；单独 `a` = 仅 a
      to = stepRaw !== undefined ? def.max : from;
    }
    for (let v = from; v <= to; v += step) {
      // 星期 7 = 0（Sunday），归一后集合内无重复
      values.add(def.label === '星期' && v === 7 ? 0 : v);
    }
  }

  if (values.size === 0) {
    throw new CronScheduleError(`${def.label}字段为空：${token}`);
  }
  return { values: [...values].sort((a, b) => a - b), restricted };
}

/** 解析（带 memo；同一表达式字符串只解析一次） */
const specCache = new Map<string, CronSpec>();

export function parseCron(expression: string): CronSpec {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new CronScheduleError('cron 表达式不能为空');
  }
  const trimmed = expression.trim();
  const cached = specCache.get(trimmed);
  if (cached) return cached;

  const macro = MACROS[trimmed.toLowerCase()];
  const source = macro ?? trimmed;
  const tokens = source.split(/\s+/);
  if (tokens.length !== 5) {
    throw new CronScheduleError(
      `cron 表达式必须是 5 个字段（分 时 日 月 周），实际 ${tokens.length} 个：${trimmed}`
    );
  }

  const [minT, hourT, domT, monthT, dowT] = tokens;
  const minute = parseField(minT, FIELDS[0]);
  const hour = parseField(hourT, FIELDS[1]);
  const dom = parseField(domT, FIELDS[2]);
  const month = parseField(monthT, FIELDS[3]);
  const dow = parseField(dowT, FIELDS[4]);

  const spec: CronSpec = {
    source: trimmed,
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted
  };
  specCache.set(trimmed, spec);
  return spec;
}

// ===== 时区工具（Intl，无第三方依赖） =====

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch {
      throw new CronScheduleError(`无效的时区（IANA 名称）：${tz}`);
    }
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

export interface WallParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** epoch → 指定时区墙上时钟 */
function wallParts(tz: string, epoch: number): WallParts {
  const parts = wallFormatter(tz).formatToParts(new Date(epoch));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number.parseInt(found.value, 10) : 0;
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second')
  };
}

/** 该时区在某 epoch 的 UTC 偏移（epoch - 本地墙上时刻按 UTC 解读；含 :30/:45 时区） */
function tzOffsetMs(tz: string, epoch: number): number {
  const p = wallParts(tz, epoch);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - epoch;
}

/** 墙上时刻（y-m-d H:M，秒为 0）→ epoch；DST 缺口返回 null，重叠返回较早一次 */
function wallToEpoch(tz: string, y: number, mo: number, d: number, h: number, mi: number): number | null {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offBefore = tzOffsetMs(tz, target - DAY_MS);
  const offAfter = tzOffsetMs(tz, target + DAY_MS);
  const candidates = new Set<number>([target - offBefore, target - offAfter]);
  let earliest: number | null = null;
  for (const candidate of candidates) {
    const p = wallParts(tz, candidate);
    const back = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (back !== target) continue; // 该候选换算回来对不上 → 落在 DST 缺口
    if (earliest === null || candidate < earliest) earliest = candidate;
  }
  return earliest;
}

/** 墙上日历日推进一天（Date.UTC 溢出语义自然处理跨月/跨年） */
function nextWallDay(y: number, mo: number, d: number): WallParts {
  const t = Date.UTC(y, mo - 1, d + 1);
  const date = new Date(t);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0
  };
}

/** 墙上日期的星期（0=周日）——按公历直接算，不受时区影响 */
function weekdayOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** 月/日/周字段匹配（Vixie：日与周同时受限 → OR 语义） */
function matchesDate(spec: CronSpec, mo: number, d: number, dow: number): boolean {
  if (!spec.months.includes(mo)) return false;
  const domOk = spec.domRestricted && spec.daysOfMonth.includes(d);
  const dowOk = spec.dowRestricted && spec.daysOfWeek.includes(dow);
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/** 搜索上界：约 5 年（覆盖 2/29、`0 0 30 2 *` 等稀疏表达式后放弃） */
const MAX_SEARCH_DAYS = 1830;

/**
 * 严格晚于 afterMs 的下一次触发（epoch ms）；未来无触发返回 null。
 * 从 after 所在分钟的下一分钟开始搜（触发粒度 = 分钟）。
 */
export function nextOccurrence(spec: CronSpec, tz: string, afterMs: number): number | null {
  if (!Number.isFinite(afterMs)) {
    throw new CronScheduleError('nextOccurrence: afterMs 必须是有限数字');
  }
  wallFormatter(tz); // 时区非法立即抛错（fail-visible，不静默回退 UTC）

  const start = Math.floor(afterMs / 60000) * 60000 + 60000;
  const startParts = wallParts(tz, start);
  let y = startParts.year;
  let mo = startParts.month;
  let d = startParts.day;

  for (let dayIdx = 0; dayIdx < MAX_SEARCH_DAYS; dayIdx++) {
    const dow = weekdayOf(y, mo, d);
    if (matchesDate(spec, mo, d, dow)) {
      const firstDay = dayIdx === 0;
      for (const h of spec.hours) {
        for (const mi of spec.minutes) {
          if (firstDay && (h < startParts.hour || (h === startParts.hour && mi < startParts.minute))) {
            continue;
          }
          const epoch = wallToEpoch(tz, y, mo, d, h, mi);
          if (epoch !== null && epoch > afterMs) return epoch;
        }
      }
    }
    const next = nextWallDay(y, mo, d);
    y = next.year;
    mo = next.month;
    d = next.day;
  }
  return null;
}

/** memo 版：main/store 侧热路径（每 tick 每任务一次）避免重复解析 */
export function nextOccurrenceOf(expression: string, tz: string, afterMs: number): number | null {
  return nextOccurrence(parseCron(expression), tz, afterMs);
}

/** 单次枚举上限：错过窗口极大时（如全年停机 + 每分钟任务）兜底，防止 tick 卡死 */
const LATEST_DUE_CAP = 200_000;

/**
 * [from, now] 内**最近一次**计划触发（闭区间，from 恰为触发时刻时包含它）；无则 null。
 * 用于「错过合并补跑」：无论错过多久，只取最近一次（更早的合并跳过，绝不补一长串）。
 */
export function latestDue(
  spec: CronSpec,
  tz: string,
  from: number,
  nowMs: number
): number | null {
  // closed [from, now]：从 from-1ms 起找「严格大于」的第一项，天然包含 from 本身
  let cursor = from - 1;
  let last: number | null = null;
  for (let i = 0; i < LATEST_DUE_CAP; i++) {
    const next = nextOccurrence(spec, tz, cursor);
    if (next === null || next > nowMs) break;
    last = next;
    cursor = next;
  }
  return last;
}

export function latestDueOf(
  expression: string,
  tz: string,
  from: number,
  nowMs: number
): number | null {
  return latestDue(parseCron(expression), tz, from, nowMs);
}

/** IANA 时区是否有效 */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 创建任务时的默认时区（系统当前时区；写入任务后即固定，与后续系统时区变化解耦） */
export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** 校验表达式 + 时区，并返回未来首次触发（null = 未来无触发，保存期拒绝） */
export function validateSchedule(
  expression: string,
  tz: string,
  nowMs: number
): { spec: CronSpec; nextRunAt: number | null } {
  if (!isValidTimezone(tz)) {
    throw new CronScheduleError(`无效的时区（IANA 名称）：${tz}`);
  }
  const spec = parseCron(expression);
  const nextRunAt = nextOccurrence(spec, tz, nowMs);
  if (nextRunAt === null) {
    throw new CronScheduleError(`表达式在未来没有有效触发时间：${expression}`);
  }
  return { spec, nextRunAt };
}
