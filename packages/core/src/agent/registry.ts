/**
 * 阶段 7：工具注册表与授权策略（DEV_PLAN §5.7 任务 2/3）。
 *
 * - 注册表持有强类型 schema（definition）+ 风险级别 + 审批策略 + 执行器；
 *   LLM 输出视为不可信输入：工具名必须命中注册表，输入先过 validateInput，
 *   再过 assess（策略钩子：越界/白名单判定），最后才是权限档位与审批、执行。
 * - 默认拒绝：无 authorize 回调、未注册、assess=deny、审批超时/拒绝 → 不执行。
 * - createRegistryAuthorizer 把注册表策略 + 权限档位 + 用户审批回调合成 runtime 的
 *   authorize，并把「越界确认」决策（allowOutside）穿透给执行器二次校验（防御纵深）。
 * - **权限档位只放宽「是否询问」（reg.approval），不放宽「是否允许」**：assess 的
 *   ask（越界）与 deny 与档位无关，永不被覆盖（ADR-0002）。
 * 本模块纯 TS、web-safe（不含 node 内建），renderer 只用类型与 ToolRegistry 策略面。
 */
import type { ChatToolDefinition } from '../llm/types';
import type { AgentAuthDecision, AgentAuthorize, AgentTool } from './runtime';
import type { ToolPolicy } from './permissions';
import { DEFAULT_TOOL_POLICY, requiresApproval } from './permissions';

/** 风险级别：read = 只读；write = 有副作用；exec = 进程/系统级（审批 UI 按此着色） */
export type ToolRisk = 'read' | 'write' | 'exec';

/** 审批策略：auto = 策略允许即执行；ask = 每次都请求用户确认 */
export type ToolApproval = 'auto' | 'ask';

/** assess 返回：allow（放行）/ ask（需用户确认，可带越界标记）/ deny（拒绝执行） */
export interface ToolAssessment {
  decision: 'allow' | 'ask' | 'deny';
  /** 触及工作区外路径/资源（ask 时审批 UI 必须显式展示越界警告） */
  outside?: boolean;
  /** 拒绝/需确认的可读原因（回传模型与审批 UI） */
  reason?: string;
}

export interface ToolRegistration {
  tool: AgentTool;
  risk: ToolRisk;
  approval: ToolApproval;
  /** 来源：builtin（内置）/ skill / mcp（阶段 8 起）；审批 UI 展示 */
  source: 'builtin' | 'skill' | 'mcp';
  /** 执行前策略钩子（路径边界、命令白名单等）；缺省 = 结构校验后放行 */
  assess?: (input: unknown) => ToolAssessment;
}

/** 审批发起请求（main → renderer；renderer 经 agent.respondApproval 回传） */
export interface AgentApprovalRequest {
  id: number;
  tool: {
    name: string;
    description: string;
    risk: ToolRisk;
    source: ToolRegistration['source'];
  };
  /** 模型给出的输入（原样展示，renderer 不执行） */
  input: unknown;
  outside: boolean;
  /** 越界/风险说明（展示给用户） */
  reason?: string;
}

/** 工具执行事件（可观测：main 侧记日志 + 广播给 renderer） */
export interface AgentToolNotice {
  sessionId: string;
  id: string;
  name: string;
  status: 'requested' | 'denied' | 'started' | 'completed' | 'failed';
  error?: string;
}

/** 工具名约束：OpenAI function name 兼容（字母数字 _ -，1-64） */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class ToolRegistry {
  private readonly tools = new Map<string, ToolRegistration>();

  register(reg: ToolRegistration): void {
    const name = reg.tool.definition.function.name;
    if (!NAME_PATTERN.test(name)) {
      throw new ToolRegistryError(`工具名不符合约束（[A-Za-z0-9_-]{{1,64}}）：${name}`);
    }
    if (this.tools.has(name)) {
      throw new ToolRegistryError(`工具重复注册：${name}`);
    }
    this.tools.set(name, reg);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolRegistration | undefined {
    return this.tools.get(name);
  }

  list(): ToolRegistration[] {
    return [...this.tools.values()];
  }

  definitions(): ChatToolDefinition[] {
    return this.list().map((reg) => reg.tool.definition);
  }
}

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export interface AuthorizerOptions {
  /**
   * 请求用户审批。必须自行保证超时收敛为 false（main 侧 60s 超时 + 停止/退出时取消）。
   * 未提供时：一切需审批的调用一律拒绝。
   */
  confirm?: (request: AgentApprovalRequest) => Promise<boolean>;
  /**
   * 权限档位（ADR-0002）：只放宽「是否询问」，不放宽「是否允许」。
   * 缺省 'default' = 逐工具按 reg.approval 判定（引入档位前的行为，存量调用零改动）。
   */
  policy?: ToolPolicy;
  /** 审批 id 生成（测试可注入） */
  nextId?: () => number;
}

/**
 * 注册表 → runtime authorize。
 * 决策顺序：未注册 deny → assess deny → （assess 的 ask，或档位下仍需确认）则 confirm →
 * 批准后若 assess 标记越界则携带 allowOutside（执行器仍须自行二次校验）。
 * 档位只参与第二项的审批判定；assess 的 ask/deny 与档位无关（ADR-0002）。
 */
export function createRegistryAuthorizer(
  registry: ToolRegistry,
  options: AuthorizerOptions = {}
): AgentAuthorize {
  let seq = 0;
  const nextId = options.nextId ?? ((): number => ++seq);
  const policy = options.policy ?? DEFAULT_TOOL_POLICY;
  return async (tool: AgentTool, input: unknown): Promise<boolean | AgentAuthDecision> => {
    const name = tool.definition.function.name;
    const reg = registry.get(name);
    if (!reg || reg.tool !== tool) {
      return { approved: false, reason: `工具未在注册表登记：${name}` };
    }

    const assessment = reg.assess ? reg.assess(input) : { decision: 'allow' as const };
    if (assessment.decision === 'deny') {
      return { approved: false, reason: assessment.reason ?? '工具策略拒绝执行' };
    }

    const needsConfirm = assessment.decision === 'ask' || requiresApproval(reg, policy);
    if (!needsConfirm) {
      return { approved: true, allowOutside: assessment.outside === true };
    }
    if (!options.confirm) {
      return { approved: false, reason: '当前无审批通道，需确认的工具调用一律拒绝' };
    }

    const approved = await options.confirm({
      id: nextId(),
      tool: {
        name,
        description: reg.tool.definition.function.description ?? '',
        risk: reg.risk,
        source: reg.source
      },
      input,
      outside: assessment.outside === true,
      ...(assessment.reason !== undefined ? { reason: assessment.reason } : {})
    });
    if (!approved) {
      return { approved: false, reason: '用户拒绝了本次工具调用' };
    }
    return { approved: true, allowOutside: assessment.outside === true };
  };
}
