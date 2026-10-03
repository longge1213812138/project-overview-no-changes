/**
 * 阶段 7：时钟工具（get_current_time，DEV_PLAN §5.7 无害演示工具）。
 *
 * - 职责：返回当前日期时间（ISO 字符串、epoch 毫秒、时区、本地化时间），
 *   作为审批 UI 的验收入口：approval:'ask' 每次都弹审批，风险级别 read。
 * - LLM 输出不可信：validateInput 严格校验结构与取值——
 *   仅接受对象、未知键拒绝、timezone 可选且必须能被
 *   Intl.DateTimeFormat 接受（非法时区直接校验不通过）。
 * - execute 开始前检查 ctx.signal 取消信号（抛 AbortError）。
 * 纯 node 内建（Intl/Date），无副作用、无新依赖。
 */
import type { ChatToolDefinition } from '../../llm/types';
import type { ToolRegistration } from '../registry';
import type { AgentToolContext } from '../runtime';

const DEFINITION: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'get_current_time',
    description: '获取当前日期时间',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA 时区，如 Asia/Shanghai，缺省用本机时区' }
      },
      additionalProperties: false
    }
  }
};

export interface ClockInput {
  /** IANA 时区（如 Asia/Shanghai），缺省用本机时区 */
  timezone?: string;
}

export interface ClockResult {
  /** UTC ISO 字符串 */
  iso: string;
  /** Unix 毫秒时间戳 */
  epochMs: number;
  /** 实际使用的时区 */
  timezone: string;
  /** 按该时区格式化的本地化时间（可读文本） */
  resolved: string;
}

/** 时区取值能否被 Intl 接受（非法时区构造时抛 RangeError） */
function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** schema 严格校验：对象、仅允许 timezone 键、取值必须是合法时区字符串 */
function isInput(value: unknown): value is ClockInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'timezone') return false;
  }
  if (!('timezone' in record) || record.timezone === undefined) return true;
  return typeof record.timezone === 'string' && isValidTimeZone(record.timezone);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/** 构造 get_current_time 注册项（approval:'ask'：每次都请求用户确认） */
export function createClockTool(): ToolRegistration {
  return {
    risk: 'read',
    approval: 'ask',
    source: 'builtin',
    tool: {
      definition: DEFINITION,
      validateInput: isInput,
      async execute(raw: unknown, ctx: AgentToolContext): Promise<ClockResult> {
        if (!isInput(raw)) {
          throw new Error('参数结构不合法');
        }
        throwIfAborted(ctx.signal);
        const now = new Date();
        const timezone = raw.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
        return {
          iso: now.toISOString(),
          epochMs: now.getTime(),
          timezone,
          resolved: new Intl.DateTimeFormat('zh-CN', {
            timeZone: timezone,
            dateStyle: 'full',
            timeStyle: 'full'
          }).format(now)
        };
      }
    }
  };
}
