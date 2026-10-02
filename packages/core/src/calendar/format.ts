/**
 * 阶段 5 任务 A4：日程时间展示（docs/DEV_PLAN.md §5.3 面板列表 / 意图确认语）。
 * 全部按本地时区计算：日历边界用 Date 的 getFullYear/getMonth/getDate + new Date(y, m, d) 构造，
 * 不依赖 UTC 偏移（测试可用同样的本地构造写跨边界样本，tz 无关）。
 */

/** 周几标签（按 getDay() 索引 0=周日；「周一=1」即 getDay() 1 → '周一'） */
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function hhmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 'M/D HH:MM'（如 9/28 10:00），本地时区 */
export function formatEventTime(remindAt: number): string {
  const d = new Date(remindAt);
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm(d)}`;
}

/** 本地日历日差：0=今天、1=明天、2=后天…（按 00:00 边界算，不受具体时刻影响） */
function localDayDiff(remindAt: number, nowMs: number): number {
  const a = new Date(nowMs);
  const b = new Date(remindAt);
  const startA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const startB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  // 除以一天毫秒数取整在 DST 切换日可能差 ±1h → 四舍五入消掉
  return Math.round((startB - startA) / 86_400_000);
}

/**
 * 相对日标签（本地时区）：
 * - remindAt < now → '已过期'（「已过去」含今天已过的时刻，§8 过期日程的展示口径）；
 * - 同日 '今天 HH:MM'、+1 '明天 HH:MM'、+2 '后天 HH:MM'、
 *   +3..6 '周X HH:MM'（周一=1）、其余（+7 及更远）'M/D HH:MM'。
 */
export function relativeDayLabel(remindAt: number, now?: number): string {
  const nowMs = now ?? Date.now();
  if (remindAt < nowMs) return '已过期';
  const d = new Date(remindAt);
  const diff = localDayDiff(remindAt, nowMs);
  if (diff === 0) return `今天 ${hhmm(d)}`;
  if (diff === 1) return `明天 ${hhmm(d)}`;
  if (diff === 2) return `后天 ${hhmm(d)}`;
  if (diff >= 3 && diff <= 6) return `${WEEKDAY_LABELS[d.getDay()]} ${hhmm(d)}`;
  return formatEventTime(remindAt);
}
