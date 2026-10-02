/**
 * 阶段 3 任务 A：会话存储（SQLite 落库 + 会话 CRUD + 上下文组装）。
 * 类型复用 ipc.ts 的 SessionMeta / MessageDto / QUICK_SESSION_ID（契约冻结）。
 */

import { randomUUID } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type { MessageDto, SessionMeta } from '../ipc';
import { QUICK_SESSION_ID } from '../ipc';
import type { ChatMessage } from '../llm/types';
import { openDatabase } from '../store';
import { CONTEXT_BUDGET_CHARS, FAIRY_SYSTEM_PROMPT, trimToBudget } from './trim';

export interface SessionStore {
  /** updatedAt 降序 */
  listSessions(): SessionMeta[];
  /** uuid（node:crypto randomUUID） */
  createSession(kind?: 'chat'): SessionMeta;
  /** id = QUICK_SESSION_ID，已存在则返回 */
  ensureQuickSession(): SessionMeta;
  /** 级联删 messages（事务） */
  removeSession(id: string): void;
  getSession(id: string): SessionMeta | null;
  appendMessage(input: {
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    meta?: Record<string, unknown>;
  }): MessageDto;
  updateMessage(id: number, patch: { content?: string; meta?: Record<string, unknown> }): void;
  /** 升序；limit = 最新 N 条后升序返回 */
  listMessages(sessionId: string, limit?: number): MessageDto[];
  /** FAIRY_SYSTEM_PROMPT +（systemExtra 非空则 \n\n+systemExtra，记忆块由 main 拼入）+ trimToBudget 的历史 */
  buildContext(sessionId: string, opts?: { systemExtra?: string }): ChatMessage[];
}

interface SessionRow {
  id: string;
  title: string | null;
  kind: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  meta: string | null;
  created_at: number;
}

function toSessionMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    title: row.title ?? '',
    kind: row.kind === 'quick' ? 'quick' : 'chat',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** 坏 JSON → null，不抛 */
function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toMessageDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content ?? '',
    meta: parseMeta(row.meta),
    createdAt: row.created_at
  };
}

/** 首条 user 消息：取 content 首行截 20 字符（超出加 …） */
function deriveTitle(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.length > 20 ? firstLine.slice(0, 20) + '…' : firstLine;
}

const openDbs = new WeakMap<SessionStore, Db>();

/**
 * 附加设施（非契约 API）：关闭底层 SQLite 句柄。
 * Windows 上删除临时测试目录前必须先关句柄，退出时也可用。
 */
export function closeSessionStore(store: SessionStore): void {
  const db = openDbs.get(store);
  if (db && db.open) db.close();
}

export function createSessionStore(opts: { dbPath: string }): SessionStore {
  const db = openDatabase(opts.dbPath);

  function getSessionRow(id: string): SessionRow | undefined {
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  const store: SessionStore = {
    listSessions() {
      const rows = db
        .prepare('SELECT * FROM sessions ORDER BY updated_at DESC, rowid DESC')
        .all() as SessionRow[];
      return rows.map(toSessionMeta);
    },

    createSession(kind: 'chat' = 'chat') {
      const id = randomUUID();
      const now = Date.now();
      db.prepare(
        'INSERT INTO sessions(id, title, kind, created_at, updated_at) VALUES(?, ?, ?, ?, ?)'
      ).run(id, '', kind, now, now);
      return { id, title: '', kind, createdAt: now, updatedAt: now };
    },

    ensureQuickSession() {
      const existing = getSessionRow(QUICK_SESSION_ID);
      if (existing) return toSessionMeta(existing);
      const now = Date.now();
      db.prepare(
        'INSERT INTO sessions(id, title, kind, created_at, updated_at) VALUES(?, ?, ?, ?, ?)'
      ).run(QUICK_SESSION_ID, '快速问答', 'quick', now, now);
      return {
        id: QUICK_SESSION_ID,
        title: '快速问答',
        kind: 'quick' as const,
        createdAt: now,
        updatedAt: now
      };
    },

    removeSession(id) {
      db.transaction(() => {
        db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
        db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      })();
    },

    getSession(id) {
      const row = getSessionRow(id);
      return row ? toSessionMeta(row) : null;
    },

    appendMessage(input) {
      const row = getSessionRow(input.sessionId);
      if (!row) {
        throw new Error(`appendMessage: 会话不存在: ${input.sessionId}`);
      }
      const meta = input.meta ?? null;
      const metaJson = meta ? JSON.stringify(meta) : null;
      const now = Date.now();
      const title =
        input.role === 'user' && (row.title ?? '') === '' ? deriveTitle(input.content) : null;

      let saved!: MessageDto;
      db.transaction(() => {
        const info = db
          .prepare(
            'INSERT INTO messages(session_id, role, content, meta, created_at) VALUES(?, ?, ?, ?, ?)'
          )
          .run(input.sessionId, input.role, input.content, metaJson, now);
        if (title !== null) {
          db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(
            title,
            now,
            input.sessionId
          );
        } else {
          db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId);
        }
        saved = {
          id: Number(info.lastInsertRowid),
          sessionId: input.sessionId,
          role: input.role,
          content: input.content,
          meta,
          createdAt: now
        };
      })();
      return saved;
    },

    updateMessage(id, patch) {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      if (patch.content !== undefined) {
        sets.push('content = ?');
        params.push(patch.content);
      }
      if (patch.meta !== undefined) {
        sets.push('meta = ?');
        params.push(JSON.stringify(patch.meta));
      }
      if (sets.length === 0) return;
      params.push(id);
      db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    },

    listMessages(sessionId, limit) {
      if (limit !== undefined && limit <= 0) return [];
      if (limit === undefined) {
        const rows = db
          .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
          .all(sessionId) as MessageRow[];
        return rows.map(toMessageDto);
      }
      const rows = db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
        .all(sessionId, limit) as MessageRow[];
      return rows.reverse().map(toMessageDto);
    },

    buildContext(sessionId, opts) {
      const rows = db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
        .all(sessionId) as MessageRow[];
      const history: ChatMessage[] = [];
      for (const row of rows) {
        const content = row.content ?? '';
        if (content.trim() === '') continue;
        history.push({ role: row.role === 'assistant' ? 'assistant' : 'user', content });
      }
      const systemExtra = opts?.systemExtra;
      const system =
        systemExtra != null && systemExtra.trim() !== ''
          ? `${FAIRY_SYSTEM_PROMPT}\n\n${systemExtra}`
          : FAIRY_SYSTEM_PROMPT;
      return trimToBudget(history, system, CONTEXT_BUDGET_CHARS);
    }
  };

  openDbs.set(store, db);
  return store;
}
