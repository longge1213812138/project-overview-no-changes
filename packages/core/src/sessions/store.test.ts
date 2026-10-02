/**
 * 阶段 3 任务 A：SessionStore（SQLite）行为测试。
 * 每个用例独立临时库（mkdtempSync），用例间不共享 db 文件；afterEach 关句柄 + 清理。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { QUICK_SESSION_ID } from '../ipc';
import { LATEST_SCHEMA_VERSION, openDatabase } from '../store';
import {
  CONTEXT_BUDGET_CHARS,
  FAIRY_SYSTEM_PROMPT,
  closeSessionStore,
  createSessionStore,
  type SessionStore
} from './index';

const stores: SessionStore[] = [];
const dirs: string[] = [];

/** 每个用例独立临时 db 文件 */
function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-store-test-'));
  dirs.push(dir);
  return join(dir, 'fairy.db');
}

function makeStore(dbPath: string): SessionStore {
  const store = createSessionStore({ dbPath });
  stores.push(store);
  return store;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  while (stores.length) closeSessionStore(stores.pop()!);
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows 上句柄偶发未释放时忽略清理失败，不影响断言结果
    }
  }
});

describe('建库与迁移', () => {
  it('首次建库：schema_version=LATEST_SCHEMA_VERSION，§7 表结构齐全', () => {
    const dbPath = freshDb();
    makeStore(dbPath);

    const raw = openDatabase(dbPath);
    const version = raw.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get() as {
      v: string;
    };
    expect(version.v).toBe(String(LATEST_SCHEMA_VERSION));
    const tables = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['sessions', 'messages', 'kv']));
    const index = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_session'")
      .get();
    expect(index).toBeTruthy();
    raw.close();
  });

  it('同文件二次 open 幂等（并发双开 + 关闭后重开均不报错）', () => {
    const dbPath = freshDb();
    const store1 = makeStore(dbPath);
    const session = store1.createSession();
    store1.appendMessage({ sessionId: session.id, role: 'user', content: '你好' });

    const store2 = makeStore(dbPath); // 并发二次 open
    expect(store2.listSessions()).toHaveLength(1);
    closeSessionStore(store2);

    const store3 = makeStore(dbPath); // 关闭后重开，迁移幂等
    expect(store3.listMessages(session.id)).toHaveLength(1);
  });

  it('手工把 schema_version 写成未来版本 → createSessionStore 抛错且不覆盖数据', () => {
    const FUTURE_SCHEMA_VERSION = 99;
    expect(FUTURE_SCHEMA_VERSION).toBeGreaterThan(LATEST_SCHEMA_VERSION); // 前提：高于已知版本

    const dbPath = freshDb();
    const setup = openDatabase(dbPath);
    setup
      .prepare("UPDATE kv SET v = ? WHERE k = 'schema_version'")
      .run(String(FUTURE_SCHEMA_VERSION));
    setup.close();

    expect(() => createSessionStore({ dbPath })).toThrow(
      new RegExp(String(FUTURE_SCHEMA_VERSION))
    );

    // fail-visible：版本号原样保留，绝不写覆盖
    const check = new Database(dbPath);
    const row = check.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get() as { v: string };
    expect(row.v).toBe(String(FUTURE_SCHEMA_VERSION));
    check.close();
  });
});

