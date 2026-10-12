/**
 * 工具权限档位（ADR-0002）在 main 侧的配置读写。
 *
 * 职责边界（单向依赖：permissions → config / logger，不 import chat / agent-tools）：
 * - 读/写 config.json 的 `permissions` 段（明文无凭据；脏值由 core 的
 *   normalizePermissionsConfig 归一，老配置缺省即拿默认档 'default'）；
 * - **不需要任何同步动作**：chat.ts 每轮发消息时重取注册表并顺带读一次档位，
 *   因此保存即对下一轮生效——这是与 web「保存后重装工具」的关键区别，
 *   也是 ADR-0002「在途弹窗与在途那一轮不受影响」的落地形态。
 *
 * 档位语义（只放宽「是否询问」，不放宽「是否允许」）见 core/agent/permissions.ts。
 */
import type { PermissionsConfig, PermissionsSaveResult, ToolPolicy } from '@fairy/core'
import { normalizePermissionsConfig, normalizeToolPolicy } from '@fairy/core'
import { loadConfig, saveConfig } from './config'
import { log } from './logger'

/** 当前工具权限配置（缺省 = 默认档；配置缺失/脏值都回落到安全的一档） */
export function getPermissionsConfig(): PermissionsConfig {
  return normalizePermissionsConfig(loadConfig().permissions)
}

/** 当前工具权限档位（chat.ts 每轮发消息取一次，决定本轮哪些工具需要确认） */
export function getToolPolicy(): ToolPolicy {
  return getPermissionsConfig().toolPolicy
}

/**
 * 保存工具权限档位。非法值归一为默认档（IPC 边界已显式拒绝，这里是第二道保险，
 * 且方向是「越坏越保守」）；落盘失败不抛，错误文案回给设置页。
 */
export function saveToolPolicy(policy: unknown): PermissionsSaveResult {
  const next = normalizeToolPolicy(policy)
  const cfg = loadConfig()
  const merged: PermissionsConfig = {
    ...normalizePermissionsConfig(cfg.permissions),
    toolPolicy: next
  }
  try {
    saveConfig({ ...cfg, permissions: merged })
  } catch (err) {
    return { ok: false, error: `配置写入失败：${err instanceof Error ? err.message : String(err)}` }
  }
  log.info('[permissions]', `工具权限档位 = ${next}`)
  return { ok: true, config: merged }
}
