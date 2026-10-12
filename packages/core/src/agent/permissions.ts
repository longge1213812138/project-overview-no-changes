/**
 * 工具权限档位（ADR-0002）：决定「要不要问用户」，**不决定**「允不允许」。
 *
 * 三档只替换 createRegistryAuthorizer 里 `reg.approval === 'ask'` 这一项：
 * assess 的 ask（越界）与 deny 一律不动——任何档位下越界的调用仍要一次明确同意，
 * 策略拒绝与未注册工具永远拒绝。把这条不变量写在一处，是为了让「档位」永远
 * 无法被当成「放宽策略」用。
 *
 * 本模块纯 TS、web-safe（无 node 内建）：main 读配置用它，renderer 设置页只用类型。
 */
import type { ToolRegistration } from './registry';

/**
 * 权限档位：
 * - `default`  = 逐工具按其声明的 approval 判定（与引入档位前逐字一致）；
 * - `readonly` = 额外放行**内置且 risk=read** 的工具；
 * - `open`     = 所有已注册工具免确认（含 shell、MCP、第三方 skill）。
 */
export type ToolPolicy = 'default' | 'readonly' | 'open';

/** 合法档位（顺序即设置页展示顺序：从严到宽） */
export const TOOL_POLICIES: readonly ToolPolicy[] = ['default', 'readonly', 'open'];

/** 缺省档位：与引入档位前行为一致，老配置升级后零变化 */
export const DEFAULT_TOOL_POLICY: ToolPolicy = 'default';

/** config.json 的 `permissions` 段（无凭据，整份明文） */
export interface PermissionsConfig {
  toolPolicy: ToolPolicy;
}

export const DEFAULT_PERMISSIONS_CONFIG: PermissionsConfig = {
  toolPolicy: DEFAULT_TOOL_POLICY
};

/** 保存档位的返回值（与 WebActionResult 同形：失败不抛，错误文案可见） */
export interface PermissionsSaveResult {
  ok: boolean;
  /** 归一后的完整配置（ok=true 时必有） */
  config?: PermissionsConfig;
  error?: string;
}

/** 档位归一：脏值/缺省一律回落 default（越坏越保守，绝不因脏配置放宽） */
export function normalizeToolPolicy(raw: unknown): ToolPolicy {
  return typeof raw === 'string' && (TOOL_POLICIES as readonly string[]).includes(raw)
    ? (raw as ToolPolicy)
    : DEFAULT_TOOL_POLICY;
}

/** 配置段归一：缺字段按默认值补齐，脏值回落默认档（容脏，绝不因脏配置崩溃） */
export function normalizePermissionsConfig(raw: unknown): PermissionsConfig {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return { toolPolicy: normalizeToolPolicy(o['toolPolicy']) };
}

/**
 * 档位下该工具是否**仍需询问用户**（只回答这一问；assess 的 ask 由调用方另行判定）。
 *
 * 注意 `readonly` 档只认「内置 + risk=read」：skill 的 risk 来自 manifest 自述，
 * 采信它等于让一个自称只读的第三方脚本免确认执行（ADR-0002 的否决项）。
 */
export function requiresApproval(
  reg: Pick<ToolRegistration, 'approval' | 'risk' | 'source'>,
  policy: ToolPolicy
): boolean {
  // 工具自己声明「不需要确认」时，任何档位都不会反过来要求确认
  if (reg.approval !== 'ask') return false;
  if (policy === 'open') return false;
  if (policy === 'readonly') return !(reg.source === 'builtin' && reg.risk === 'read');
  return true;
}
