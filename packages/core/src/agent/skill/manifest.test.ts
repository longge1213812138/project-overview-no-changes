/**
 * 阶段 8：skill.json 严格解析单测（fail-visible：每类非法结构都有精确错误）。
 */
import { describe, expect, it } from 'vitest';
import { SkillManifestError, parseSkillManifest } from './manifest';

/** 合法 manifest 基线（各用例在其上打洞） */
function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'demo-skill',
    version: '1.0.0',
    description: '演示技能',
    source: 'local',
    permissions: ['workspace:read'],
    tools: [
      {
        name: 'demo_echo',
        description: '回显入参',
        risk: 'read',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        entry: 'tools/echo.js'
      }
    ]
  };
}

function expectFail(mutate: (m: Record<string, unknown>) => void, pattern: RegExp): void {
  const m = validManifest();
  mutate(m);
  try {
    parseSkillManifest(m);
    expect.unreachable('应当抛出 SkillManifestError');
  } catch (err) {
    expect(err).toBeInstanceOf(SkillManifestError);
    expect((err as Error).message).toMatch(pattern);
  }
}

describe('parseSkillManifest', () => {
  it('合法 manifest 解析成功并归一化（缺省 permissions、默认超时）', () => {
    const m = validManifest();
    delete m.permissions;
    const out = parseSkillManifest(m);
    expect(out.name).toBe('demo-skill');
    expect(out.permissions).toEqual([]);
    expect(out.tools[0].timeoutMs).toBe(10_000);
    expect(out.tools[0].inputSchema.type).toBe('object');
  });

  it('根节点必须是对象；未知顶层字段拒绝', () => {
    expect(() => parseSkillManifest(null)).toThrow(SkillManifestError);
    expect(() => parseSkillManifest('x')).toThrow(SkillManifestError);
    expectFail((m) => (m.extra = 1), /未知字段「extra」/);
  });

  it('schemaVersion 不匹配拒绝（结构演进必须升版本）', () => {
    expectFail((m) => (m.schemaVersion = 2), /schemaVersion 不支持/);
    expectFail((m) => (m.schemaVersion = '1'), /schemaVersion 不支持/);
  });

  it('name/version/description/source 约束', () => {
    expectFail((m) => (m.name = 'bad name!'), /标识符约束/);
    expectFail((m) => (m.version = 'v1'), /semver/);
    expectFail((m) => (m.description = ''), /非空字符串/);
    expectFail((m) => (m.source = ''), /「source」/); // 来源必填（信任展示）
  });

  it('permissions 值域/去重/上限', () => {
    expectFail((m) => (m.permissions = ['fs:root']), /非法取值/);
    expectFail((m) => (m.permissions = ['workspace:read', 'workspace:read']), /重复/);
    expectFail((m) => (m.permissions = 'workspace:read'), /必须是数组/);
  });

  it('tools 结构：非空、数量上限、名称唯一、未知键拒绝', () => {
    expectFail((m) => (m.tools = []), /非空数组/);
    expectFail(
      (m) =>
        (m.tools = [
          {
            name: 'a',
            description: 'd',
            risk: 'read',
            entry: 'x.js',
            inputSchema: { type: 'object' }
          },
          null
        ]),
      /tools\[1\] 必须是 JSON 对象/
    );
    expectFail((m) => (m.tools = [{ ...(m.tools as Record<string, unknown>[])[0], bogus: 1 }]), /未知字段「bogus」/);
    const m = validManifest();
    const tools = m.tools as Record<string, unknown>[];
    tools.push({ ...tools[0] });
    expect(() => parseSkillManifest(m)).toThrow(/工具名重复/);
  });

  it('risk 取值域；timeoutMs 范围', () => {
    expectFail(
      (m) => ((m.tools as Record<string, unknown>[])[0].risk = 'dangerous'),
      /risk 必须是 read\/write\/exec/
    );
    expectFail((m) => ((m.tools as Record<string, unknown>[])[0].timeoutMs = 500), /timeoutMs/);
    expectFail((m) => ((m.tools as Record<string, unknown>[])[0].timeoutMs = 600_000), /timeoutMs/);
  });

  it('entry 路径安全：禁 ..、绝对路径、盘符、UNC、非脚本后缀', () => {
    expectFail((m) => ((m.tools as Record<string, unknown>[])[0].entry = '../outside.js'), /\.\./);
    expectFail((m) => ((m.tools as Record<string, unknown>[])[0].entry = '/abs.js'), /相对路径/);
    expectFail((m) => ((m.tools as Record<string, unknown>[])[0].entry = 'C:\\x.js'), /盘符/);
    expectFail((m) => ((m.tools as Record<string, unknown>[])[0].entry = '\\\\srv\\a.js'), /UNC|相对路径/);
    expectFail((m) => ((m.tools as Record<string, unknown>[])[0].entry = 'tools/run.py'), /\.js\/\.mjs\/\.cjs/);
  });

  it('inputSchema：必须 object 类型、子集外关键字拒绝、非法 pattern 拒绝', () => {
    expectFail((m) => ((m.tools as Record<string, unknown>[])[0].inputSchema = { type: 'string' }), /必须是 "object"/);
    expectFail(
      (m) => ((m.tools as Record<string, unknown>[])[0].inputSchema = { type: 'object', anyOf: [] }),
      /不支持的关键字：anyOf/
    );
    expectFail(
      (m) =>
        ((m.tools as Record<string, unknown>[])[0].inputSchema = {
          type: 'object',
          properties: { a: { type: 'string', $ref: 'x' } }
        }),
      /不支持的关键字：\$ref/
    );
    expectFail(
      (m) =>
        ((m.tools as Record<string, unknown>[])[0].inputSchema = {
          type: 'object',
          properties: { a: { type: 'string', pattern: '([' } }
        }),
      /非法正则/
    );
  });
});
