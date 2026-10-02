/**
 * 阶段 3 任务 A：上下文裁剪（纯函数，见 docs/DEV_PLAN.md §5.4）。
 * 预算约 6000 token，按 1 token ≈ 1.5 字符估算 → 9000 字符。
 */

import type { ChatMessage } from '../llm/types';

/** ≈6000 token × 1.5 字符（§5.4） */
export const CONTEXT_BUDGET_CHARS = 9000;

export const FAIRY_SYSTEM_PROMPT =
  'Fairy 是运行在 Windows 桌面的私人助手。回答简洁友好，使用 Markdown 格式排版。' +
  '不要编造未提供的信息；不确定时如实说明。';

/**
 * system 恒保留（排在首位）；其余消息从最新往前累进 content.length，
 * 直到预算不够（system 自身长度也计入预算），然后按时序还原。
 * content 为空（trim 后为空串）的条目跳过；空输入 → 只有 system。
 */
export function trimToBudget(
  messages: ChatMessage[],
  systemPrompt: string,
  budgetChars: number
): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let remaining = budgetChars - systemPrompt.length;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.content.trim() === '') continue;
    const len = msg.content.length;
    if (len > remaining) break;
    remaining -= len;
    kept.push(msg);
  }

  kept.reverse();
  return [{ role: 'system', content: systemPrompt }, ...kept];
}
