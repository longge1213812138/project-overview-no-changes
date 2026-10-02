/**
 * 阶段 5 任务 A4：CalendarStore（SQLite events 表）行为测试。
 * 每用例独立临时库（mkdtempSync）；afterEach 关句柄 + 清理。
 * 时间样本一律 new Date(y, m, d, ...) 本地构造（tz 无关）；
 * listEvents 的「今天」窗依赖 Date.now() → 用 vi.spyOn 固定时钟，matchEvents 用显式 now 参数。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeCalendarStore, createCalendarStore, type CalendarStore } from './index';

const stores: CalendarStore[] = [];
const dirs: string[] = [];

/** 固定 now：2024-09-20（周五）15:30 本地时区 */
const NOW = new Date(2024, 8, 20, 15, 30).getTime();

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-calendar-test-'));
  dirs.push(dir);
  return join(dir, 'fairy.db');
}

function makeStore(): CalendarStore {
  const store = createCalendarStore({ dbPath: freshDb() });
  stores.push(store);
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (stores.length) closeCalendarStore(stores.pop()!);
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows 上句柄偶发未释放时忽略清理失败，不影响断言结果
    }
  }
});

describe('addEvent', () => {
  it('title trim 后非空才接受，trim 后入库；notes 缺省 null', () => {
    const store = makeStore();
    const rec = store.addEvent({ title: '  交周报  ', remindAt: NOW });

    expect(rec.id).toBeGreaterThan(0);
    expect(rec.title).toBe('交周报');
    expect(rec.notes).toBeNull();
    expect(rec.remindAt).toBe(NOW);
    expect(rec.done).toBe(false);
    expect(rec.fired).toBe(false);
    expect(rec.createdAt).toBeGreaterThan(0);

    const withNotes = store.addEvent({ title: '买牛奶', remindAt: NOW + 1, notes: '全脂' });
    expect(withNotes.notes).toBe('全脂');
  });

  it('title 空/纯空白/非字符串 → 抛错', () => {
    const store = makeStore();
    expect(() => store.addEvent({ title: '', remindAt: NOW })).toThrow();
    expect(() => store.addEvent({ title: '   ', remindAt: NOW })).toThrow();
    expect(() => store.addEvent({ title: 42 as unknown as string, remindAt: NOW })).toThrow();
  });

  it('remindAt 非有限数字 → 抛错', () => {
    const store = makeStore();
    expect(() => store.addEvent({ title: 'x', remindAt: Number.NaN })).toThrow();
    expect(() => store.addEvent({ title: 'x', remindAt: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => store.addEvent({ title: 'x', remindAt: '1726800000000' as unknown as number })).toThrow();
    expect(() => store.addEvent({ title: 'x', remindAt: undefined as unknown as number })).toThrow();
  });
});

describe('listEvents', () => {
  /** 跨边界样本（本地构造）：昨日 / 今日 00:00 边界 / 今晚 / 明日 00:00 边界 / 明晚 / 后日 00:00 / 周末 / +7 日 00:00 边界 */
  function seedBoundaries(store: CalendarStore): Record<string, number> {
    const samples: Array<[string, number]> = [
      ['昨日', new Date(2024, 8, 19, 10, 0).getTime()],
      ['今日零点', new Date(2024, 8, 20).getTime()],
      ['今晚', new Date(2024, 8, 20, 23, 59).getTime()],
      ['明日零点', new Date(2024, 8, 21).getTime()],
      ['明晚', new Date(2024, 8, 21, 23, 0).getTime()],
      ['后日零点', new Date(2024, 8, 22).getTime()],
      ['本周内', new Date(2024, 8, 26, 23, 59).getTime()],
      ['下周零点', new Date(2024, 8, 27).getTime()]
    ];
    const ids: Record<string, number> = {};
    for (const [name, remindAt] of samples) {
      ids[name] = store.addEvent({ title: name, remindAt }).id;
    }
    return ids;
  }

  function titles(store: CalendarStore, filter?: Parameters<CalendarStore['listEvents']>[0]): string[] {
    return store.listEvents(filter).map((e) => e.title);
  }

  it('缺省 scope=all、includeDone=true，按 remindAt ASC', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = makeStore();
    seedBoundaries(store);
    expect(titles(store)).toEqual([
      '昨日',
      '今日零点',
      '今晚',
      '明日零点',
      '明晚',
      '后日零点',
      '本周内',
      '下周零点'
    ]);
  });

  it('scope=today：[今日 00:00, 明日 00:00) 含左边界不含右边界', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = makeStore();
    seedBoundaries(store);
    expect(titles(store, { scope: 'today' })).toEqual(['今日零点', '今晚']);
  });

  it('scope=tomorrow：[明日 00:00, 后日 00:00)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = makeStore();
    seedBoundaries(store);
    expect(titles(store, { scope: 'tomorrow' })).toEqual(['明日零点', '明晚']);
  });

  it('scope=week：[今日 00:00, +7 日 00:00)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = makeStore();
    seedBoundaries(store);
    expect(titles(store, { scope: 'week' })).toEqual([
      '今日零点',
      '今晚',
      '明日零点',
      '明晚',
      '后日零点',
      '本周内'
    ]);
  });

  it('includeDone=false 排除已完成；limit 截断（remindAt ASC 前缀）', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const store = makeStore();
    const ids = seedBoundaries(store);
    store.completeEvent(ids['今晚'], true);

    expect(titles(store, { includeDone: false })).toEqual([
      '昨日',
      '今日零点',
      '明日零点',
      '明晚',
      '后日零点',
      '本周内',
      '下周零点'
    ]);
    expect(titles(store, { includeDone: true, limit: 3 })).toEqual(['昨日', '今日零点', '今晚']);
    expect(titles(store, { scope: 'today', includeDone: false })).toEqual(['今日零点']);
  });
});

