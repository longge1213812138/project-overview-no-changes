/**
 * 阶段 5 任务 A4：日程时间标签测试。
 * 全部用固定 now + new Date(y, m, d, ...) 本地构造样本（tz 无关写法），
 * 不依赖运行机器的时区与当前时刻。
 */

import { describe, expect, it, vi } from 'vitest';
import { formatEventTime, relativeDayLabel } from './format';

// 固定 now：2024-09-20（周五）15:30 本地时区
const NOW = new Date(2024, 8, 20, 15, 30).getTime();

describe('formatEventTime', () => {
  it("'M/D HH:MM'（月/日不补零，时分补零）", () => {
    expect(formatEventTime(new Date(2024, 8, 28, 10, 0).getTime())).toBe('9/28 10:00');
    expect(formatEventTime(new Date(2024, 0, 5, 9, 5).getTime())).toBe('1/5 09:05');
    expect(formatEventTime(new Date(2024, 11, 31, 23, 59).getTime())).toBe('12/31 23:59');
  });
});

describe('relativeDayLabel', () => {
  it('同日未来时刻 → 今天 HH:MM', () => {
    expect(relativeDayLabel(new Date(2024, 8, 20, 18, 5).getTime(), NOW)).toBe('今天 18:05');
    // 刚好等于 now 不算过去
    expect(relativeDayLabel(NOW, NOW)).toBe('今天 15:30');
  });

  it('+1 → 明天 HH:MM、+2 → 后天 HH:MM', () => {
    expect(relativeDayLabel(new Date(2024, 8, 21, 10, 0).getTime(), NOW)).toBe('明天 10:00');
    expect(relativeDayLabel(new Date(2024, 8, 22, 8, 30).getTime(), NOW)).toBe('后天 08:30');
  });

  it('+3..6 → 周X HH:MM（周一=1，2024-09-20 是周五）', () => {
    expect(relativeDayLabel(new Date(2024, 8, 23, 9, 0).getTime(), NOW)).toBe('周一 09:00'); // +3
    expect(relativeDayLabel(new Date(2024, 8, 25, 9, 0).getTime(), NOW)).toBe('周三 09:00'); // +5
    expect(relativeDayLabel(new Date(2024, 8, 26, 21, 15).getTime(), NOW)).toBe('周四 21:15'); // +6
  });

  it('+7 及更远 → M/D HH:MM', () => {
    expect(relativeDayLabel(new Date(2024, 8, 27, 10, 0).getTime(), NOW)).toBe('9/27 10:00'); // +7
    expect(relativeDayLabel(new Date(2024, 11, 31, 23, 0).getTime(), NOW)).toBe('12/31 23:00');
  });

  it('已过去 → 已过期（含昨天与今天已过的时刻）', () => {
    expect(relativeDayLabel(new Date(2024, 8, 19, 10, 0).getTime(), NOW)).toBe('已过期');
    expect(relativeDayLabel(new Date(2024, 8, 20, 9, 0).getTime(), NOW)).toBe('已过期');
    expect(relativeDayLabel(NOW - 1, NOW)).toBe('已过期');
    // 远古日期也不落 M/D 分支
    expect(relativeDayLabel(new Date(2020, 0, 1, 0, 0).getTime(), NOW)).toBe('已过期');
  });

  it('now 缺省取 Date.now()（mock 时钟验证）', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      expect(relativeDayLabel(new Date(2024, 8, 21, 7, 0).getTime())).toBe('明天 07:00');
    } finally {
      spy.mockRestore();
    }
  });
});
