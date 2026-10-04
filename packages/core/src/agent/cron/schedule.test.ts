/**
 * 阶段 9：cron 表达式与触发计算语义测试（DEV_PLAN 阶段 9 验收：时区变化/错过触发/重复触发）。
 * 时区用真实 IANA（Intl），DST 用 America/New_York 2026 年真实转换日（3-08 跳时 / 11-01 回拨）。
 */
import { describe, expect, it } from 'vitest';
import {
  CronScheduleError,
  isValidTimezone,
  latestDue,
  nextOccurrence,
  nextOccurrenceOf,
  parseCron,
  systemTimezone,
  validateSchedule
} from './schedule';

const utc = (year: number, month0: number, day: number, hour = 0, minute = 0): number =>
  Date.UTC(year, month0, day, hour, minute);

describe('parseCron（字段解析）', () => {
  it('解析标准 5 字段：步长/范围/列表', () => {
    const spec = parseCron('*/15 9-17 1,15 * 1-5');
    expect(spec.minutes).toEqual([0, 15, 30, 45]);
    expect(spec.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(spec.daysOfMonth).toEqual([1, 15]);
    expect(spec.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(spec.domRestricted).toBe(true);
    expect(spec.dowRestricted).toBe(true);
  });

  it('未受限字段 restricted=false（`*` 不算受限）', () => {
    const spec = parseCron('0 9 * * *');
    expect(spec.domRestricted).toBe(false);
    expect(spec.dowRestricted).toBe(false);
  });

  it('宏展开（@daily/@hourly/@weekly）', () => {
    expect(parseCron('@daily').hours).toEqual([0]);
    expect(parseCron('@daily').minutes).toEqual([0]);
    expect(parseCron('@hourly').minutes).toEqual([0]);
    expect(parseCron('@weekly').daysOfWeek).toEqual([0]);
    expect(parseCron('@weekly').domRestricted).toBe(false);
  });

  it('英文名（月份/星期）与星期 7 归一为 0', () => {
    expect(parseCron('0 0 1 JAN *').months).toEqual([1]);
    expect(parseCron('0 0 * * MON-FRI').daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0]);
    expect(parseCron('0 0 * * 7').dowRestricted).toBe(true);
  });

  it.each([
    ['60 * * * *', '分钟'],
    ['0 24 * * *', '小时'],
    ['0 0 0 * *', '日'],
    ['0 0 32 * *', '日'],
    ['0 0 * 13 *', '月'],
    ['0 0 * * 8', '星期']
  ])('越界字段拒绝：%s', (expr) => {
    expect(() => parseCron(expr)).toThrow(CronScheduleError);
  });

  it.each(['* * * *', '* * * * * *', '', '  '])('字段数错误/空表达式拒绝：%s', (expr) => {
    expect(() => parseCron(expr)).toThrow(CronScheduleError);
  });

  it.each(['10-5 * * * *', '1-2-3 * * * *', '*/0 * * * *', '0 9,,17 * * *'])(
    '畸形表达式拒绝：%s',
    (expr) => {
      expect(() => parseCron(expr)).toThrow(CronScheduleError);
    }
  );

  it('memo：同一表达式返回同一 spec 实例', () => {
    expect(parseCron('0 9 * * *')).toBe(parseCron('0 9 * * *'));
  });
});

describe('nextOccurrence（基础与严格语义）', () => {
  const daily09 = parseCron('0 9 * * *');

  it('严格晚于 after：after 恰为触发点则取次日', () => {
    const at = utc(2026, 9, 5, 9, 0);
    expect(nextOccurrence(daily09, 'UTC', at - 1)).toBe(at);
    expect(nextOccurrence(daily09, 'UTC', at)).toBe(at + 86_400_000);
  });

  it('after 在触发点之后 → 下一次（分钟粒度起点）', () => {
    expect(nextOccurrence(daily09, 'UTC', utc(2026, 9, 5, 12, 0))).toBe(utc(2026, 9, 6, 9, 0));
  });

  it('未来无触发（2 月 30 日永不存在）→ null', () => {
    expect(nextOccurrence(parseCron('0 0 30 2 *'), 'UTC', utc(2026, 9, 5, 12, 0))).toBeNull();
    expect(nextOccurrence(parseCron('0 0 31 4 *'), 'UTC', utc(2026, 9, 5, 12, 0))).toBeNull();
  });

  it('非法时区 fail-visible（抛错，不静默回退 UTC）', () => {
    expect(() => nextOccurrence(daily09, 'Not/AZone', 0)).toThrow(CronScheduleError);
  });

  it('nextOccurrenceOf 包装：表达式 + 时区', () => {
    expect(nextOccurrenceOf('0 9 * * *', 'UTC', utc(2026, 9, 5, 12, 0))).toBe(utc(2026, 9, 6, 9, 0));
  });
});

describe('时区语义（系统时区变化不影响任务时区）', () => {
  it('同一表达式在 UTC 与 Asia/Shanghai 差 8 小时', () => {
    const after = utc(2026, 9, 5, 0, 0); // 2026-10-05T00:00Z = 上海 08:00
    const inUtc = nextOccurrenceOf('0 9 * * *', 'UTC', after);
    const inShanghai = nextOccurrenceOf('0 9 * * *', 'Asia/Shanghai', after);
    expect(inUtc).toBe(utc(2026, 9, 5, 9, 0));
    expect(inShanghai).toBe(utc(2026, 9, 5, 1, 0)); // 当天上海 09:00 = 01:00Z
    expect((inUtc ?? 0) - (inShanghai ?? 0)).toBe(8 * 3_600_000);
  });

  it('isValidTimezone / systemTimezone', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(systemTimezone().length).toBeGreaterThan(0);
  });
});

