/**
 * 阶段 4 任务 A2：记忆检索（docs/DEV_PLAN.md §5.2「LIKE + bm25」）。
 *
 * 记忆量 MVP 很小 → 召回优先、排序用权重，三层候选：
 *   1. FTS5（trigram）MATCH：query 含 ≥3 字 CJK 串或 ≥2 字拉丁词时启用，记录 bm25 供并列优先；
 *   2. LIKE：query 抽取的词项逐个 content LIKE '%kw%'；
 *   3. 兜底全扫：前两层候选为空 → 全表扫描（保证单字重叠这类弱信号也能召回）。
 * 打分：coverage × kind 权重 × weight × 0.95^days（days 可负不截）。
 */

import type { Database as Db } from 'better-sqlite3';
import type { MemoryKind, MemoryRecord } from '../ipc';

/** 记忆种类（与 ipc.ts 的 MemoryKind 一一对应） */
export const MEMORY_KINDS = ['preference', 'fact', 'note', 'decision', 'topic'] as const;

/** §5.2 kind 加权：preference 1.0 / fact 0.9 / note 0.8 / decision 0.7 / topic 0.7 */
export const MEMORY_KIND_WEIGHTS: Record<MemoryKind, number> = {
  preference: 1.0,
  fact: 0.9,
  note: 0.8,
  decision: 0.7,
  topic: 0.7
};

/** §5.2 注入 top-8 */
export const MEMORY_TOP_K = 8;

export interface ScoredMemory extends MemoryRecord {
  score: number;
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

export interface MemoryRow {
  id: number;
  kind: string | null;
  content: string | null;
  source_session: string | null;
  weight: number | null;
  created_at: number | null;
  updated_at: number | null;
}

export function toMemoryRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    kind: isMemoryKind(row.kind) ? row.kind : 'note',
    content: row.content ?? '',
    sourceSession: row.source_session,
    weight: typeof row.weight === 'number' && Number.isFinite(row.weight) ? row.weight : 1.0,
    createdAt: row.created_at ?? 0,
    updatedAt: row.updated_at ?? 0
  };
}

// ===== 归一化与词项抽取 =====

/** 小写 + 全角转半角（含全角空格） */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

interface Term {
  text: string;
  /** 拉丁词 3 / bigram 2 / unigram 1 */
  weight: number;
}

function isCjkChar(ch: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch);
}

function isAlnumChar(ch: string): boolean {
  return /[a-z0-9]/.test(ch);
}

/**
 * 词项抽取：拉丁/数字段 len≥2 → 词项（权重 3）；
 * CJK 段全部 unigram（权重 1）+ bigram（权重 2）。同文本去重（保留较高权重）。
 */
export function extractTerms(query: string): Term[] {
  const norm = normalizeQuery(query);
  const found = new Map<string, number>();
  const put = (text: string, weight: number): void => {
    const prev = found.get(text);
    if (prev === undefined || prev < weight) found.set(text, weight);
  };

  let i = 0;
  while (i < norm.length) {
    const ch = norm[i]!;
    if (isAlnumChar(ch)) {
      let j = i;
      while (j < norm.length && isAlnumChar(norm[j]!)) j++;
      const word = norm.slice(i, j);
      if (word.length >= 2) put(word, 3);
      i = j;
    } else if (isCjkChar(ch)) {
      let j = i;
      while (j < norm.length && isCjkChar(norm[j]!)) j++;
      const run = norm.slice(i, j);
      for (let k = 0; k < run.length; k++) put(run[k]!, 1);
      for (let k = 0; k + 1 < run.length; k++) put(run.slice(k, k + 2), 2);
      i = j;
    } else {
      i++;
    }
  }
  return [...found.entries()].map(([text, weight]) => ({ text, weight }));
}

/**
 * FTS5 短语：≥3 字符连续 CJK 串、≥2 字符拉丁词（trigram 要求 ≥3 字符才可 MATCH，
 * 短于 3 的短语查不到结果但不会报错，直接不送更干净）。
 */
export function extractFtsPhrases(query: string): string[] {
  const norm = normalizeQuery(query);
  const phrases: string[] = [];
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i]!;
    if (isAlnumChar(ch)) {
      let j = i;
      while (j < norm.length && isAlnumChar(norm[j]!)) j++;
      const word = norm.slice(i, j);
      if (word.length >= 3) phrases.push(word);
      i = j;
    } else if (isCjkChar(ch)) {
      let j = i;
      while (j < norm.length && isCjkChar(norm[j]!)) j++;
      const run = norm.slice(i, j);
      if (run.length >= 3) phrases.push(run);
      i = j;
    } else {
      i++;
    }
  }
  return phrases;
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// ===== 三层候选 + 打分 =====

