/**
 * 阶段 8：技能包发现单测（扫描/整包拒绝/指纹防篡改/重名去重）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSkills, resolveSkillEntryPath } from './discovery';

const cleanups: string[] = [];

/** 建临时 skillsRoot（afterEach 全清） */
function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-skills-'));
  cleanups.push(dir);
  return dir;
}

interface SkillFileSpec {
  dirName: string;
  manifest?: unknown; // undefined = 不写 skill.json；字符串原样写入（可放坏 JSON）
  entryFiles?: Record<string, string>; // 相对路径 → 内容
}

function writeSkill(root: string, spec: SkillFileSpec): string {
  const dir = join(root, spec.dirName);
  mkdirSync(dir, { recursive: true });
  if (spec.manifest !== undefined) {
    const text = typeof spec.manifest === 'string' ? spec.manifest : JSON.stringify(spec.manifest, null, 2);
    writeFileSync(join(dir, 'skill.json'), text, 'utf8');
  }
  for (const [rel, content] of Object.entries(spec.entryFiles ?? {})) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

function goodManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'alpha',
    version: '1.0.0',
    description: 'A',
    source: 'local',
    tools: [
      { name: 'alpha_go', description: 'go', risk: 'read', inputSchema: { type: 'object' }, entry: 'tools/go.js' }
    ],
    ...overrides
  };
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败可忽略 */
    }
  }
});

describe('discoverSkills', () => {
  it('root 不存在则创建并返回空；合法包产出 manifest+指纹', () => {
    const root = join(makeRoot(), 'not-created-yet');
    expect(discoverSkills(root)).toEqual([]);
    expect(discoverSkills(root)).toEqual([]); // 幂等

    writeSkill(root, { dirName: 'pkg-a', manifest: goodManifest(), entryFiles: { 'tools/go.js': '// go' } });
    const entries = discoverSkills(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('alpha');
    expect(entries[0].error).toBeUndefined();
    expect(entries[0].manifest?.tools[0].name).toBe('alpha_go');
    expect(entries[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('整包拒绝可见：缺 skill.json / 坏 JSON / manifest 校验失败 / entry 缺失', () => {
    const root = makeRoot();
    writeSkill(root, { dirName: 'a-no-manifest' });
    writeSkill(root, { dirName: 'b-bad-json', manifest: '{oops' });
    writeSkill(root, { dirName: 'c-invalid', manifest: { ...goodManifest(), name: 'bad name' } });
    writeSkill(root, { dirName: 'd-missing-entry', manifest: goodManifest() }); // 无 go.js

    const entries = discoverSkills(root);
    expect(entries).toHaveLength(4);
    const errors = entries.map((e) => e.error);
    expect(errors[0]).toMatch(/skill\.json 不存在/);
    expect(errors[1]).toMatch(/不是合法 JSON/);
    expect(errors[2]).toMatch(/校验失败/);
    expect(errors[3]).toMatch(/entry 脚本不存在或越界/);
    for (const e of entries) {
      expect(e.manifest === null || e.error !== undefined).toBe(true); // 有错必无可用 manifest（d 除外有 manifest 但仍有 error）
    }
    // 有 error 的包指纹一律为空（不可作为启用依据）
    expect(entries.every((e) => e.error !== undefined ? e.fingerprint === '' : true)).toBe(true);
  });

  it('重名技能：靠前目录生效，其余整包拒绝', () => {
    const root = makeRoot();
    writeSkill(root, { dirName: 'aaa', manifest: goodManifest(), entryFiles: { 'tools/go.js': '1' } });
    writeSkill(root, { dirName: 'bbb', manifest: goodManifest(), entryFiles: { 'tools/go.js': '2' } });
    const entries = discoverSkills(root);
    expect(entries).toHaveLength(2);
    expect(entries[0].error).toBeUndefined();
    expect(entries[1].error).toMatch(/技能名重复/);
  });

  it('指纹防篡改：manifest 或 entry 脚本任一变化 → 指纹变化', () => {
    const root = makeRoot();
    writeSkill(root, { dirName: 'pkg', manifest: goodManifest(), entryFiles: { 'tools/go.js': '// v1' } });
    const first = discoverSkills(root)[0].fingerprint;

    writeSkill(root, { dirName: 'pkg', manifest: goodManifest(), entryFiles: { 'tools/go.js': '// v1' } });
    expect(discoverSkills(root)[0].fingerprint).toBe(first); // 同内容稳定

    writeSkill(root, { dirName: 'pkg', manifest: goodManifest(), entryFiles: { 'tools/go.js': '// v2' } });
    expect(discoverSkills(root)[0].fingerprint).not.toBe(first); // entry 变 → 指纹变

    writeSkill(root, {
      dirName: 'pkg',
      manifest: goodManifest({ description: 'changed' }),
      entryFiles: { 'tools/go.js': '// v2' }
    });
    expect(discoverSkills(root)[0].fingerprint).not.toBe(first); // manifest 变 → 指纹变
  });
});

describe('resolveSkillEntryPath（边界）', () => {
  it('允许包内相对路径；拒绝穿越到包外', () => {
    const root = makeRoot();
    expect(resolveSkillEntryPath(root, 'tools/a.js')).toContain('a.js');
    expect(resolveSkillEntryPath(root, 'tools/../tools/a.js')).toContain('a.js'); // 归一后仍在包内
    expect(resolveSkillEntryPath(root, '../../evil.js')).toBeNull();
  });
});
