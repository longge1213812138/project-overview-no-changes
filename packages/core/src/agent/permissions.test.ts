/**
 * 工具权限档位（ADR-0002）纯策略单测：归一容错 + 「只放宽是否询问」的矩阵。
 * 与审批链的集成在 registry.test.ts（那里才有 confirm 与 assess 的互动）。
 */
import { describe, expect, it } from 'vitest';
import type { ToolRegistration } from './registry';
import {
  DEFAULT_PERMISSIONS_CONFIG,
  DEFAULT_TOOL_POLICY,
  TOOL_POLICIES,
  normalizePermissionsConfig,
  normalizeToolPolicy,
  requiresApproval
} from './permissions';

/** 只造 requiresApproval 关心的三个字段（缺省 = 「内置 + read + 声明 ask」） */
function reg(
  over: Partial<Pick<ToolRegistration, 'approval' | 'risk' | 'source'>> = {}
): Pick<ToolRegistration, 'approval' | 'risk' | 'source'> {
  return { approval: 'ask', risk: 'read', source: 'builtin', ...over };
}

describe('normalizeToolPolicy / normalizePermissionsConfig（脏配置容错）', () => {
  it('合法档位原样通过', () => {
    for (const policy of TOOL_POLICIES) expect(normalizeToolPolicy(policy)).toBe(policy);
  });

  it('缺省 / 脏值一律回落默认档（越坏越保守，绝不因脏配置放宽）', () => {
    expect(normalizeToolPolicy(undefined)).toBe(DEFAULT_TOOL_POLICY);
    expect(normalizeToolPolicy(null)).toBe(DEFAULT_TOOL_POLICY);
    expect(normalizeToolPolicy('')).toBe(DEFAULT_TOOL_POLICY);
    expect(normalizeToolPolicy('OPEN')).toBe(DEFAULT_TOOL_POLICY);
    expect(normalizeToolPolicy('allow-all')).toBe(DEFAULT_TOOL_POLICY);
    expect(normalizeToolPolicy(2)).toBe(DEFAULT_TOOL_POLICY);
    expect(normalizeToolPolicy({ toolPolicy: 'open' })).toBe(DEFAULT_TOOL_POLICY);
  });

  it('配置段归一：缺省/非对象 → 默认档；多余字段被丢弃', () => {
    expect(normalizePermissionsConfig(undefined)).toEqual(DEFAULT_PERMISSIONS_CONFIG);
    expect(normalizePermissionsConfig(null)).toEqual(DEFAULT_PERMISSIONS_CONFIG);
    expect(normalizePermissionsConfig('nope')).toEqual(DEFAULT_PERMISSIONS_CONFIG);
    expect(normalizePermissionsConfig({})).toEqual(DEFAULT_PERMISSIONS_CONFIG);
    expect(normalizePermissionsConfig({ toolPolicy: 'readonly' })).toEqual({
      toolPolicy: 'readonly'
    });
    expect(normalizePermissionsConfig({ toolPolicy: 'open', extra: 1 })).toEqual({
      toolPolicy: 'open'
    });
    expect(normalizePermissionsConfig({ toolPolicy: 'dirty' })).toEqual(DEFAULT_PERMISSIONS_CONFIG);
  });

  it('默认档与列表首项一致（设置页顺序 = 从严到宽，单一真相）', () => {
    expect(DEFAULT_PERMISSIONS_CONFIG.toolPolicy).toBe(DEFAULT_TOOL_POLICY);
    expect(TOOL_POLICIES[0]).toBe(DEFAULT_TOOL_POLICY);
    expect([...TOOL_POLICIES]).toEqual(['default', 'readonly', 'open']);
  });
});

describe('requiresApproval（档位只放宽「是否询问」）', () => {
  it('工具自己声明 auto → 任何档位都不会反过来要求确认', () => {
    for (const policy of TOOL_POLICIES) {
      expect(requiresApproval(reg({ approval: 'auto' }), policy)).toBe(false);
      expect(requiresApproval(reg({ approval: 'auto', risk: 'exec', source: 'mcp' }), policy)).toBe(
        false
      );
    }
  });

  it('default 档：声明 ask 就一律要求确认（不看 risk / source）', () => {
    expect(requiresApproval(reg(), 'default')).toBe(true);
    expect(requiresApproval(reg({ risk: 'exec' }), 'default')).toBe(true);
    expect(requiresApproval(reg({ risk: 'exec', source: 'mcp' }), 'default')).toBe(true);
  });

  it('readonly 档：只放行「内置 + read」，第三方自述的 read 不采信', () => {
    expect(requiresApproval(reg(), 'readonly')).toBe(false);
    expect(requiresApproval(reg({ risk: 'write' }), 'readonly')).toBe(true);
    expect(requiresApproval(reg({ risk: 'exec' }), 'readonly')).toBe(true);
    expect(requiresApproval(reg({ source: 'skill' }), 'readonly')).toBe(true);
    expect(requiresApproval(reg({ risk: 'read', source: 'mcp' }), 'readonly')).toBe(true);
  });

  it('open 档：一律不要求确认（含 exec 级与第三方扩展）', () => {
    expect(requiresApproval(reg(), 'open')).toBe(false);
    expect(requiresApproval(reg({ risk: 'write' }), 'open')).toBe(false);
    expect(requiresApproval(reg({ risk: 'exec' }), 'open')).toBe(false);
    expect(requiresApproval(reg({ risk: 'exec', source: 'skill' }), 'open')).toBe(false);
    expect(requiresApproval(reg({ risk: 'exec', source: 'mcp' }), 'open')).toBe(false);
  });

  it('档位矩阵：与 ADR-0002 表格逐格一致 [risk, source, default, readonly, open]', () => {
    const table: [
      ToolRegistration['risk'],
      ToolRegistration['source'],
      boolean,
      boolean,
      boolean
    ][] = [
      ['read', 'builtin', true, false, false],
      ['write', 'builtin', true, true, false],
      ['exec', 'builtin', true, true, false],
      ['read', 'skill', true, true, false],
      ['write', 'skill', true, true, false],
      ['exec', 'skill', true, true, false],
      ['read', 'mcp', true, true, false],
      ['exec', 'mcp', true, true, false]
    ];
    for (const [risk, source, asDefault, asReadonly, asOpen] of table) {
      const tool = reg({ risk, source });
      expect(requiresApproval(tool, 'default'), `${risk}/${source} × default`).toBe(asDefault);
      expect(requiresApproval(tool, 'readonly'), `${risk}/${source} × readonly`).toBe(asReadonly);
      expect(requiresApproval(tool, 'open'), `${risk}/${source} × open`).toBe(asOpen);
    }
  });
});
