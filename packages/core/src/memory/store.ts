/**
 * 阶段 4 任务 A2：记忆存储（SQLite memories + memory_fts，见 docs/DEV_PLAN.md §7）。
 * 类型复用 ipc.ts 的 MemoryKind / MemoryRecord / MemoryListFilter / MemoryImportResult（契约冻结）。
 * FTS 同步由迁移 v2 的触发器（memories_ai/ad/au）保证，本层只管 memories 表。
 */

import type { Database as Db } from 'better-sqlite3';
import type {
  MemoryImportResult,
  MemoryKind,
  MemoryListFilter,
  MemoryRecord
} from '../ipc';
import { openDatabase } from '../store';
import {
  isMemoryKind,
  searchMemories,
  toMemoryRecord,
  type MemoryRow,
  type ScoredMemory
} from './search';

export interface MemoryStore {
  /** kind 默认 'note'；完全相同 content 已存在 → 不重复插，刷新 updatedAt 返回既有行 */
  add(input: {
    content: string;
    kind?: MemoryKind;
    sourceSession?: string | null;
    weight?: number;
  }): MemoryRecord;
  /** kind='all' 或缺省=全部；query=content 子串（LIKE，大小写不敏感）；limit 默认 200；updated_at DESC */
  list(filter?: MemoryListFilter): MemoryRecord[];
  /** 不存在 id 抛错 */
  update(id: number, patch: { content?: string; kind?: MemoryKind; weight?: number }): void;
  /** 不存在静默 */
  remove(id: number): void;
  /** content LIKE %keyword%（trim 后非空才执行），返回删除行数 */
  removeByKeyword(keyword: string): number;
  /** id 升序全量 */
  exportAll(): MemoryRecord[];
  /** 入参任意值：非数组整体拒绝；逐项校验（非法计 errors 不中断）；content 完全相同去重跳过 */
  importMany(raw: unknown): MemoryImportResult;
  search(query: string, opts?: { topK?: number; now?: Date }): ScoredMemory[];
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function optionalWeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 1.0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

const openDbs = new WeakMap<MemoryStore, Db>();

/**
 * 附加设施（非契约 API）：关闭底层 SQLite 句柄。
 * Windows 上删除临时测试目录前必须先关句柄，退出时也可用。
 */
export function closeMemoryStore(store: MemoryStore): void {
  const db = openDbs.get(store);
  if (db && db.open) db.close();
}

export function createMemoryStore(opts: { dbPath: string }): MemoryStore {
  const db = openDatabase(opts.dbPath);

  function findByContent(content: string): MemoryRecord | null {
    const row = db.prepare('SELECT * FROM memories WHERE content = ? LIMIT 1').get(content) as
      | MemoryRow
      | undefined;
    return row ? toMemoryRecord(row) : null;
  }

  const store: MemoryStore = {
    add(input) {
      const content = requireText(input.content, 'add: content');
      const kind = input.kind ?? 'note';
      if (!isMemoryKind(kind)) {
        throw new Error(`add: kind 非法（${String(input.kind)}）`);
      }
      const weight = optionalWeight(input.weight);
      const sourceSession = typeof input.sourceSession === 'string' ? input.sourceSession : null;

      const existing = findByContent(content);
      const now = Date.now();
      if (existing) {
        db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(now, existing.id);
        return { ...existing, updatedAt: now };
      }

      const info = db
        .prepare(
          'INSERT INTO memories(kind, content, source_session, weight, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
        )
        .run(kind, content, sourceSession, weight, now, now);
      return {
        id: Number(info.lastInsertRowid),
        kind,
        content,
        sourceSession,
        weight,
        createdAt: now,
        updatedAt: now
      };
    },

    list(filter) {
      const kind = filter?.kind ?? 'all';
      const limit = filter?.limit ?? 200;
      if (limit <= 0) return [];
      const query = typeof filter?.query === 'string' ? filter.query.trim() : '';

      const where: string[] = [];
      const params: Array<string | number> = [];
      if (kind !== 'all') {
        where.push('kind = ?');
        params.push(kind);
      }
      if (query !== '') {
        where.push("lower(content) LIKE ? ESCAPE '\\'");
        params.push(`%${escapeLike(query.toLowerCase())}%`);
      }
      const sql =
        `SELECT * FROM memories${where.length ? ` WHERE ${where.join(' AND ')}` : ''}` +
        ' ORDER BY updated_at DESC, id DESC LIMIT ?';
      params.push(limit);
      return (db.prepare(sql).all(...params) as MemoryRow[]).map(toMemoryRecord);
    },

    update(id, patch) {
      const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(id) as
        | { id: number }
        | undefined;
      if (!existing) {
        throw new Error(`update: 记忆不存在: ${id}`);
      }

      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (patch.content !== undefined) {
        sets.push('content = ?');
        params.push(requireText(patch.content, 'update: content'));
      }
      if (patch.kind !== undefined) {
        if (!isMemoryKind(patch.kind)) {
          throw new Error(`update: kind 非法（${String(patch.kind)}）`);
        }
        sets.push('kind = ?');
        params.push(patch.kind);
      }
      if (patch.weight !== undefined) {
        if (!isFiniteNumber(patch.weight)) {
          throw new Error('update: weight 必须是有效数字');
        }
        sets.push('weight = ?');
        params.push(patch.weight);
      }
      sets.push('updated_at = ?');
      params.push(Date.now(), id);
      db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    },

    remove(id) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    },

    removeByKeyword(keyword) {
      const kw = typeof keyword === 'string' ? keyword.trim() : '';
      if (kw === '') return 0;
      const info = db
        .prepare("DELETE FROM memories WHERE lower(content) LIKE ? ESCAPE '\\'")
        .run(`%${escapeLike(kw.toLowerCase())}%`);
      return info.changes;
    },

    exportAll() {
      const rows = db.prepare('SELECT * FROM memories ORDER BY id ASC').all() as MemoryRow[];
      return rows.map(toMemoryRecord);
    },

    importMany(raw) {
      if (!Array.isArray(raw)) {
        return { imported: 0, skipped: 0, errors: ['不是合法的 JSON 数组'] };
      }
      const result: MemoryImportResult = { imported: 0, skipped: 0, errors: [] };
      const now = Date.now();

      for (let i = 0; i < raw.length; i++) {
        const item: unknown = raw[i];
        const label = `第 ${i + 1} 条`;
        if (item === null || typeof item !== 'object') {
          result.errors.push(`${label}: 不是对象`);
          continue;
        }
        const rec = item as Record<string, unknown>;
        if (typeof rec.content !== 'string' || rec.content.trim() === '') {
          result.errors.push(`${label}: content 非法`);
          continue;
        }
        if (!isMemoryKind(rec.kind)) {
          result.errors.push(`${label}: kind 非法`);
          continue;
        }
        if (findByContent(rec.content)) {
          result.skipped += 1;
          continue;
        }

        db.prepare(
          'INSERT INTO memories(kind, content, source_session, weight, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
        ).run(
          rec.kind,
          rec.content,
          typeof rec.sourceSession === 'string' ? rec.sourceSession : null,
          isFiniteNumber(rec.weight) ? rec.weight : 1.0,
          isFiniteNumber(rec.createdAt) ? rec.createdAt : now,
          isFiniteNumber(rec.updatedAt) ? rec.updatedAt : now
        );
        result.imported += 1;
      }
      return result;
    },

    search(query, searchOpts) {
      return searchMemories(db, query, searchOpts);
    }
  };

  openDbs.set(store, db);
  return store;
}
