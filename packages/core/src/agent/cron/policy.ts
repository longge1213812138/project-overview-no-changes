/**
 * 阶段 9：无人值守执行策略（DEV_PLAN §5.2/§5.9 纯逻辑，可单测；main/cron.ts 负责编排）。
 *
 * 三块：
 * 1. planTrigger / planRecovery：到期与恢复的**纯决策**（claim 哪个时刻、next_run_at 推到哪、
 *    catchup 关闭时记 missed）——store 落库、main 执行，语义在测试里钉死；
 * 2. createCronAuthorizer：预授权授权链——只放行预授权工具，**越界（outside）永不授予**，
 *    触发即 escalation（上层暂停任务 + 通知，绝不绕过交互审批）；
 * 3. buildCronMessages：无人值守运行的 system 约束（不得反问、不得伪装成功）。
 */
import type { ChatMessage } from '../../llm/types';
import type { CronTask } from '../../ipc';
import type { ToolRegistry } from '../registry';
import type { AgentAuthorize } from '../runtime';
import { latestDue, nextOccurrence, parseCron } from './schedule';
import type { CronTriggerPlan } from './types';

/** 超范围升级：需要交互审批而无人值守无法审批的动作 */
export interface CronEscalation {
  kind: 'outside' | 'not-preauthorized';
  tool: string;
  reason: string;
}

/**
 * 到期计划（正常 tick 与启动恢复共用锚点逻辑）：
 * 到期窗口 [next_run_at, now] 内**只取最近一次**（更早的错过合并跳过，绝不补一长串）；
 * next_run_at 永远推进到 now 之后的下一次触发。
 * 未到期 / 无未来触发 → null。
 */
function plan(task: CronTask, now: number, recovery: boolean): CronTriggerPlan | null {
  if (task.status !== 'active') return null;
  if (task.nextRunAt === null || task.nextRunAt > now) return null;
  const spec = parseCron(task.schedule);
  // next_run_at 本身是触发时刻（编辑/恢复时都重算过），闭区间 [next_run_at, now] 取最近一次
  const latest = latestDue(spec, task.timezone, task.nextRunAt, now);
  const anchor = latest ?? task.nextRunAt;
  const nextRunAt = nextOccurrence(spec, task.timezone, now);
  if (recovery && !task.catchup) {
    return { claimAt: null, missedAt: anchor, nextRunAt };
  }
  return { claimAt: anchor, missedAt: null, nextRunAt };
}

/** 正常 tick：到期 → 补跑最近一次（停机窗口与 tick 迟到统一按合并语义） */
export function planTrigger(task: CronTask, now: number): CronTriggerPlan | null {
  return plan(task, now, false);
}

/** 启动恢复：catchup 开 → 补跑最近一次；关 → 记 missed 不补跑（语义由任务配置决定） */
export function planRecovery(task: CronTask, now: number): CronTriggerPlan | null {
  return plan(task, now, true);
}

export interface CronAuthorizerOptions {
  /** 任务预授权工具名集合（未暴露的工具在 runtime 层即「未注册」，这里是纵深防御） */
  preauthorized: string[];
  /** 触发超范围/未预授权：main 侧应立即暂停任务 + 通知（并中止本轮运行） */
  onEscalation?: (escalation: CronEscalation) => void;
}

/**
 * 无人值守授权链（显式实现，评估顺序与 createRegistryAuthorizer 对齐）：
 * 1. 未注册/assess=deny → 拒绝（策略语义与交互会话一致，不升级不暂停）；
 * 2. **预授权是硬条件**：不在任务预授权集合 → 拒绝 + escalation（不因 approval=auto 绕过，
 *    §5.9「只允许事先授权的操作」是集合约束）；
 * 3. assess 判定越界 → 拒绝 + escalation（越界永不授予，即便工具已预授权）；
 * 4. 放行时 allowOutside 恒 false（执行器仍自行二次校验，防御纵深）。
 * escalation 由 main 暂停任务并通知用户——绝不在无人值守时绕过交互审批。
 */
export function createCronAuthorizer(registry: ToolRegistry, options: CronAuthorizerOptions): AgentAuthorize {
  const preauthorized = new Set(options.preauthorized);
  return async (tool, input) => {
    const name = tool.definition.function.name;
    const reg = registry.get(name);
    if (!reg || reg.tool !== tool) {
      return { approved: false, reason: `工具未在注册表登记：${name}` };
    }
    const assessment = reg.assess ? reg.assess(input) : { decision: 'allow' as const };
    if (assessment.decision === 'deny') {
      return { approved: false, reason: assessment.reason ?? '工具策略拒绝执行' };
    }
    if (!preauthorized.has(name)) {
      const reason = `无人值守任务未预授权工具「${name}」（该操作需要交互审批）`;
      options.onEscalation?.({ kind: 'not-preauthorized', tool: name, reason });
      return { approved: false, reason };
    }
    if (assessment.outside === true) {
      const reason = `工具「${name}」触及工作区外资源，无人值守运行不授予越界权限`;
      options.onEscalation?.({ kind: 'outside', tool: name, reason });
      return { approved: false, reason };
    }
    return { approved: true, allowOutside: false };
  };
}

export interface CronMessageOptions {
  now: number;
  /** 本轮实际暴露的工具（已过滤为预授权集合） */
  toolNames: string[];
  /** 能力提示（端点不支持工具等），非空则注入 system 可见 */
  capabilityNote?: string;
}

/** 无人值守运行的 system 约束 + 任务指令（user） */
export function buildCronMessages(task: CronTask, options: CronMessageOptions): ChatMessage[] {
  const toolLine =
    options.toolNames.length > 0
      ? `只允许使用已预授权的工具：${options.toolNames.join('、')}。`
      : '本任务未预授权任何工具，不要尝试调用任何工具。';
  const system = [
    '你是 Fairy（主人的超级智能体管家）的「定时任务」执行者，语气保持 Fairy 本人（结论先行、系统式口吻，可带一句轻吐槽）。任务由本地定时引擎按计划自动触发，无人值守。',
    `任务名称：${task.name}`,
    `计划表达式：${task.schedule}（时区 ${task.timezone}）`,
    `触发时间：${new Date(options.now).toISOString()}`,
    '执行规则：',
    '1. 只执行任务指令本身，不要寒暄、不要向用户提问——没有人会回答。',
    `2. ${toolLine}需要用户交互确认的操作一律不要尝试（尝试会导致任务被暂停并通知用户）。`,
    '3. 输出简明的执行总结（不超过 300 字）；失败或未完成必须如实说明，绝不伪装成功。',
    ...(options.capabilityNote ? [`【能力提示】${options.capabilityNote}`] : [])
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: task.prompt }
  ];
}

/** 运行输出落库截断（面板展示用；原始日志在 main 侧完整） */
export function truncateCronOutput(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…（已截断，共 ${text.length} 字符）`;
}