describe('会话 CRUD', () => {
  it('create/list 排序（updatedAt 降序）、get、remove 级联删 messages', async () => {
    const dbPath = freshDb();
    const store = makeStore(dbPath);

    const s1 = store.createSession();
    await sleep(3);
    const s2 = store.createSession();
    await sleep(3);
    const s3 = store.createSession();

    expect(s1.title).toBe('');
    expect(s1.kind).toBe('chat');
    expect(s1.id).not.toBe(s2.id); // uuid 唯一
    expect(store.listSessions().map((s) => s.id)).toEqual([s3.id, s2.id, s1.id]);

    const got = store.getSession(s2.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(s2.id);
    expect(got!.title).toBe('');

    // appendMessage 刷新 updatedAt → s1 升到最前
    await sleep(3);
    store.appendMessage({ sessionId: s1.id, role: 'user', content: 'hi' });
    expect(store.listSessions().map((s) => s.id)).toEqual([s1.id, s3.id, s2.id]);

    // remove 级联删 messages
    store.appendMessage({ sessionId: s1.id, role: 'assistant', content: 'hello' });
    const raw = new Database(dbPath);
    const countMsgs = (): number =>
      (raw.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(s1.id) as {
        n: number;
      }).n;
    expect(countMsgs()).toBe(2);
    store.removeSession(s1.id);
    expect(countMsgs()).toBe(0);
    expect(store.getSession(s1.id)).toBeNull();

    // 不存在的 sessionId：get→null、list→[]、append→抛错
    expect(store.getSession('nope')).toBeNull();
    expect(store.listMessages('nope')).toEqual([]);
    expect(() =>
      store.appendMessage({ sessionId: 'nope', role: 'user', content: 'x' })
    ).toThrow(/不存在/);
    raw.close();
  });
});

describe('ensureQuickSession', () => {
  it('两次调用同 id，kind=quick、固定标题', () => {
    const store = makeStore(freshDb());
    const q1 = store.ensureQuickSession();
    const q2 = store.ensureQuickSession();

    expect(q1.id).toBe(QUICK_SESSION_ID);
    expect(q2.id).toBe(QUICK_SESSION_ID);
    expect(q1.kind).toBe('quick');
    expect(q1.title).toBe('快速问答');
    expect(store.listSessions()).toHaveLength(1);
  });
});

describe('appendMessage / updateMessage', () => {
  it('appendMessage 同步刷新 sessions.updatedAt', async () => {
    const store = makeStore(freshDb());
    const s = store.createSession();
    await sleep(3);
    const msg = store.appendMessage({ sessionId: s.id, role: 'user', content: 'hi' });

    const after = store.getSession(s.id)!;
    expect(after.updatedAt).toBeGreaterThan(s.updatedAt);
    expect(msg.id).toBeGreaterThan(0);
    expect(msg.sessionId).toBe(s.id);
    expect(msg.createdAt).toBeGreaterThanOrEqual(s.updatedAt);
  });

  it('首条 user 消息自动生成标题：首行截 20 字符，超出加 …', () => {
    const store = makeStore(freshDb());
    const s = store.createSession();
    const long = '这一行非常长肯定会超过二十个字符所以要截断结尾\n第二行内容';
    store.appendMessage({ sessionId: s.id, role: 'user', content: long });

    const title = store.getSession(s.id)!.title;
    expect(title).toBe(long.split('\n')[0].slice(0, 20) + '…');
    expect(title).toHaveLength(21);
    expect(title.endsWith('…')).toBe(true);

    // 恰好 20 字符不加省略号
    const s2 = store.createSession();
    store.appendMessage({ sessionId: s2.id, role: 'user', content: 'x'.repeat(20) });
    expect(store.getSession(s2.id)!.title).toBe('x'.repeat(20));
  });

  it('assistant 消息不改标题，后续 user 也不覆盖标题', () => {
    const store = makeStore(freshDb());
    const s = store.createSession();

    store.appendMessage({ sessionId: s.id, role: 'assistant', content: '先说话' });
    expect(store.getSession(s.id)!.title).toBe('');

    store.appendMessage({ sessionId: s.id, role: 'user', content: '你好世界' });
    expect(store.getSession(s.id)!.title).toBe('你好世界');

    store.appendMessage({ sessionId: s.id, role: 'user', content: '另一个问题' });
    expect(store.getSession(s.id)!.title).toBe('你好世界');
  });

  it('meta JSON 序列化往返；坏 JSON 读出 null 不抛', () => {
    const dbPath = freshDb();
    const store = makeStore(dbPath);
    const s = store.createSession();

    const m1 = store.appendMessage({ sessionId: s.id, role: 'user', content: 'q', meta: { a: 1 } });
    const m2 = store.appendMessage({ sessionId: s.id, role: 'assistant', content: 'a' });
    expect(m1.meta).toEqual({ a: 1 });
    expect(m2.meta).toBeNull();

    let msgs = store.listMessages(s.id);
    expect(msgs[0].meta).toEqual({ a: 1 });
    expect(msgs[1].meta).toBeNull();

    // 手工写入坏 JSON → 读出 null
    const raw = new Database(dbPath);
    raw.prepare('UPDATE messages SET meta = ? WHERE id = ?').run('{oops', m1.id);
    raw.close();
    msgs = store.listMessages(s.id);
    expect(msgs[0].meta).toBeNull();
    expect(() => store.listMessages(s.id)).not.toThrow();
  });

  it('updateMessage 改 content / meta，未给的字段不动', () => {
    const store = makeStore(freshDb());
    const s = store.createSession();
    const m = store.appendMessage({ sessionId: s.id, role: 'user', content: 'old' });

    store.updateMessage(m.id, { content: 'new', meta: { elapsedMs: 5 } });
    expect(store.listMessages(s.id)[0]).toMatchObject({
      content: 'new',
      meta: { elapsedMs: 5 }
    });

    store.updateMessage(m.id, { content: 'new2' });
    expect(store.listMessages(s.id)[0]).toMatchObject({
      content: 'new2',
      meta: { elapsedMs: 5 }
    });

    store.updateMessage(m.id, { meta: { finishReason: 'stop' } });
    expect(store.listMessages(s.id)[0]).toMatchObject({
      content: 'new2',
      meta: { finishReason: 'stop' }
    });
  });

  it('listMessages 升序；limit = 最新 N 条后升序返回', () => {
    const store = makeStore(freshDb());
    const s = store.createSession();
    for (let i = 0; i < 5; i++) {
      store.appendMessage({ sessionId: s.id, role: 'user', content: `m${i}` });
    }
    expect(store.listMessages(s.id).map((m) => m.content)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
      'm4'
    ]);
    expect(store.listMessages(s.id, 2).map((m) => m.content)).toEqual(['m3', 'm4']);
    expect(store.listMessages(s.id, 0)).toEqual([]);
  });
});

