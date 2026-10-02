/**
 * 阶段 4 任务 A2 / 阶段 5 任务 A4：意图解析（docs/DEV_PLAN.md §5.1，代替工具循环的关键）。
 *
 * 每条用户消息进聊天流水线前先做 1 次非流式小调用分类：
 *   remember / forget / schedule_add / schedule_done / schedule_cancel / schedule_query / chat。
 * 解析容错：提取第一个 balanced {...}（容忍 ```json 围栏与前后废话）；
 * 任何异常（网络/超时/Abort/坏 JSON/非法 intent/空 payload）一律兜底 chat，绝不抛错、绝不写脏数据。
 *
 * schedule_add 的 remindAt（模型输出 remind_at）**不校验合法性**：缺失/非法字符串原样透传
 * （仅丢弃空串），校验与一次追问由 main 负责——parse 层不因 remindAt 非法降级为 chat。
 */

import type { ScheduleScope } from '../ipc';
import type { ChatMessage, LlmClient } from '../llm/types';

export type IntentKind =
  | 'remember'
  | 'forget'
  | 'schedule_add'
  | 'schedule_done'
  | 'schedule_cancel'
  | 'schedule_query'
  | 'chat';

export interface IntentResult {
  intent: IntentKind;
  payload?: {
    /** remember */
    content?: string;
    /** forget / schedule_done / schedule_cancel / schedule_query 的标题关键词 */
    keyword?: string;
    /** schedule_add */
    title?: string;
    /** schedule_add：模型按当前时间换算的 ISO8601 绝对时间（可能缺失/非法——main 负责校验追问） */
    remindAt?: string;
    /** schedule_add */
    notes?: string;
    /** schedule_done / schedule_cancel / schedule_query */
    scope?: ScheduleScope;
  };
}

export interface IntentParser {
  parse(message: string, opts?: { signal?: AbortSignal; now?: Date }): Promise<IntentResult>;
}

const SCHEDULE_SCOPES = ['today', 'tomorrow', 'week', 'all'] as const;

/** §5.1：短 prompt（<400 token），注入当前时间，7 个 intent 定义，只输出一个 JSON */
function buildSystemPrompt(now: Date): string {
  return [
    '你是意图分类器。判断用户想做什么，只输出一个 JSON 对象，不要解释，不要 Markdown 代码围栏。',
    `当前时间: ${now.toISOString()}`,
    'intent 只能取以下七种值：',
    '- remember：用户想让你长期记住某条信息。payload.content = 记忆内容（去掉「记住」「记一下」等命令词后的信息本体）。',
    '- forget：用户想删除已记住的信息。payload.keyword = 要删除的关键词。',
    '- schedule_add：新建日程/提醒。payload.title = 简短标题；payload.remind_at = ISO8601 绝对时间（把「明天上午十点」等相对表达按当前时间换算成绝对时间）；payload.notes = 备注（可省）。',
    '- schedule_done：日程已完成。payload.keyword = 标题关键词，和/或 payload.scope = today|tomorrow|week|all。',
    '- schedule_cancel：取消/删除日程。payload.keyword 和/或 payload.scope。',
    '- schedule_query：查询日程。payload.keyword 和/或 payload.scope。',
    '- chat：以上全部不命中（闲聊、提问、普通指令）。',
    'schedule_done/schedule_cancel/schedule_query 的 keyword 与 scope 至少给一个。全部不命中 → intent:"chat"。只输出一个 JSON：',
    '{"intent":"schedule_add","payload":{"title":"交周报","remind_at":"2024-09-28T10:00:00+08:00","notes":""}}',
    '{"intent":"schedule_query","payload":{"scope":"today"}}',
    '{"intent":"chat"}'
  ].join('\n');
}

/** 从 start 起找第一个 brace 平衡（字符串/转义感知）的 JSON 切片终点下标；找不到返回 -1 */
function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 提取第一个能 JSON.parse 的 balanced {...}；都不行返回 undefined */
function extractFirstJson(text: string): unknown {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findBalancedEnd(text, start);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // 不是合法 JSON → 试下一个 {
    }
  }
  return undefined;
}

function pickText(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** scope 白名单校验：不在枚举 → null（由调用方丢弃该字段） */
function pickScope(payload: unknown): ScheduleScope | null {
  const value = pickText(payload, 'scope');
  return value !== null && (SCHEDULE_SCOPES as readonly string[]).includes(value)
    ? (value as ScheduleScope)
    : null;
}

/** 校验 + 兜底：非法 intent / 空 payload 一律 chat（铁律不变） */
function toIntentResult(parsed: unknown): IntentResult {
  if (parsed === null || typeof parsed !== 'object') return { intent: 'chat' };
  const obj = parsed as Record<string, unknown>;
  const intent = obj.intent;

  if (intent === 'remember') {
    const content = pickText(obj.payload, 'content');
    return content === null ? { intent: 'chat' } : { intent: 'remember', payload: { content } };
  }
  if (intent === 'forget') {
    const keyword = pickText(obj.payload, 'keyword');
    return keyword === null ? { intent: 'chat' } : { intent: 'forget', payload: { keyword } };
  }
  if (intent === 'schedule_add') {
    // title trim 非空即保留；remindAt 可缺失/任意字符串（prompt 要求 ISO，parse 层不拦）
    const title = pickText(obj.payload, 'title');
    if (title === null) return { intent: 'chat' };
    const payload: NonNullable<IntentResult['payload']> = { title };
    const remindAt = pickText(obj.payload, 'remind_at') ?? pickText(obj.payload, 'remindAt');
    if (remindAt !== null) payload.remindAt = remindAt;
    const notes = pickText(obj.payload, 'notes');
    if (notes !== null) payload.notes = notes;
    return { intent: 'schedule_add', payload };
  }
  if (intent === 'schedule_done' || intent === 'schedule_cancel' || intent === 'schedule_query') {
    // keyword || scope 至少一个；scope 非法只丢字段，keyword 还在就保留 intent
    const keyword = pickText(obj.payload, 'keyword');
    const scope = pickScope(obj.payload);
    if (keyword === null && scope === null) return { intent: 'chat' };
    const payload: NonNullable<IntentResult['payload']> = {};
    if (keyword !== null) payload.keyword = keyword;
    if (scope !== null) payload.scope = scope;
    return { intent, payload };
  }
  // chat 与其余一切（intent 非法/缺失）都兜底 chat
  return { intent: 'chat' };
}

/** 依赖注入 LlmClient（core/llm 的 createLlmClient 返回值），便于用假 client 单测 */
export function createIntentParser(client: LlmClient): IntentParser {
  return {
    async parse(message, opts) {
      const system = buildSystemPrompt(opts?.now ?? new Date());
      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        { role: 'user', content: message }
      ];
      try {
        const result = await client.chatOnce(messages, { signal: opts?.signal });
        return toIntentResult(extractFirstJson(result?.content ?? ''));
      } catch {
        // 网络/超时/Abort 一律兜底 chat（stop 由外层 signal 继续控制流式阶段）
        return { intent: 'chat' };
      }
    }
  };
}
