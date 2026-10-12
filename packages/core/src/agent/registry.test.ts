import { describe, expect, it, vi } from 'vitest';
import type { AgentAuthDecision } from './runtime';
import type { AgentApprovalRequest, ToolRegistration } from './registry';
import { ToolRegistry, ToolRegistryError, createRegistryAuthorizer } from './registry';
import type { ToolPolicy } from './permissions';
import { TOOL_POLICIES } from './permissions';
import type { AgentTool } from './runtime';

function makeTool(name = 'read_file'): AgentTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description: '测试工具',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    },
    validateInput: () => true,
    execute: async () => ({ ok: true })
  };
}

function makeRegistration(overrides: Partial<ToolRegistration> = {}): ToolRegistration {
  return {
    tool: makeTool(),
    risk: 'read',
    approval: 'auto',
    source: 'builtin',
    ...overrides
  };
}

/** authorize 返回值可能是布尔，归一成决策对象便于断言 */
function asDecision(value: boolean | AgentAuthDecision): AgentAuthDecision {
  return typeof value === 'boolean' ? { approved: value } : value;
}

describe('ToolRegistry', () => {
  it('register 合法工具后 get/list/definitions 均可命中', () => {
    const registry = new ToolRegistry();
    const reg = makeRegistration();
    registry.register(reg);

    expect(registry.get('read_file')).toBe(reg);
    expect(registry.list()).toEqual([reg]);
    expect(registry.definitions()).toEqual([reg.tool.definition]);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('重复注册同名工具抛 ToolRegistryError', () => {
    const registry = new ToolRegistry();
    registry.register(makeRegistration());

    expect(() => registry.register(makeRegistration())).toThrow(ToolRegistryError);
    expect(() => registry.register(makeRegistration({ tool: makeTool('other') }))).not.toThrow();
  });

  it('非法工具名（含空格 / 超过 64 位）抛 ToolRegistryError', () => {
    const registry = new ToolRegistry();

    expect(() => registry.register(makeRegistration({ tool: makeTool('bad name') }))).toThrow(
      ToolRegistryError
    );
    expect(() => registry.register(makeRegistration({ tool: makeTool('a'.repeat(65)) }))).toThrow(
      ToolRegistryError
    );
    // 恰好 64 位仍合法
    expect(() =>
      registry.register(makeRegistration({ tool: makeTool('a'.repeat(64)) }))
    ).not.toThrow();
    expect(registry.get('a'.repeat(64))).toBeDefined();
  });

  it('unregister 对已注册 / 未注册名分别返回 true / false', () => {
    const registry = new ToolRegistry();
    registry.register(makeRegistration());

    expect(registry.unregister('read_file')).toBe(true);
    expect(registry.unregister('read_file')).toBe(false);
    expect(registry.get('read_file')).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });
});

describe('createRegistryAuthorizer', () => {
  it('传入的 tool 不在注册表 → 拒绝并说明未在注册表登记', async () => {
    const registry = new ToolRegistry();
    registry.register(makeRegistration());
    const authorize = createRegistryAuthorizer(registry);

    const decision = asDecision(await authorize(makeTool('unknown_tool'), { value: 1 }));

    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('未在注册表登记');
    expect(decision.reason).toContain('unknown_tool');
  });

  it('同名但实例不同的 tool 视为未登记并拒绝', async () => {
    const registry = new ToolRegistry();
    registry.register(makeRegistration());
    const authorize = createRegistryAuthorizer(registry);
    const twin = makeTool('read_file');

    const decision = asDecision(await authorize(twin, {}));

    expect(registry.get('read_file')?.tool).not.toBe(twin);
    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('未在注册表登记');
  });

  it('assess 返回 deny → 以 assess 的 reason 拒绝', async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeRegistration({
        assess: () => ({ decision: 'deny', reason: '命令不在白名单内' })
      })
    );
    const confirm = vi.fn(async (_request: AgentApprovalRequest) => true);
    const authorize = createRegistryAuthorizer(registry, { confirm });
    const reg = registry.get('read_file')!;

    const decision = asDecision(await authorize(reg.tool, { cmd: 'rm -rf /' }));

    expect(decision).toEqual({ approved: false, reason: '命令不在白名单内' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('approval:auto + assess allow → 直接放行，confirm 不被调用', async () => {
    const registry = new ToolRegistry();
    registry.register(makeRegistration({ approval: 'auto', assess: () => ({ decision: 'allow' }) }));
    const confirm = vi.fn(async (_request: AgentApprovalRequest) => false);
    const authorize = createRegistryAuthorizer(registry, { confirm });
    const reg = registry.get('read_file')!;

    const decision = asDecision(await authorize(reg.tool, { path: 'a.txt' }));

    expect(decision.approved).toBe(true);
    expect(decision.allowOutside).not.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(0);
  });

  it('approval:auto + assess ask(outside) → confirm 一次，越界标记与审批信息透传', async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeRegistration({
        approval: 'auto',
        risk: 'exec',
        source: 'skill',
        assess: () => ({ decision: 'ask', outside: true, reason: '将写入工作区外路径' })
      })
    );
    const confirm = vi.fn(async (_request: AgentApprovalRequest) => true);
    const authorize = createRegistryAuthorizer(registry, { confirm });
    const reg = registry.get('read_file')!;
    const input = { path: 'C:/tmp/x' };

    const decision = asDecision(await authorize(reg.tool, input));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith({
      id: 1,
      tool: { name: 'read_file', description: '测试工具', risk: 'exec', source: 'skill' },
      input,
      outside: true,
      reason: '将写入工作区外路径'
    });
    expect(decision).toEqual({ approved: true, allowOutside: true });
  });

  it('confirm 返回 false → 拒绝且 reason 含“用户拒绝”', async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeRegistration({ assess: () => ({ decision: 'ask', outside: true }) })
    );
    const confirm = vi.fn(async (_request: AgentApprovalRequest) => false);
    const authorize = createRegistryAuthorizer(registry, { confirm });
    const reg = registry.get('read_file')!;

    const decision = asDecision(await authorize(reg.tool, {}));

    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('用户拒绝');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('approval:ask（assess allow）→ 仍会 confirm，outside 为 false', async () => {
    const registry = new ToolRegistry();
    registry.register(makeRegistration({ approval: 'ask', assess: () => ({ decision: 'allow' }) }));
    const confirm = vi.fn(async (_request: AgentApprovalRequest) => true);
    const authorize = createRegistryAuthorizer(registry, { confirm });
    const reg = registry.get('read_file')!;

    const decision = asDecision(await authorize(reg.tool, { value: 1 }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ outside: false }));
    expect(decision).toEqual({ approved: true, allowOutside: false });
  });

  it('未提供 confirm 时，需确认的调用一律拒绝（无审批通道）', async () => {
    const registry = new ToolRegistry();
    registry.register(makeRegistration({ approval: 'ask' }));
    const authorize = createRegistryAuthorizer(registry);
    const reg = registry.get('read_file')!;

    const decision = asDecision(await authorize(reg.tool, {}));

    expect(decision.approved).toBe(false);
    expect(decision.reason).toContain('无审批通道');
  });

  it('注入 nextId 后 confirm 收到的 id 按注入序列', async () => {
    const registry = new ToolRegistry();
    registry.register(makeRegistration({ approval: 'ask' }));
    const nextId = vi.fn().mockReturnValueOnce(41).mockReturnValueOnce(42);
    const confirm = vi.fn(async (_request: AgentApprovalRequest) => true);
    const authorize = createRegistryAuthorizer(registry, { confirm, nextId });
    const reg = registry.get('read_file')!;

    await authorize(reg.tool, { step: 1 });
    await authorize(reg.tool, { step: 2 });

    expect(nextId).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls.map(([request]) => request.id)).toEqual([41, 42]);
  });

  it('缺省 assess 的注册直接按 approval 策略（auto 放行 / ask 走确认）', async () => {
    const registry = new ToolRegistry();
    registry.register(makeRegistration({ approval: 'auto' }));
    registry.register(makeRegistration({ tool: makeTool('ask_tool'), approval: 'ask' }));
    const confirm = vi.fn(async (_request: AgentApprovalRequest) => true);
    const authorize = createRegistryAuthorizer(registry, { confirm });
    const auto = registry.get('read_file')!;
    const ask = registry.get('ask_tool')!;

    const autoDecision = asDecision(await authorize(auto.tool, {}));
    expect(autoDecision).toEqual({ approved: true, allowOutside: false });
    expect(confirm).toHaveBeenCalledTimes(0);

    const askDecision = asDecision(await authorize(ask.tool, {}));
    expect(askDecision).toEqual({ approved: true, allowOutside: false });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ outside: false, tool: expect.objectContaining({ name: 'ask_tool' }) })
    );
  });
});