describe('DST 语义（America/New_York 2026）', () => {
  // 2026-03-08 02:00 EST → 03:00 EDT（02:00-02:59 不存在）
  // 2026-11-01 02:00 EDT → 01:00 EST（01:00-01:59 出现两次）
  const gapDay = '30 2 * * *';
  const foldDay = '30 1 * * *';

  it('春季跳时：不存在的 02:30 跳过，落到次日 02:30 EDT', () => {
    const after = utc(2026, 2, 6, 20, 0); // 3-06 20:00Z = 当地 15:00 EST
    const first = nextOccurrenceOf(gapDay, 'America/New_York', after);
    expect(first).toBe(utc(2026, 2, 7, 7, 30)); // 3-07 02:30 EST = 07:30Z
    const next = nextOccurrenceOf(gapDay, 'America/New_York', first ?? 0);
    expect(next).toBe(utc(2026, 2, 9, 6, 30)); // 3-09 02:30 EDT = 06:30Z（3-08 缺口跳过）
  });

  it('秋季回拨：重复的 01:30 只触发较早一次，当天不重复', () => {
    const after = utc(2026, 9, 31, 12, 0);
    const first = nextOccurrenceOf(foldDay, 'America/New_York', after);
    expect(first).toBe(utc(2026, 10, 1, 5, 30)); // 11-01 01:30 EDT = 05:30Z
    const next = nextOccurrenceOf(foldDay, 'America/New_York', first ?? 0);
    // 不再补 11-01 的第二遍（06:30Z），直接次日
    expect(next).toBe(utc(2026, 10, 2, 6, 30)); // 11-02 01:30 EST = 06:30Z
  });

  it('回拨当天从 00:00 起算也只有一次触发', () => {
    const dayStart = utc(2026, 10, 1, 4, 0); // 11-01 00:00 EDT
    const first = nextOccurrenceOf(foldDay, 'America/New_York', dayStart);
    expect(first).toBe(utc(2026, 10, 1, 5, 30));
    const afterFirst = nextOccurrenceOf(foldDay, 'America/New_York', first ?? 0);
    expect(new Date(afterFirst ?? 0).getUTCDate()).toBe(2); // 已跨到 11-02
  });
});

