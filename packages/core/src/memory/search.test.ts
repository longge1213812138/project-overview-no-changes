/**
 * 阶段 4 任务 A2：search 检索行为测试（三层候选 + 打分，见 docs/DEV_PLAN.md §5.2）。
 * 每用例独立临时库；时间衰减用 importMany 固定时间戳 + 固定 now，断言确定。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryKind } from '../ipc';
import {
  MEMORY_KIND_WEIGHTS,
  MEMORY_TOP_K,
  closeMemoryStore,
  createMemoryStore,
  type MemoryStore
} from './index';

const stores: MemoryStore[] = [];
const dirs: string[] = [];

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-search-test-'));
  dirs.push(dir);
  return join(dir, 'fairy.db');
}

function makeStore(): MemoryStore {
  const store = createMemoryStore({ dbPath: freshDb() });
  stores.push(store);
  return store;
}

/** 固定 updatedAt，控制时间衰减 */
function seed(
  store: MemoryStore,
  items: Array<{ content: string; kind?: MemoryKind; weight?: number; updatedAt: number }>
): void {
  store.importMany(
    items.map((item) => ({
      content: item.content,
      kind: item.kind ?? 'note',
      weight: item.weight ?? 1,
      sourceSession: null,
      createdAt: item.updatedAt,
      updatedAt: item.updatedAt
    }))
  );
}

const NOW = new Date(2024, 8, 20, 12, 0, 0); // 本地 2024-09-20
const DAY = 86_400_000;
const t = (daysAgo: number): number => NOW.getTime() - daysAgo * DAY;

afterEach(() => {
  while (stores.length) closeMemoryStore(stores.pop()!);
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows 上句柄偶发未释放时忽略清理失败，不影响断言结果
    }
  }
});

describe('search 验收场景', () => {
  it('只有一条「我喝美式不加糖」时 query「我咖啡怎么喝」必须命中且 top1', () => {
    const store = makeStore();
    const rec = store.add({ content: '我喝美式不加糖' });

    const results = store.search('我咖啡怎么喝', { now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(rec.id);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('拉丁词精确命中（FTS 层，大小写不敏感）', () => {
    const store = makeStore();
    seed(store, [
      { content: '每天早上喝 espresso', updatedAt: t(1) },
      { content: '只喝茶', updatedAt: t(1) }
    ]);

    const results = store.search('espresso', { now: NOW });
    expect(results.map((m) => m.content)).toEqual(['每天早上喝 espresso']);
  });

  it('bigram LIKE 命中（存「明天交周报」查「交周报」）', () => {
    const store = makeStore();
    seed(store, [
      { content: '明天交周报', updatedAt: t(1) },
      { content: '后天开评审会', updatedAt: t(1) }
    ]);

    const results = store.search('交周报', { now: NOW });
    expect(results.map((m) => m.content)).toEqual(['明天交周报']);
  });

  it('bigram 弱命中：「交了周报」也能被「交周报」召回（bigram 词项覆盖）', () => {
    const store = makeStore();
    seed(store, [{ content: '今天交了周报', updatedAt: t(1) }]);

    const results = store.search('交周报', { now: NOW });
    expect(results.map((m) => m.content)).toEqual(['今天交了周报']);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('单字重叠的弱信号也召回（召回优先，unigram 词项 + 兜底全扫保证）', () => {
    const store = makeStore();
    // 「我咖啡怎么喝」vs「我喝美式不加糖」只有 我/喝 两个 unigram 重叠
    seed(store, [{ content: '我喝美式不加糖', updatedAt: t(1) }]);

    const results = store.search('我咖啡怎么喝', { now: NOW });
    expect(results.map((m) => m.content)).toEqual(['我喝美式不加糖']);
  });

  it('强弱信号混合：全召回但强信号排前（不丢单字重叠行）', () => {
    const store = makeStore();
    seed(store, [
      { content: '咖啡豆放冰箱', updatedAt: t(1) }, // bigram 命中，coverage 高
      { content: '我喝美式不加糖', updatedAt: t(1) } // 仅 unigram 重叠，coverage 低
    ]);

    const results = store.search('我咖啡怎么喝', { now: NOW });
    expect(results.map((m) => m.content)).toEqual(['咖啡豆放冰箱', '我喝美式不加糖']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});

describe('search 打分与排序', () => {
  it('kind 权重：同分下 preference（1.0）排在 note（0.8）前', () => {
    const store = makeStore();
    seed(store, [
      { content: '喜欢啰嗦回答', kind: 'note', updatedAt: t(1) },
      { content: '喜欢简洁回答', kind: 'preference', updatedAt: t(1) }
    ]);

    const results = store.search('喜欢回答', { now: NOW });
    expect(results.map((m) => m.kind)).toEqual(['preference', 'note']);
    expect(results[0].score).toBeCloseTo(results[1].score / MEMORY_KIND_WEIGHTS.note);
  });

  it('时间衰减 ×0.95^days：旧记忆分低于新记忆', () => {
    const store = makeStore();
    seed(store, [
      { content: '他喜欢咖啡', updatedAt: t(30) }, // 旧
      { content: '我喜欢咖啡', updatedAt: t(0) } // 新
    ]);

    const results = store.search('咖啡', { now: NOW });
    expect(results.map((m) => m.content)).toEqual(['我喜欢咖啡', '他喜欢咖啡']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    // 衰减精确：0.95^30
    expect(results[1].score / results[0].score).toBeCloseTo(Math.pow(0.95, 30), 10);
  });

  it('topK 截断（默认 MEMORY_TOP_K=8，可指定）', () => {
    const store = makeStore();
    for (let i = 0; i < 12; i++) {
      seed(store, [{ content: `咖啡偏好 ${i}`, updatedAt: t(i) }]);
    }

    expect(store.search('咖啡')).toHaveLength(MEMORY_TOP_K);
    expect(store.search('咖啡', { topK: 3 })).toHaveLength(3);
    expect(store.search('咖啡', { topK: 3, now: NOW })[0].content).toBe('咖啡偏好 0'); // 最新排前
    expect(store.search('咖啡', { topK: 0 })).toEqual([]);
  });

  it('空 query / 纯符号 → []；覆盖 0 的行不返回', () => {
    const store = makeStore();
    seed(store, [{ content: '我喝美式不加糖', updatedAt: t(1) }]);

    expect(store.search('')).toEqual([]);
    expect(store.search('   ')).toEqual([]);
    expect(store.search('！？。')).toEqual([]);
    expect(store.search('烘焙豆子的保存方法', { now: NOW })).toEqual([]); // 无任何词项重叠
  });

  it('全角归一化：全角查询命中半角内容', () => {
    const store = makeStore();
    seed(store, [{ content: 'fairy 项目用 electron', updatedAt: t(1) }]);

    const results = store.search('Ｆａｉｒｙ', { now: NOW });
    expect(results.map((m) => m.content)).toEqual(['fairy 项目用 electron']);
  });

  it('coverage 优先：命中更多词项的行排前', () => {
    const store = makeStore();
    seed(store, [
      { content: '交周报给老板', updatedAt: t(1) }, // 覆盖 交周/周报 等
      { content: '交快递', updatedAt: t(1) } // 只覆盖 交
    ]);

    const results = store.search('交周报', { now: NOW });
    expect(results.map((m) => m.content)).toEqual(['交周报给老板', '交快递']);
  });
});
