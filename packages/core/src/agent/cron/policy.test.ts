/**
 * 阶段 9：无人值守策略测试（DEV_PLAN §5.2/§5.9 验收核心：
 * 预授权可撤销、超范围暂停并通知、不绕过交互审批；错过/恢复纯决策）。
 */
import { describe, expect, it } from 'vitest';
import type { CronTask } from '../../ipc';
import { ToolRegistry } from '../registry';
import type { AgentTool } from '../runtime';
import {
  buildCronMessages,
  createCronAuthorizer,
  planRecovery,
  planTrigger,
  truncateCronOutput,
  type CronEscalation
} from './policy';

const NOW = Date.UTC(2026, 9, 5, 12, 10); // 2026-10-05 12:10Z

function makeTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: 'task-1',
    name: '晨间整理',
    prompt: '整理收件箱并汇总成三条',
    schedule: '0 9 * * *',
    timezone: 'UTC',
    status: 'active',
    preauthorized: [],
    catchup: true,
    maxRetries: 0,
    retryBackoffMs: 30_000,
    failureLimit: 3,
    consecutiveFailures: 0,
    pauseReason: null,
    lastFiredAt: null,
    nextRunAt: Date.UTC(2026, 9, 5, 9, 0), // 已到期（09:00 < 12:10）
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 1),
    ...overrides
  };
}

describe('planTrigger（正常 tick：到期合并补跑最近一次）', () => {
  it('未到期 / 无未来触发 / 已暂停 → null', () => {
    expect(planTrigger(makeTask({ nextRunAt: NOW + 1000 }), NOW)).toBeNull();
    expect(planTrigger(makeTask({ nextRunAt: null }), NOW)).toBeNull();
    expect(planTrigger(makeTask({ status: 'paused' }), NOW)).toBeNull();
  });

  it('单次到期：claim 原时刻，next_run_at 推到未来', () => {
    const plan = planTrigger(makeTask(), NOW);
    expect(plan).not.toBeNull();
    expect(plan?.claimAt).toBe(Date.UTC(2026, 9, 5, 9, 0));
    expect(plan?.missedAt).toBeNull();
    expect(plan?.nextRunAt).toBe(Date.UTC(2026, 9, 6, 9, 0)); // 明天 09:00
  });

  it('tick 迟到/停机窗口：每分钟任务错过 10 分钟 → 只 claim 最近一次（合并）', () => {
    const plan = planTrigger(
      makeTask({ schedule: '* * * * *', nextRunAt: Date.UTC(2026, 9, 5, 12, 0) }),
      NOW
    );
    expect(plan?.claimAt).toBe(Date.UTC(2026, 9, 5, 12, 10)); // 最近一次，不是 12:00
    expect(plan?.nextRunAt).toBe(Date.UTC(2026, 9, 5, 12, 11));
  });
});

describe('planRecovery（启动恢复：catchup 决定补跑还是记 missed）', () => {
  it('catchup=true → 补跑最近一次错过', () => {
    const plan = planRecovery(makeTask({ catchup: true, nextRunAt: Date.UTC(2026, 9, 3, 9, 0) }), NOW);
    expect(plan?.missedAt).toBeNull();
    expect(plan?.claimAt).toBe(Date.UTC(2026, 9, 5, 9, 0)); // 停机 2 天只补最近一次
    expect(plan?.nextRunAt).toBe(Date.UTC(2026, 9, 6, 9, 0));
  });

  it('catchup=false → 不补跑，记 missed（可见），next 照常推进', () => {
    const plan = planRecovery(makeTask({ catchup: false, nextRunAt: Date.UTC(2026, 9, 3, 9, 0) }), NOW);
    expect(plan?.claimAt).toBeNull();
    expect(plan?.missedAt).toBe(Date.UTC(2026, 9, 5, 9, 0));
    expect(plan?.nextRunAt).toBe(Date.UTC(2026, 9, 6, 9, 0));
  });

  it('无错过（next_run_at 在未来）→ 无动作', () => {
    expect(planRecovery(makeTask({ nextRunAt: NOW + 60_000 }), NOW)).toBeNull();
  });
});

// ===== 授权链 =====

function fakeTool(name: string): AgentTool {
  return {
    definition: {
      type: 'function',
      function: { name, description: `${name} 工具`, parameters: { type: 'object', properties: {} } }
    },
    validateInput: () => true,
    execute: async () => ({ ok: true })
  };
}

function registryWith(regs: {
  name: string;
  approval?: 'auto' | 'ask';
  assess?: () => { decision: 'allow' | 'ask' | 'deny'; outside?: boolean; reason?: string };
}[]): { registry: ToolRegistry; tools: Map<string, AgentTool> } {
  const registry = new ToolRegistry();
  const tools = new Map<string, AgentTool>();
  for (const r of regs) {
    const tool = fakeTool(r.name);
    registry.register({
      tool,
      risk: 'read',
      approval: r.approval ?? 'ask',
      source: 'builtin',
      ...(r.assess ? { assess: r.assess } : {})
    });
    tools.set(r.name, tool); // runtime 传的是注册表里的同一实例（身份校验依赖这一点）
  }
  return { registry, tools };
}

