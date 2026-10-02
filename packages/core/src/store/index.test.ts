/**
 * 阶段 4 任务 A2 / 阶段 5 任务 A4：迁移 v2（memories + memory_fts + 同步触发器）/ v3（events）测试。
 * 每用例独立临时 db（mkdtempSync）；LATEST_SCHEMA_VERSION 断言，不硬编码版本号。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrations, openDatabase } from './index';

const openDbs: Db[] = [];
const dirs: string[] = [];

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-migration-test-'));
  dirs.push(dir);
  return join(dir, 'fairy.db');
}

function openKeep(dbPath: string): Db {
  const db = openDatabase(dbPath);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length) {
    const db = openDbs.pop()!;
    if (db.open) db.close();
  }
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      // Windows 上句柄偶发未释放时忽略清理失败，不影响断言结果
    }
  }
});

describe('迁移 v2：memories + memory_fts', () => {
  it('首次建库即 v2：memories/memory_fts 表与三个同步触发器齐全', () => {
    const db = openKeep(freshDb());

    const version = db.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get() as { v: string };
    expect(version.v).toBe(String(LATEST_SCHEMA_VERSION));
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);

    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name IN ('memories', 'memory_fts')")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['memories', 'memory_fts']));

    const triggers = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('memories_ai', 'memories_ad', 'memories_au')"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(triggers.sort()).toEqual(['memories_ad', 'memories_ai', 'memories_au']);
  });

  it('二次 open 幂等：不报错、表/触发器不重建不重复', () => {
    const dbPath = freshDb();
    const db1 = openKeep(dbPath);
    db1.prepare(
      'INSERT INTO memories(kind, content, source_session, weight, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
    ).run('note', '我喝美式不加糖', null, 1, Date.now(), Date.now());

    const db2 = openKeep(dbPath); // 并发二次 open
    const db3 = openKeep(dbPath); // 再开一次

    for (const db of [db2, db3]) {
      const triggers = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'memories_%'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(triggers.sort()).toEqual(['memories_ad', 'memories_ai', 'memories_au']);
      const version = db.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get() as { v: string };
      expect(version.v).toBe(String(LATEST_SCHEMA_VERSION));
      const count = db.prepare('SELECT count(*) AS n FROM memories').get() as { n: number };
      expect(count.n).toBe(1); // 数据不丢不重
    }
  });

  it('v1 老库（schema_version=1）重开 → 自动补迁到 v2 且 v1 数据保留', () => {
    const dbPath = freshDb();
    // 手工只应用 v1 迁移，模拟阶段 3 的老 fairy.db
    const v1 = migrations.filter((m) => m.version <= 1);
    const old = openKeep(dbPath);
    for (const step of v1) step.up(old);
    old.prepare(
      "INSERT INTO kv(k, v) VALUES('schema_version', '1') ON CONFLICT(k) DO UPDATE SET v = excluded.v"
    ).run();
    old.prepare('INSERT INTO sessions(id, title, kind, created_at, updated_at) VALUES(?, ?, ?, ?, ?)').run(
      's1',
      '老会话',
      'chat',
      1,
      1
    );
    old.close();

    const db = openKeep(dbPath);
    const version = db.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get() as { v: string };
    expect(version.v).toBe(String(LATEST_SCHEMA_VERSION));
    const sessions = db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
    expect(sessions.map((s) => s.id)).toEqual(['s1']);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['memories', 'memory_fts']));
  });

  it('未来版本拒开（用 LATEST_SCHEMA_VERSION 派生）且不覆盖数据', () => {
    const FUTURE_SCHEMA_VERSION = LATEST_SCHEMA_VERSION + 97;
    const dbPath = freshDb();
    const setup = openKeep(dbPath);
    setup.prepare("UPDATE kv SET v = ? WHERE k = 'schema_version'").run(String(FUTURE_SCHEMA_VERSION));
    setup.close();

    expect(() => openDatabase(dbPath)).toThrow(new RegExp(String(FUTURE_SCHEMA_VERSION)));

    // fail-visible：版本号原样保留，绝不写覆盖
    const raw = new Database(dbPath);
    const row = raw.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get() as { v: string };
    expect(row.v).toBe(String(FUTURE_SCHEMA_VERSION));
    raw.close();
  });
});

describe('迁移 v3：events（日程）', () => {
  it('首次建库即 v3：events 表 + idx_events_remind 索引，schema_version=LATEST(3)', () => {
    const db = openKeep(freshDb());

    const version = db.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get() as { v: string };
    expect(version.v).toBe(String(LATEST_SCHEMA_VERSION));
    expect(LATEST_SCHEMA_VERSION).toBe(3);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toEqual(['events']);

    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_remind'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toEqual(['idx_events_remind']);
  });

  it('二次 open 幂等：表/索引不重复、events 数据不丢不重', () => {
    const dbPath = freshDb();
    const db1 = openKeep(dbPath);
    db1
      .prepare('INSERT INTO events(title, notes, remind_at, done, fired, created_at) VALUES(?, ?, ?, 0, 0, ?)')
      .run('交周报', null, 1000, 1);

    openKeep(dbPath); // 并发二次 open
    const db3 = openKeep(dbPath); // 再开一次

    const indexes = (
      db3
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_remind'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toEqual(['idx_events_remind']); // 只有一个，不重复创建

    const rows = db3.prepare('SELECT title FROM events').all() as Array<{ title: string }>;
    expect(rows.map((r) => r.title)).toEqual(['交周报']);
    const version = db3.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get() as { v: string };
    expect(version.v).toBe(String(LATEST_SCHEMA_VERSION));
  });

  it('v2 老库（schema_version=2）重开 → 自动补迁到 v3 且 v2 数据保留', () => {
    const dbPath = freshDb();
    // 手工只应用 v1+v2 迁移并把版本标回 2，模拟阶段 4 的老 fairy.db
    const v2 = migrations.filter((m) => m.version <= 2);
    const old = openKeep(dbPath);
    for (const step of v2) step.up(old);
    old.prepare("UPDATE kv SET v = '2' WHERE k = 'schema_version'").run();
    old
      .prepare(
        'INSERT INTO memories(kind, content, source_session, weight, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)'
      )
      .run('note', '老记忆', null, 1, 1, 1);
    old.close();

    const db = openKeep(dbPath);
    const version = db.prepare("SELECT v FROM kv WHERE k = 'schema_version'").get() as { v: string };
    expect(version.v).toBe(String(LATEST_SCHEMA_VERSION));
    const memories = db.prepare('SELECT content FROM memories').all() as Array<{ content: string }>;
    expect(memories.map((m) => m.content)).toEqual(['老记忆']);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['events']));
  });

  it('schema_version=4（LATEST+1）拒开且不覆盖数据', () => {
    const FUTURE_SCHEMA_VERSION = LATEST_SCHEMA_VERSION + 1;
    expect(FUTURE_SCHEMA_VERSION).toBe(4);
    const dbPath = freshDb();
    const setup = openKeep(dbPath);
    setup.prepare("UPDATE kv SET v = ? WHERE k = 'schema_version'").run(String(FUTURE_SCHEMA_VERSION));
    setup.close();

    expect(() => openDatabase(dbPath)).toThrow(new RegExp(String(FUTURE_SCHEMA_VERSION)));
  });
});