/**
 * 权限档位 × 审批链（ADR-0002）。这里是那条不变量的回归面：
 * **档位只放宽「是否询问」（reg.approval），绝不放宽「是否允许」（assess 的 ask / deny
 * 与「未注册」都不受档位影响）**。
 */
describe('createRegistryAuthorizer × 权限档位（ADR-0002）', () => {
  /** policy 省略 = 不传该选项（验证缺省档行为与逐字现状一致） */
  async function runOne(
    reg: ToolRegistration,
    policy?: ToolPolicy,
    input: unknown = {}
  ): Promise<{ decision: AgentAuthDecision; confirm: ReturnType<typeof vi.fn> }> {
    const registry = new ToolRegistry();
    registry.register(reg);
    const confirm = vi.fn(async (_request: AgentApprovalRequest) => true);
    const authorize = createRegistryAuthorizer(registry, {
      confirm,
      ...(policy !== undefined ? { policy } : {})
    });
    const name = reg.tool.definition.function.name;
    const tool = registry.get(name)!.tool;
    return { decision: asDecision(await authorize(tool, input)), confirm };
  }

  /** 内置只读工具（默认档下本来要问） */
  const builtinRead = (): ToolRegistration =>
    makeRegistration({
      tool: makeTool('web_search'),
      approval: 'ask',
      risk: 'read',
      source: 'builtin'
    });

  it('不传档位 = 默认档：内置只读工具照旧逐次确认（现状零变化）', async () => {
    const { decision, confirm } = await runOne(builtinRead());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({ approved: true, allowOutside: false });
  });

  it('readonly 档：内置只读工具免确认，confirm 不被调用', async () => {
    const { decision, confirm } = await runOne(builtinRead(), 'readonly');
    expect(confirm).toHaveBeenCalledTimes(0);
    expect(decision).toEqual({ approved: true, allowOutside: false });
  });

  it('readonly 档不采信第三方自述的 read：skill 工具仍逐次确认', async () => {
    const skillRead = makeRegistration({
      tool: makeTool('skill_tool'),
      approval: 'ask',
      risk: 'read',
      source: 'skill'
    });
    const { decision, confirm } = await runOne(skillRead, 'readonly');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(decision.approved).toBe(true);
  });

  it('readonly 档不吃掉越界：assess ask(outside) 仍确认，批准后带 allowOutside', async () => {
    const reg = makeRegistration({
      tool: makeTool('workspace_files'),
      approval: 'ask',
      risk: 'read',
      source: 'builtin',
      assess: () => ({ decision: 'ask', outside: true, reason: '路径在工作区之外' })
    });
    const { decision, confirm } = await runOne(reg, 'readonly', { path: 'C:/other/x.txt' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ outside: true }));
    expect(decision).toEqual({ approved: true, allowOutside: true });
  });

  it('open 档：exec 级（内置 shell / MCP 扩展）免确认', async () => {
    const shell = makeRegistration({
      tool: makeTool('shell'),
      approval: 'ask',
      risk: 'exec',
      source: 'builtin'
    });
    const mcp = makeRegistration({
      tool: makeTool('mcp_tool'),
      approval: 'ask',
      risk: 'exec',
      source: 'mcp'
    });

    const first = await runOne(shell, 'open');
    const second = await runOne(mcp, 'open');

    expect(first.confirm).toHaveBeenCalledTimes(0);
    expect(second.confirm).toHaveBeenCalledTimes(0);
    expect(first.decision.approved).toBe(true);
    expect(second.decision.approved).toBe(true);
  });

  it('open 档不吃掉越界：assess ask(outside) 仍确认', async () => {
    const reg = makeRegistration({
      tool: makeTool('shell'),
      approval: 'ask',
      risk: 'exec',
      assess: () => ({ decision: 'ask', outside: true, reason: '命令越出工作区' })
    });
    const { decision, confirm } = await runOne(reg, 'open', { command: 'x' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(decision).toEqual({ approved: true, allowOutside: true });
  });

  it('open 档不吃掉 assess deny：档位不放宽「是否允许」', async () => {
    const reg = makeRegistration({
      tool: makeTool('shell'),
      approval: 'ask',
      risk: 'exec',
      assess: () => ({ decision: 'deny', reason: '命令不在白名单内' })
    });
    const { decision, confirm } = await runOne(reg, 'open');
    expect(decision).toEqual({ approved: false, reason: '命令不在白名单内' });
    expect(confirm).toHaveBeenCalledTimes(0);
  });

  it('任何档位都不放宽「未注册工具」', async () => {
    const registry = new ToolRegistry();
    const confirm = vi.fn(async (_request: AgentApprovalRequest) => true);

    for (const policy of TOOL_POLICIES) {
      const authorize = createRegistryAuthorizer(registry, { confirm, policy });
      const decision = asDecision(await authorize(makeTool('ghost'), {}));
      expect(decision.approved, `policy=${policy}`).toBe(false);
      expect(decision.reason).toContain('未在注册表登记');
    }
    expect(confirm).toHaveBeenCalledTimes(0);
  });

  it('工具声明 auto → 任何档位都不会反过来要求确认', async () => {
    const autoRead = makeRegistration({
      tool: makeTool('clock'),
      approval: 'auto',
      risk: 'read',
      source: 'builtin'
    });

    for (const policy of TOOL_POLICIES) {
      const { decision, confirm } = await runOne(autoRead, policy);
      expect(confirm, `policy=${policy}`).toHaveBeenCalledTimes(0);
      expect(decision.approved, `policy=${policy}`).toBe(true);
    }
  });
});
