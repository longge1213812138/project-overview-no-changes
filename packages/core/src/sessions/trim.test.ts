/**
 * 阶段 3 任务 A：trimToBudget 纯函数单测（docs/DEV_PLAN.md §5.4 裁剪策略）。
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../llm/types';
import { CONTEXT_BUDGET_CHARS, FAIRY_SYSTEM_PROMPT, trimToBudget } from './trim';

const u = (content: string): ChatMessage => ({ role: 'user', content });

describe('trimToBudget', () => {
  it('空输入 → 只有 system', () => {
    expect(trimToBudget([], 'SYS', 100)).toEqual([{ role: 'system', content: 'SYS' }]);
  });

  it('跳过 content 为空的条目（含纯空白占位）', () => {
    const out = trimToBudget([u(''), u('   '), u('a'), u('\n\t')], 'S', 100);
    expect(out).toEqual([
      { role: 'system', content: 'S' },
      { role: 'user', content: 'a' }
    ]);
  });

  it('预算内全保留，时序不变，system 在首', () => {
    const out = trimToBudget([u('一'), u('二'), u('三')], 'S', 100);
    expect(out).toEqual([
      { role: 'system', content: 'S' },
      u('一'),
      u('二'),
      u('三')
    ]);
  });

  it('system 自身长度计入预算', () => {
    // system 'SYS'(3) + 消息预算 7：'aaa'(3) + 'bb'(2) + 'cccc'(4)
    const out = trimToBudget([u('aaa'), u('bb'), u('cccc')], 'SYS', 10);
    expect(out).toEqual([
      { role: 'system', content: 'SYS' },
      u('bb'),
      u('cccc')
    ]);
  });

  it('超预算从最旧丢弃，保留最新且按时序还原', () => {
    const msgs = [u('老一'), u('老二'), u('新一'), u('新二')];
    // system 'S'(1)，预算 5 → 消息预算 4：'新二'(2) + '新一'(2) = 4，'老二' 放不下
    const out = trimToBudget(msgs, 'S', 5);
    expect(out).toEqual([
      { role: 'system', content: 'S' },
      u('新一'),
      u('新二')
    ]);
  });

  it('放不下的消息之后更旧的不再取（break 语义，非跳过继续）', () => {
    // system 'S'(1)，预算 4 → 消息预算 3：'ab'(2) 后剩 1，'zzzz' 放不下 → 更旧的 'q'(1) 也不取
    const out = trimToBudget([u('q'), u('zzzz'), u('ab')], 'S', 4);
    expect(out).toEqual([
      { role: 'system', content: 'S' },
      u('ab')
    ]);
  });

  it('system 本身就超预算 → 只保留 system', () => {
    const out = trimToBudget([u('a')], '很长的system提示词', 3);
    expect(out).toEqual([{ role: 'system', content: '很长的system提示词' }]);
  });

  it('真实预算：FAIRY_SYSTEM_PROMPT + 9000 字符可用', () => {
    expect(CONTEXT_BUDGET_CHARS).toBe(9000);
    expect(FAIRY_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    const out = trimToBudget([u('x'.repeat(20000))], FAIRY_SYSTEM_PROMPT, CONTEXT_BUDGET_CHARS);
    expect(out).toEqual([{ role: 'system', content: FAIRY_SYSTEM_PROMPT }]);
  });
});
