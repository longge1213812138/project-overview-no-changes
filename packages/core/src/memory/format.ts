/**
 * 阶段 4 任务 A2：记忆注入块（docs/DEV_PLAN.md §5.2 格式）。
 * 记忆由 main 拼进 systemExtra；日期 = updatedAt 的 M/D。
 */

import type { ScoredMemory } from './search';

/** 注入块（§5.2 格式），空数组返回 '' */
export function formatMemoryBlock(memories: ScoredMemory[]): string {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const lines = memories.map((memory) => {
    const date = new Date(memory.updatedAt);
    const md = `${date.getMonth() + 1}/${date.getDate()}`;
    return `- ${memory.content}（${memory.kind}, ${md}）`;
  });
  return ['【关于这个用户】', ...lines].join('\n');
}