describe('createCronAuthorizer（预授权硬条件 + 越界升级）', () => {
  it('预授权 + 需确认 → 放行（不弹审批，无 escalation）', async () => {
    const { registry, tools } = registryWith([{ name: 'get_current_time' }]);
    const escalations: CronEscalation[] = [];
    const authorize = createCronAuthorizer(registry, {
      preauthorized: ['get_current_time'],
      onEscalation: (e) => escalations.push(e)
    });
    const decision = await authorize(tools.get('get_current_time')!, {});
    expect(decision).toEqual({ approved: true, allowOutside: false }); // 越界标志恒 false
    expect(escalations).toHaveLength(0);
  });

  it('未预授权 → 拒绝 + escalation（main 据此暂停任务并通知）', async () => {
    const { registry, tools } = registryWith([{ name: 'shell' }]);
    const escalations: CronEscalation[] = [];
    const authorize = createCronAuthorizer(registry, {
      preauthorized: [], // 撤销预授权 = 空集合
      onEscalation: (e) => escalations.push(e)
    });
    const decision = await authorize(tools.get('shell')!, { cmd: 'whoami' });
    expect(decision).toEqual({ approved: false, reason: expect.stringContaining('shell') });
    expect(escalations).toHaveLength(1);
    expect(escalations[0].kind).toBe('not-preauthorized');
    expect(escalations[0].reason).toMatch(/交互审批/);
  });

  it('已预授权但 assess 判定越界 → 拒绝 + outside escalation（越界永不授予）', async () => {
    const { registry, tools } = registryWith([
      { name: 'workspace_files', assess: () => ({ decision: 'ask' as const, outside: true }) }
    ]);
    const escalations: CronEscalation[] = [];
    const authorize = createCronAuthorizer(registry, {
      preauthorized: ['workspace_files'],
      onEscalation: (e) => escalations.push(e)
    });
    const decision = await authorize(tools.get('workspace_files')!, { path: '..\\..\\x' });
    expect(decision).toEqual({ approved: false, reason: expect.stringContaining('越界') });
    expect(escalations[0].kind).toBe('outside');
  });

  it('assess=deny（策略拒绝，如危险命令）→ 拒绝但不升级（与交互会话同一语义）', async () => {
    const { registry, tools } = registryWith([
      { name: 'shell', assess: () => ({ decision: 'deny' as const, reason: '该命令被安全策略禁止' }) }
    ]);
    const escalations: CronEscalation[] = [];
    const authorize = createCronAuthorizer(registry, {
      preauthorized: ['shell'],
      onEscalation: (e) => escalations.push(e)
    });
    const decision = await authorize(tools.get('shell')!, { cmd: 'powershell Get-Date' });
    expect(decision).toEqual({ approved: false, reason: '该命令被安全策略禁止' });
    expect(escalations).toHaveLength(0);
  });

  it('approval=auto 的工具也必须预授权（集合约束不被宽松策略绕过）', async () => {
    const { registry, tools } = registryWith([{ name: 'auto_tool', approval: 'auto' }]);
    const escalations: CronEscalation[] = [];
    const authorize = createCronAuthorizer(registry, {
      preauthorized: [],
      onEscalation: (e) => escalations.push(e)
    });
    const decision = await authorize(tools.get('auto_tool')!, {});
    expect(decision).toEqual({ approved: false, reason: expect.stringContaining('auto_tool') });
    expect(escalations[0].kind).toBe('not-preauthorized');
  });
});

describe('buildCronMessages / truncateCronOutput（无人值守提示词与输出截断）', () => {
  it('system 含任务约束 + 预授权工具清单；user = 任务指令', () => {
    const messages = buildCronMessages(makeTask({ preauthorized: ['get_current_time'] }), {
      now: NOW,
      toolNames: ['get_current_time'],
      capabilityNote: '端点支持工具'
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    const system = messages[0].content ?? '';
    expect(system).toContain('无人值守');
    expect(system).toContain('get_current_time');
    expect(system).toContain('绝不伪装成功');
    expect(system).toContain('端点支持工具');
    expect(messages[1]).toEqual({ role: 'user', content: '整理收件箱并汇总成三条' });
  });

  it('无预授权工具 → 明示不要调用工具', () => {
    const messages = buildCronMessages(makeTask(), { now: NOW, toolNames: [] });
    expect(messages[0].content).toContain('未预授权任何工具');
  });

  it('输出超长截断（面板展示上限）', () => {
    expect(truncateCronOutput('短', 10)).toBe('短');
    const long = 'x'.repeat(50);
    const cut = truncateCronOutput(long, 10);
    expect(cut.length).toBeLessThan(50);
    expect(cut).toContain('已截断');
  });
});