describe('completeEvent / removeEvent / markFired', () => {
  it('completeEvent 置/清 done，id 不存在抛错', () => {
    const store = makeStore();
    const rec = store.addEvent({ title: '交周报', remindAt: NOW });

    store.completeEvent(rec.id, true);
    expect(store.listEvents()[0].done).toBe(true);
    store.completeEvent(rec.id, false);
    expect(store.listEvents()[0].done).toBe(false);

    expect(() => store.completeEvent(9999, true)).toThrow();
  });

  it('removeEvent 删除且幂等（不存在静默）', () => {
    const store = makeStore();
    const rec = store.addEvent({ title: '交周报', remindAt: NOW });

    store.removeEvent(rec.id);
    expect(store.listEvents()).toEqual([]);
    expect(() => store.removeEvent(rec.id)).not.toThrow();
  });

  it('markFired 置 fired；不存在静默', () => {
    const store = makeStore();
    const rec = store.addEvent({ title: '交周报', remindAt: NOW });
    expect(store.listEvents()[0].fired).toBe(false);

    store.markFired(rec.id);
    expect(store.listEvents()[0].fired).toBe(true);
    expect(() => store.markFired(9999)).not.toThrow();
  });
});

describe('dueEvents / sweepMissed / pendingEvents', () => {
  /** 三种典型：过期未触发 / 已触发 / 未来未触发（+ 已完成的过期项） */
  function seedDue(store: CalendarStore) {
    const overdue = store.addEvent({ title: '过期未触发', remindAt: NOW - 3_600_000 });
    const fired = store.addEvent({ title: '已触发', remindAt: NOW - 7_200_000 });
    store.markFired(fired.id);
    const future = store.addEvent({ title: '未来未触发', remindAt: NOW + 3_600_000 });
    const doneOne = store.addEvent({ title: '已完成过期', remindAt: NOW - 1_000 });
    store.completeEvent(doneOne.id, true);
    return { overdue, fired, future, doneOne };
  }

  it('dueEvents：remindAt<=now && !fired && !done，remindAt ASC', () => {
    const store = makeStore();
    const ids = seedDue(store);
    expect(store.dueEvents(NOW).map((e) => e.id)).toEqual([ids.overdue.id]);
  });

  it('sweepMissed：due 全置 fired=1（已过期不补弹），返回条数，二次为 0', () => {
    const store = makeStore();
    const ids = seedDue(store);

    expect(store.sweepMissed(NOW)).toBe(1);
    const byId = new Map(store.listEvents().map((e) => [e.id, e]));
    expect(byId.get(ids.overdue.id)!.fired).toBe(true);
    expect(byId.get(ids.fired.id)!.fired).toBe(true); // 原本已触发不变
    expect(byId.get(ids.doneOne.id)!.fired).toBe(false); // done 的不扫
    expect(byId.get(ids.future.id)!.fired).toBe(false);

    expect(store.sweepMissed(NOW)).toBe(0);
    expect(store.dueEvents(NOW)).toEqual([]);
  });

  it('pendingEvents：!done && !fired（sweep 后过期项已置位，只剩未来项）', () => {
    const store = makeStore();
    const ids = seedDue(store);

    expect(store.pendingEvents(NOW).map((e) => e.id).sort()).toEqual(
      [ids.overdue.id, ids.future.id].sort()
    );

    store.sweepMissed(NOW);
    expect(store.pendingEvents(NOW).map((e) => e.id)).toEqual([ids.future.id]);
  });
});

