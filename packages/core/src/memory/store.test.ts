/**
 * 阶段 4 任务 A2：MemoryStore（SQLite memories + FTS 同步触发器）行为测试。
 * 每用例独立临时库（mkdtempSync）；afterEach 关句柄 + 清理。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeMemoryStore,
  createMemoryStore,
  type MemoryStore
} from './index';

const stores: MemoryStore[] = [];
const dirs: string[] = [];

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-memory-test-'));
  dirs.push(dir);
  return join(dir, 'fairy.db');
}

function makeStore(dbPath?: string): MemoryStore {
  const store = createMemoryStore({ dbPath: dbPath ?? freshDb() });
  stores.push(store);
  return store;
}

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

describe('add', () => {
  it('默认 kind=note、weight=1.0、sourceSession=null，返回完整行', () => {
    const store = makeStore();
    const rec = store.add({ content: '我喝美式不加糖' });

    expect(rec.id).toBeGreaterThan(0);
    expect(rec.kind).toBe('note');
    expect(rec.content).toBe('我喝美式不加糖');
    expect(rec.sourceSession).toBeNull();
    expect(rec.weight).toBe(1);
    expect(rec.createdAt).toBeGreaterThan(0);
    expect(rec.updatedAt).toBe(rec.createdAt);

    const full = store.add({ content: '喜欢简洁回答', kind: 'preference', sourceSession: 's1', weight: 0.5 });
    expect(full).toMatchObject({ kind: 'preference', sourceSession: 's1', weight: 0.5 });
  });

  it('完全相同 content 已存在 → 不重复插，刷新 updatedAt 返回既有行', async () => {
    const store = makeStore();
    const first = store.add({ content: '在写 Fairy 项目', kind: 'topic' });
    await new Promise((r) => setTimeout(r, 5));

    const again = store.add({ content: '在写 Fairy 项目', kind: 'fact', weight: 3 });
    expect(again.id).toBe(first.id);
    expect(again.kind).toBe('topic'); // 既有行原样（kind/weight 不被覆盖）
    expect(again.weight).toBe(1);
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(store.list()).toHaveLength(1);
  });

  it('content 空 / kind 非法抛错，不写库', () => {
    const store = makeStore();
    expect(() => store.add({ content: '   ' })).toThrow(/content/);
    expect(() => store.add({ content: 'x', kind: 'nope' as never })).toThrow(/kind/);
    expect(store.list()).toHaveLength(0);
  });
});

describe('list', () => {
  it('kind 筛选 / query 子串（大小写不敏感）/ limit / updated_at DESC', () => {
    const store = makeStore();
    const a = store.add({ content: '喜欢简洁回答', kind: 'preference' });
    const b = store.add({ content: '在写 Fairy 项目', kind: 'topic' });
    const c = store.add({ content: '用 TypeScript 写代码', kind: 'note' });
    expect(store.list().map((m) => m.id)).toEqual([c.id, b.id, a.id]); // updated_at DESC（同毫秒按 id DESC）

    expect(store.list({ kind: 'preference' }).map((m) => m.id)).toEqual([a.id]);
    expect(store.list({ kind: 'all' }).map((m) => m.id)).toEqual([c.id, b.id, a.id]);
    expect(store.list({ query: 'fairy' }).map((m) => m.id)).toEqual([b.id]); // 大小写不敏感
    expect(store.list({ query: 'Fairy 项' }).map((m) => m.id)).toEqual([b.id]); // 子串
    expect(store.list({ query: '不存在的词' })).toEqual([]);
    expect(store.list({ limit: 2 }).map((m) => m.id)).toEqual([c.id, b.id]);
    expect(store.list({ limit: 0 })).toEqual([]);
  });

  it('limit 默认 200', () => {
    const store = makeStore();
    for (let i = 0; i < 205; i++) store.add({ content: `记忆 ${i}` });
    expect(store.list()).toHaveLength(200);
    expect(store.list({ limit: 205 })).toHaveLength(205);
  });
});

describe('update / remove / removeByKeyword', () => {
  it('update 改 content/kind/weight，未给字段不动；不存在 id 抛错', () => {
    const store = makeStore();
    const rec = store.add({ content: '旧内容', kind: 'note' });

    store.update(rec.id, { content: '新内容', kind: 'fact', weight: 0.7 });
    expect(store.list()[0]).toMatchObject({ content: '新内容', kind: 'fact', weight: 0.7 });

    store.update(rec.id, { kind: 'decision' });
    expect(store.list()[0]).toMatchObject({ content: '新内容', kind: 'decision', weight: 0.7 });

    expect(() => store.update(999, { content: 'x' })).toThrow(/不存在/);
  });

  it('remove 不存在静默；removeByKeyword 返回删除行数，trim 后空不执行', () => {
    const store = makeStore();
    store.add({ content: '咖啡一天两杯' });
    const b = store.add({ content: '茶也喝' });
    store.add({ content: '咖啡换成拿铁' });

    expect(store.removeByKeyword('  ')).toBe(0); // trim 后空 → 不删
    expect(store.list()).toHaveLength(3);
    expect(store.removeByKeyword('咖啡 ')).toBe(2); // trim 后按「咖啡」删 2 行
    expect(store.list().map((m) => m.id)).toEqual([b.id]);

    store.remove(b.id);
    expect(store.list()).toEqual([]);
    expect(() => store.remove(b.id)).not.toThrow(); // 不存在静默
    expect(store.removeByKeyword('无此项')).toBe(0);
  });
});

describe('exportAll / importMany', () => {
  it('exportAll id 升序全量；importMany 数组校验、单项非法不中断', () => {
    const store = makeStore();
    store.add({ content: '第一条', kind: 'note' });
    store.add({ content: '第二条', kind: 'fact' });
    const exported = store.exportAll();
    expect(exported.map((m) => m.id)).toEqual([1, 2]);
    expect(exported[1]).toMatchObject({ content: '第二条', kind: 'fact' });

    // 非数组整体拒绝
    expect(store.importMany('nope')).toEqual({
      imported: 0,
      skipped: 0,
      errors: ['不是合法的 JSON 数组']
    });
    expect(store.importMany(null)).toEqual({
      imported: 0,
      skipped: 0,
      errors: ['不是合法的 JSON 数组']
    });

    // 单项非法 → errors 计一条不中断
    const result = store.importMany([
      { content: '导入的偏好', kind: 'preference' },
      { content: '', kind: 'note' }, // content 非法
      { content: 'kind 错了', kind: 'unknown' }, // kind 非法
      'not-an-object', // 非对象
      { content: '导入的事实', kind: 'fact' }
    ]);
    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(3);
    expect(store.list({ limit: 10 }).map((m) => m.content)).toContain('导入的偏好');
    expect(store.list({ limit: 10 }).map((m) => m.content)).toContain('导入的事实');
  });

  it('importMany 按 content 完全相同去重跳过（库内已有 + 批内重复）', () => {
    const store = makeStore();
    store.add({ content: '已存在' });

    const result = store.importMany([
      { content: '已存在', kind: 'note' },
      { content: '新记忆', kind: 'topic' },
      { content: '新记忆', kind: 'topic' }
    ]);
    expect(result).toEqual({ imported: 1, skipped: 2, errors: [] });
    expect(store.list().map((m) => m.content).sort()).toEqual(['已存在', '新记忆']);
  });

  it('importMany 导入行字段兜底：sourceSession 非字符串→null、weight 非法→1.0、时间戳非法→now', () => {
    const store = makeStore();
    const before = Date.now();
    const result = store.importMany([
      {
        content: '字段兜底',
        kind: 'decision',
        sourceSession: 123,
        weight: 'heavy',
        createdAt: 'yesterday',
        updatedAt: null
      },
      {
        content: '字段有效',
        kind: 'fact',
        sourceSession: 'sess-1',
        weight: 0.5,
        createdAt: 1000,
        updatedAt: 2000
      }
    ]);
    expect(result).toEqual({ imported: 2, skipped: 0, errors: [] });

    const rows = store.list({ limit: 10 });
    const fallback = rows.find((m) => m.content === '字段兜底')!;
    expect(fallback).toMatchObject({ kind: 'decision', sourceSession: null, weight: 1 });
    expect(fallback.createdAt).toBeGreaterThanOrEqual(before);
    expect(fallback.updatedAt).toBeGreaterThanOrEqual(before);

    const valid = rows.find((m) => m.content === '字段有效')!;
    expect(valid).toMatchObject({
      kind: 'fact',
      sourceSession: 'sess-1',
      weight: 0.5,
      createdAt: 1000,
      updatedAt: 2000
    });
  });
});

describe('FTS 同步（trigram，触发器 memories_ai/ad/au）', () => {
  /** 直接数 memory_fts MATCH 命中，验证索引与表同步 */
  function ftsCount(dbPath: string, phrase: string): number {
    const raw = new Database(dbPath);
    try {
      const row = raw
        .prepare('SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH ?')
        .get(`"${phrase}"`) as { n: number };
      return row.n;
    } finally {
      raw.close();
    }
  }

  it('add → 命中；update(content) → 旧词不再命中、新词命中；remove → 不再命中', () => {
    const dbPath = freshDb();
    const store = makeStore(dbPath);

    const rec = store.add({ content: '我喝美式不加糖' });
    expect(ftsCount(dbPath, '美式不加')).toBe(1);
    expect(store.search('美式不加').map((m) => m.id)).toEqual([rec.id]);

    store.update(rec.id, { content: '我喝拿铁少糖' });
    expect(ftsCount(dbPath, '美式不加')).toBe(0); // 旧词不再命中
    expect(ftsCount(dbPath, '拿铁少糖')).toBe(1); // 新词命中
    expect(store.search('拿铁少糖').map((m) => m.id)).toEqual([rec.id]);
    expect(store.search('美式不加').map((m) => m.id)).toEqual([]);

    store.remove(rec.id);
    expect(ftsCount(dbPath, '拿铁少糖')).toBe(0);
    expect(store.search('拿铁少糖')).toEqual([]);
    expect(ftsCount(dbPath, '美式不加')).toBe(0);
  });

  it('仅改 kind/weight 的 update 也保持 FTS 内容一致（delete+重插同内容）', () => {
    const dbPath = freshDb();
    const store = makeStore(dbPath);
    const rec = store.add({ content: '明天交周报' });

    store.update(rec.id, { kind: 'decision', weight: 0.5 });
    expect(ftsCount(dbPath, '明天交周')).toBe(1);
    expect(store.search('明天交周报').map((m) => m.id)).toEqual([rec.id]);
    expect(store.search('拿铁').map((m) => m.id)).toEqual([]);
  });
});