interface Candidate {
  record: MemoryRecord;
  /** -bm25(memory_fts)：越大越相关；无 FTS 命中则缺省 */
  bm25?: number;
}

function selectById(db: Db, id: number): MemoryRecord | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
  return row ? toMemoryRecord(row) : null;
}

/**
 * 记忆检索：query 空 / 无可抽取词项 → []；否则三层候选 + 统一打分，
 * score<=0 过滤，排序 score 降序 → bm25 降序（FTS 命中者并列优先）→ updatedAt 降序，取 topK。
 */
export function searchMemories(
  db: Db,
  query: string,
  opts?: { topK?: number; now?: Date }
): ScoredMemory[] {
  const topK = opts?.topK ?? MEMORY_TOP_K;
  const nowMs = (opts?.now ?? new Date()).getTime();
  if (typeof query !== 'string' || query.trim() === '') return [];
  const terms = extractTerms(query);
  if (terms.length === 0) return [];

  const candidates = new Map<number, Candidate>();
  const putRecord = (record: MemoryRecord, bm25?: number): void => {
    const existing = candidates.get(record.id);
    if (existing) {
      if (existing.bm25 === undefined && bm25 !== undefined) existing.bm25 = bm25;
      return;
    }
    candidates.set(record.id, bm25 === undefined ? { record } : { record, bm25 });
  };

  // 1) FTS5 候选（trigram phrase；拉丁词/≥3 字 CJK 串双引号精确）
  const phrases = extractFtsPhrases(query);
  if (phrases.length > 0) {
    const match = phrases.map((p) => `"${p.replace(/"/g, '""')}"`).join(' OR ');
    try {
      const rows = db
        .prepare('SELECT rowid AS id, bm25(memory_fts) AS b FROM memory_fts WHERE memory_fts MATCH ?')
        .all(match) as Array<{ id: number; b: number }>;
      for (const row of rows) {
        const record = selectById(db, row.id);
        // bm25() 越小越相关 → 取负后越大越相关，排序处统一「降序」
        if (record) putRecord(record, -row.b);
      }
    } catch {
      // MATCH 语法异常（特殊符号等）→ 忽略该层，靠下层召回
    }
  }

  // 2) LIKE 候选：词项逐个 content LIKE '%kw%'（大小写不敏感）
  const likeSql = "SELECT * FROM memories WHERE lower(content) LIKE ? ESCAPE '\\'";
  for (const term of terms) {
    const rows = db.prepare(likeSql).all(`%${escapeLike(term.text)}%`) as MemoryRow[];
    for (const row of rows) putRecord(toMemoryRecord(row));
  }

  // 3) 兜底全扫：保证召回（如「我咖啡怎么喝」→「我喝美式不加糖」只有单字重叠的弱信号）
  if (candidates.size === 0) {
    for (const row of db.prepare('SELECT * FROM memories').all() as MemoryRow[]) {
      putRecord(toMemoryRecord(row));
    }
  }

  // 打分（候选行统一算）
  const totalWeight = terms.reduce((sum, t) => sum + t.weight, 0);
  const scored: Array<ScoredMemory & { bm25?: number }> = [];
  for (const candidate of candidates.values()) {
    const { record } = candidate;
    const lower = record.content.toLowerCase();
    let hitWeight = 0;
    for (const term of terms) {
      if (lower.includes(term.text)) hitWeight += term.weight;
    }
    const coverage = totalWeight > 0 ? hitWeight / totalWeight : 0;
    const kindWeight = MEMORY_KIND_WEIGHTS[record.kind] ?? 1.0;
    const days = (nowMs - record.updatedAt) / 86_400_000;
    const score = coverage * kindWeight * record.weight * Math.pow(0.95, days);
    if (!(score > 0)) continue;
    scored.push(
      candidate.bm25 === undefined
        ? { ...record, score }
        : { ...record, score, bm25: candidate.bm25 }
    );
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const aBm25 = a.bm25 ?? Number.NEGATIVE_INFINITY;
    const bBm25 = b.bm25 ?? Number.NEGATIVE_INFINITY;
    if (aBm25 !== bBm25) return bBm25 - aBm25;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return b.id - a.id;
  });

  return scored.slice(0, Math.max(0, topK)).map(({ bm25: _bm25, ...record }) => record as ScoredMemory);
}