describe('日/周 OR 语义（Vixie cron）', () => {
  it('日与周同时受限 → 命中任一（1 号或周一）', () => {
    const expr = parseCron('0 0 1 * 1');
    const after = utc(2026, 9, 5, 12, 0); // 10-05 是周一
    // 下一次：10-12（周一），而非等 11-01
    expect(nextOccurrence(expr, 'UTC', after)).toBe(utc(2026, 9, 12, 0, 0));
    // 从 10-31 起：11-01 同时是 1 号与周日 → 命中 11-01
    expect(nextOccurrence(expr, 'UTC', utc(2026, 9, 31, 12, 0))).toBe(utc(2026, 10, 1, 0, 0));
  });

  it('仅周受限 → 1 号不触发（严格按周字段）', () => {
    const expr = parseCron('0 0 * * 1');
    // 11-01 是周日 → 不命中；下一周一 11-02
    expect(nextOccurrence(expr, 'UTC', utc(2026, 9, 31, 12, 0))).toBe(utc(2026, 10, 2, 0, 0));
  });

  it('工作日 + 步长：周五末尾 → 跳到周一', () => {
    const expr = parseCron('*/15 9-17 * * 1-5');
    // 2026-10-09 是周五
    expect(nextOccurrence(expr, 'UTC', utc(2026, 9, 9, 10, 0))).toBe(utc(2026, 9, 9, 10, 15));
    expect(nextOccurrence(expr, 'UTC', utc(2026, 9, 9, 17, 59))).toBe(utc(2026, 9, 12, 9, 0)); // 周一 09:00
  });
});

describe('latestDue（错过合并：只取窗口内最近一次）', () => {
  it('每分钟任务错过 10 分钟 → 取第 10 分钟那次', () => {
    const spec = parseCron('* * * * *');
    const from = utc(2026, 9, 5, 12, 0);
    const now = utc(2026, 9, 5, 12, 10);
    expect(latestDue(spec, 'UTC', from, now)).toBe(utc(2026, 9, 5, 12, 10));
    // 窗口内无触发
    expect(latestDue(spec, 'UTC', utc(2026, 9, 5, 12, 11), now)).toBeNull();
  });

  it('闭区间 [from, now]：from 恰为触发时刻时包含它', () => {
    const spec = parseCron('0 9 * * *');
    const at = utc(2026, 9, 6, 9, 0);
    expect(latestDue(spec, 'UTC', at, at)).toBe(at); // [at, at] 含 at
    expect(latestDue(spec, 'UTC', at + 60_000, at)).toBeNull(); // 下界已过 now → 无
    expect(latestDue(spec, 'UTC', at + 60_000, at + 3_600_000)).toBeNull(); // [09:01, 10:00] 内无 09:00 之外的触发… 09:00 不在区间
  });

  it('每日任务停机 3 天 → 只取最近一次', () => {
    const spec = parseCron('0 9 * * *');
    const got = latestDue(spec, 'UTC', utc(2026, 9, 3, 9, 0), utc(2026, 9, 5, 12, 0));
    expect(got).toBe(utc(2026, 9, 5, 9, 0)); // 10-05 09:00，不是 10-03
  });
});

describe('validateSchedule（保存期校验）', () => {
  it('合法 → { spec, nextRunAt }', () => {
    const r = validateSchedule('0 9 * * *', 'Asia/Shanghai', utc(2026, 9, 5, 12, 0));
    expect(r.nextRunAt).toBe(utc(2026, 9, 6, 1, 0));
  });

  it('未来无触发 → 抛错（保存期拒绝，不留死任务）', () => {
    expect(() => validateSchedule('0 0 30 2 *', 'UTC', utc(2026, 9, 5, 0, 0))).toThrow(
      /没有有效触发时间/
    );
  });

  it('非法时区 → 抛错', () => {
    expect(() => validateSchedule('0 9 * * *', 'Bad/Zone', utc(2026, 9, 5, 0, 0))).toThrow(
      CronScheduleError
    );
  });
});