describe('matchEvents', () => {
  it('keyword → title LIKE %kw%（大小写不敏感，% 转义为字面量）', () => {
    const store = makeStore();
    store.addEvent({ title: '交周报', remindAt: NOW });
    store.addEvent({ title: 'Meeting Report', remindAt: NOW + 1 });
    store.addEvent({ title: '50%大促', remindAt: NOW + 2 });
    store.addEvent({ title: '50 大促', remindAt: NOW + 3 });

    expect(store.matchEvents({ keyword: '周报' }).map((e) => e.title)).toEqual(['交周报']);
    expect(store.matchEvents({ keyword: 'report' }).map((e) => e.title)).toEqual(['Meeting Report']);
    // '50%' 被转义 → 只命中字面量 50%，不命中 '50 大促'
    expect(store.matchEvents({ keyword: '50%' }).map((e) => e.title)).toEqual(['50%大促']);
    expect(store.matchEvents({ keyword: '  周报  ' }).map((e) => e.title)).toEqual(['交周报']); // trim
  });

  it('scope → remindAt 落入本地时区日历窗（显式 now 参数）', () => {
    const store = makeStore();
    seedScopes(store);

    expect(matchTitles(store, { scope: 'today' })).toEqual(['今日零点', '今晚']);
    expect(matchTitles(store, { scope: 'tomorrow' })).toEqual(['明日零点', '明晚']);
    expect(matchTitles(store, { scope: 'week' })).toEqual([
      '今日零点',
      '今晚',
      '明日零点',
      '明晚',
      '后日零点',
      '本周内'
    ]);
    expect(matchTitles(store, { scope: 'all' })).toEqual([
      '昨日',
      '今日零点',
      '今晚',
      '明日零点',
      '明晚',
      '后日零点',
      '本周内',
      '下周零点'
    ]);
  });

  it('keyword + scope 可并存（AND）', () => {
    const store = makeStore();
    store.addEvent({ title: '买牛奶', remindAt: new Date(2024, 8, 19, 18, 0).getTime() }); // 昨天
    store.addEvent({ title: '买牛奶', remindAt: new Date(2024, 8, 20, 18, 0).getTime() }); // 今天
    store.addEvent({ title: '买牛奶', remindAt: new Date(2024, 8, 21, 18, 0).getTime() }); // 明天

    expect(matchTitles(store, { keyword: '买牛奶', scope: 'today' })).toEqual(['买牛奶']);
    expect(matchTitles(store, { keyword: '买牛奶', scope: 'tomorrow' })).toEqual(['买牛奶']);
    expect(matchTitles(store, { keyword: '不存在', scope: 'today' })).toEqual([]);
  });

  it('includeDone 缺省 false（排除已完成），true 时含', () => {
    const store = makeStore();
    const a = store.addEvent({ title: '交周报', remindAt: NOW });
    store.addEvent({ title: '交月报', remindAt: NOW + 1 });
    store.completeEvent(a.id, true);

    expect(matchTitles(store, { keyword: '报' })).toEqual(['交月报']);
    expect(matchTitles(store, { keyword: '报', includeDone: true })).toEqual(['交周报', '交月报']);
  });

  it('无命中 → 空数组；按 remindAt ASC', () => {
    const store = makeStore();
    expect(store.matchEvents({ keyword: '不存在' })).toEqual([]);
    expect(store.matchEvents({})).toEqual([]);

    store.addEvent({ title: 'b', remindAt: NOW + 2 });
    store.addEvent({ title: 'a', remindAt: NOW + 1 });
    expect(matchTitles(store, { keyword: '不命中也不影响' })).toEqual([]);
    expect(store.matchEvents({ includeDone: true }).map((e) => e.title)).toEqual(['a', 'b']);
  });
});

/** matchEvents 用固定 now（不看墙上时钟） */
function matchTitles(
  store: CalendarStore,
  query: Parameters<CalendarStore['matchEvents']>[0]
): string[] {
  return store.matchEvents({ now: NOW, ...query }).map((e) => e.title);
}

/** 与 listEvents 相同的跨边界样本（matchEvents 走显式 now） */
function seedScopes(store: CalendarStore): void {
  const samples: Array<[string, number]> = [
    ['昨日', new Date(2024, 8, 19, 10, 0).getTime()],
    ['今日零点', new Date(2024, 8, 20).getTime()],
    ['今晚', new Date(2024, 8, 20, 23, 59).getTime()],
    ['明日零点', new Date(2024, 8, 21).getTime()],
    ['明晚', new Date(2024, 8, 21, 23, 0).getTime()],
    ['后日零点', new Date(2024, 8, 22).getTime()],
    ['本周内', new Date(2024, 8, 26, 23, 59).getTime()],
    ['下周零点', new Date(2024, 8, 27).getTime()]
  ];
  for (const [name, remindAt] of samples) {
    store.addEvent({ title: name, remindAt });
  }
}
