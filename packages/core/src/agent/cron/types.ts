/**
 * 阶段 9 cron：内部共享纯类型（不进 ipc.ts 契约面）。
 * CronSpec = parseCron 的产物（字段已归一：升序去重集合 + 日/周受限标记）。
 */
export interface CronSpec {
  /** 原始表达式（宏保留原样，便于回显） */
  source: string;
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  /** 0=周日…6；7 已归一为 0 */
  daysOfWeek: number[];
  /** 日字段非 `*` */
  domRestricted: boolean;
  /** 周字段非 `*` */
  dowRestricted: boolean;
}

/** 触发计划（planDue / planRecovery 的纯决策结果，main 驱动按此落库执行） */
export interface CronTriggerPlan {
  /** 需要 claim 的计划时刻（null = 本次无需执行） */
  claimAt: number | null;
  /** 因错过而记录为 missed 的时刻（catchup 关闭的恢复场景；与 claimAt 互斥） */
  missedAt: number | null;
  /** 持久化的下次触发（null = 未来无触发） */
  nextRunAt: number | null;
}
