/**
 * 阶段 4 任务 A2：formatMemoryBlock（§5.2 注入块格式）测试。
 * 日期 = updatedAt 的 M/D（本地时区），格式逐字符精确匹配。
 */

import { describe, expect, it } from 'vitest';
import type { MemoryRecord } from '../ipc';
import { formatMemoryBlock, type ScoredMemory } from './index';

function scored(
  id: number,
  content: string,
  kind: MemoryRecord['kind'],
  updatedAt: Date,
  score = 1
): ScoredMemory {
  return {
    id,
    kind,
    content,
    sourceSession: null,
    weight: 1,
    createdAt: updatedAt.getTime(),
    updatedAt: updatedAt.getTime(),
    score
  };
}

describe('formatMemoryBlock', () => {
  it('§5.2 格式精确匹配（含日期 M/D，无尾换行）', () => {
    const memories = [
      scored(1, '喜欢简洁回答', 'preference', new Date(2024, 8, 15), 0.9),
      scored(2, '正在写 Fairy 项目', 'topic', new Date(2024, 8, 20), 0.5)
    ];
    expect(formatMemoryBlock(memories)).toBe(
      '【关于这个用户】\n- 喜欢简洁回答（preference, 9/15）\n- 正在写 Fairy 项目（topic, 9/20）'
    );
  });

  it('单条 = 头行 + 一行；日期不补零（1/2 而非 01/02）', () => {
    const one = [scored(1, '我喝美式不加糖', 'note', new Date(2024, 0, 2))];
    expect(formatMemoryBlock(one)).toBe('【关于这个用户】\n- 我喝美式不加糖（note, 1/2）');
  });

  it('空数组 → 空串', () => {
    expect(formatMemoryBlock([])).toBe('');
  });

  it('保持传入顺序（search 的 topK 顺序即注入顺序）', () => {
    const memories = [
      scored(1, '第一条', 'fact', new Date(2024, 11, 31), 0.9),
      scored(2, '第二条', 'decision', new Date(2024, 2, 7), 0.8)
    ];
    const block = formatMemoryBlock(memories);
    expect(block.indexOf('第一条')).toBeLessThan(block.indexOf('第二条'));
    expect(block).toContain('（fact, 12/31）');
    expect(block).toContain('（decision, 3/7）');
  });
});
