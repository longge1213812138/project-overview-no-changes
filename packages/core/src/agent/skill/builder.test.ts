/**
 * 阶段 8：Skill → ToolRegistration 装配单测（统一注册表接入 + 安全不变量）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSkillRegistrations } from './builder';
import type { SkillBuildContext } from './builder';
import { discoverSkills } from './discovery';
import type { SkillEntry } from './discovery';

const cleanups: string[] = [];

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-skill-build-'));
  cleanups.push(dir);
  return dir;
}

const ECHO_SCRIPT = `
let d = '';
process.stdin.on('data', (c) => (d += c));
process.stdin.on('end', () => {
  const req = JSON.parse(d);
  process.stdout.write(JSON.stringify({ echo: req.input }));
});
`;

function manifestFor(toolName: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'alpha',
    version: '2.1.0',
    description: '演示',
    source: 'https://example.com/alpha',
    permissions: ['workspace:read', 'network'],
    tools: [
      {
        name: toolName,
        description: '回显',
        risk: 'read',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1 } },
          required: ['text'],
          additionalProperties: false
        },
        entry: 'tools/echo.js'
      }
    ]
  };
}

function writeSkill(root: string, toolName: string): void {
  const dir = join(root, 'pkg');
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'skill.json'), JSON.stringify(manifestFor(toolName)), 'utf8');
  writeFileSync(join(dir, 'tools', 'echo.js'), ECHO_SCRIPT, 'utf8');
}

function ctxOf(over: Partial<SkillBuildContext> = {}): SkillBuildContext {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'fairy-skill-bws-'));
  cleanups.push(workspaceRoot);
  return {
    runtimeExec: process.execPath,
    workspaceRoot,
    existingNames: [],
    isEnabled: () => true,
    ...over
  };
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
});

describe('buildSkillRegistrations', () => {
  it('启用技能 → 注册项安全不变量：approval 恒 ask / source=skill / 描述带来源与权限', () => {
    const root = makeRoot();
    writeSkill(root, 'alpha_echo');
    const entries = discoverSkills(root);
    const result = buildSkillRegistrations(entries, ctxOf());
    expect(result.errors).toEqual([]);
    expect(result.loaded).toHaveLength(1);
    expect(result.registrations).toHaveLength(1);

    const reg = result.registrations[0];
    expect(reg.approval).toBe('ask');
    expect(reg.source).toBe('skill');
    expect(reg.risk).toBe('read');
    const desc = reg.tool.definition.function.description;
    expect(desc).toContain('Skill「alpha v2.1.0」');
    expect(desc).toContain('来源：https://example.com/alpha');
    expect(desc).toContain('声明权限：workspace:read、network');
  });

  it('未启用 → 静默跳过（不算错误）', () => {
    const root = makeRoot();
    writeSkill(root, 'alpha_echo');
    const result = buildSkillRegistrations(discoverSkills(root), ctxOf({ isEnabled: () => false }));
    expect(result.registrations).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.loaded).toEqual([]);
  });

  it('发现期错误（manifest 非法等）→ errors 可见，无论启用状态', () => {
    const root = makeRoot();
    const dir = join(root, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'skill.json'), '{bad', 'utf8');
    const result = buildSkillRegistrations(discoverSkills(root), ctxOf({ isEnabled: () => false }));
    expect(result.registrations).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/不是合法 JSON/);
  });

  it('工具名与现有注册冲突 → 整包拒绝（不部分加载、不占名）', () => {
    const root = makeRoot();
    writeSkill(root, 'alpha_echo');
    const ctx = ctxOf({ existingNames: ['alpha_echo'] });
    const result = buildSkillRegistrations(discoverSkills(root), ctx);
    expect(result.registrations).toEqual([]);
    expect(result.errors[0].message).toMatch(/冲突，整包拒绝：alpha_echo/);
  });

  it('assess/validateInput：入参过 manifest schema，非法即可见拒绝', async () => {
    const root = makeRoot();
    writeSkill(root, 'alpha_echo');
    const reg = buildSkillRegistrations(discoverSkills(root), ctxOf()).registrations[0];

    expect(reg.assess?.({ text: 'hi' })).toEqual({ decision: 'allow' });
    const missing = reg.assess?.({});
    expect(missing?.decision).toBe('deny');
    expect(missing?.reason).toMatch(/缺少必填字段「text」/);
    expect(reg.assess?.({ text: '' })?.decision).toBe('deny');
    expect(reg.assess?.({ text: 'x', evil: 1 })?.decision).toBe('deny'); // additionalProperties=false
    expect(reg.tool.validateInput({ text: 'ok' })).toBe(true);
    expect(reg.tool.validateInput({ nope: 1 })).toBe(false);
  });

  it('execute：经子进程执行并返回脚本 JSON；执行前二次校验', async () => {
    const root = makeRoot();
    writeSkill(root, 'alpha_echo');
    const ctx = ctxOf();
    const reg = buildSkillRegistrations(discoverSkills(root), ctx).registrations[0];

    const out = await reg.tool.execute({ text: 'hello' }, {});
    expect(out).toEqual({ echo: { text: 'hello' } });
    await expect(reg.tool.execute({ bad: true }, {})).rejects.toThrow(/缺少必填字段/);
  });
});