describe('buildContext', () => {
  it('system 在首，历史按时序拼接', () => {
    const store = makeStore(freshDb());
    const s = store.createSession();
    store.appendMessage({ sessionId: s.id, role: 'user', content: '第一个问题' });
    store.appendMessage({ sessionId: s.id, role: 'assistant', content: '第一个回答' });

    const ctx = store.buildContext(s.id);
    expect(ctx[0]).toEqual({ role: 'system', content: FAIRY_SYSTEM_PROMPT });
    expect(ctx.slice(1)).toEqual([
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '第一个回答' }
    ]);
  });

  it('跳过 content 为空的占位行', () => {
    const store = makeStore(freshDb());
    const s = store.createSession();
    store.appendMessage({ sessionId: s.id, role: 'user', content: '' });
    store.appendMessage({ sessionId: s.id, role: 'assistant', content: '   \n ' });
    store.appendMessage({ sessionId: s.id, role: 'user', content: '真问题' });

    expect(store.buildContext(s.id)).toEqual([
      { role: 'system', content: FAIRY_SYSTEM_PROMPT },
      { role: 'user', content: '真问题' }
    ]);
  });

  it('systemExtra 非空拼在 system 后（\n\n 分隔），空/缺省不拼', () => {
    const store = makeStore(freshDb());
    const s = store.createSession();
    store.appendMessage({ sessionId: s.id, role: 'user', content: '问题' });

    const extra = '【关于这个用户】\n- 喜欢简洁回答（preference, 9/15）';
    expect(store.buildContext(s.id, { systemExtra: extra })[0]).toEqual({
      role: 'system',
      content: `${FAIRY_SYSTEM_PROMPT}\n\n${extra}`
    });
    expect(store.buildContext(s.id, { systemExtra: '   ' })[0]).toEqual({
      role: 'system',
      content: FAIRY_SYSTEM_PROMPT
    });
    expect(store.buildContext(s.id, {})[0]).toEqual({
      role: 'system',
      content: FAIRY_SYSTEM_PROMPT
    });
  });

  it('超预算保留最新、时序正确（200 条长消息）', () => {
    const store = makeStore(freshDb());
    const s = store.createSession();
    const msgs: { role: 'user'; content: string }[] = [];
    for (let i = 0; i < 200; i++) {
      const content = 'x'.repeat(195) + String(i).padStart(5, '0'); // 恰好 200 字符
      store.appendMessage({ sessionId: s.id, role: 'user', content });
      msgs.push({ role: 'user', content });
    }

    const ctx = store.buildContext(s.id);
    expect(ctx[0]).toEqual({ role: 'system', content: FAIRY_SYSTEM_PROMPT });

    // 每条 200 字符 → 从最新往前恰好装下 floor((预算-system)/200) 条
    const expectedKept = Math.floor((CONTEXT_BUDGET_CHARS - FAIRY_SYSTEM_PROMPT.length) / 200);
    expect(expectedKept).toBeGreaterThan(0);
    expect(expectedKept).toBeLessThan(200);
    expect(ctx).toHaveLength(expectedKept + 1);
    // 保留的正是最新 N 条，且按时序升序
    expect(ctx.slice(1)).toEqual(msgs.slice(200 - expectedKept));
    // 总长度（system 计入）不超预算
    const total = ctx.reduce((sum, m) => sum + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS);
  });
});

describe('持久化', () => {
  it('写入 → 新建 store 同 dbPath → 数据完整', () => {
    const dbPath = freshDb();
    const store1 = makeStore(dbPath);
    const s = store1.createSession();
    store1.appendMessage({ sessionId: s.id, role: 'user', content: '你好' });
    store1.appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: '在的',
      meta: { elapsedMs: 8 }
    });

    const store2 = makeStore(dbPath);
    const sessions = store2.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(s.id);
    expect(sessions[0].title).toBe('你好');

    const msgs = store2.listMessages(s.id);
    expect(msgs.map((m) => m.content)).toEqual(['你好', '在的']);
    expect(msgs[1].meta).toEqual({ elapsedMs: 8 });

    expect(store2.buildContext(s.id).slice(1)).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在的' }
    ]);
  });
});
