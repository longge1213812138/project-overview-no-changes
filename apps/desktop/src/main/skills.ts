/**
 * 阶段 8：Skill 技能管理器（main 进程侧，DEV_PLAN §5.8）。
 *
 * 职责：
 * - 发现：扫描 %APPDATA%/fairy/skills 下的技能包（core/discoverSkills），
 *   加载错误整包拒绝并可见（设置页 error 字段）；
 * - 状态：启用状态与内容指纹存 config.json 的 skills 字段（无凭据，明文安全）；
 *   **新发现默认禁用**、**内容变更自动回禁用**（供应链防篡改，需重新启用）；
 * - 装配：启用的技能经 buildSkillRegistrations 进统一 ToolRegistry
 *   （审批恒 ask、source='skill'）；启用/禁用/重扫即时生效并广播 skills:changed。
 *
 * 依赖单向：skills → config/agent-tools/windows/logger（均不回 import skills）。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { buildSkillRegistrations, discoverSkills, IPC } from '@fairy/core'
import type { SkillEntry, SkillListItem } from '@fairy/core'
import type { SkillStateEntry } from './config'
import { loadConfig, saveConfig } from './config'
import { getToolRegistry } from './agent-tools'
import { log } from './logger'
import { broadcast } from './windows'

/** 最近一次扫描结果（设置页列表与装配共用） */
let currentEntries: SkillEntry[] = []
/** 当前已注册进 ToolRegistry 的 skill 工具名（卸载用） */
let registeredSkillTools: string[] = []
/** 内存态启用表（key = manifest.name；扫描时与 config 同步） */
let states: Record<string, SkillStateEntry> = {}
let initialized = false

export function skillsRoot(): string {
  return join(app.getPath('userData'), 'skills')
}

function workspaceRoot(): string {
  return join(app.getPath('userData'), 'workspace')
}

function persistStates(): void {
  const cfg = loadConfig()
  cfg.skills = states
  saveConfig(cfg)
}

/** 状态 + 扫描结果 → 设置页列表项（error/changed 计算在此，单向数据流） */
function toItem(entry: SkillEntry): SkillListItem {
  const state = entry.manifest !== null ? states[entry.name] : undefined;
  const base = {
    name: entry.name,
    dir: entry.dir,
    version: '-',
    description: '',
    source: '-',
    permissions: [] as string[],
    tools: [] as SkillListItem['tools'],
    enabled: false,
    changed: false
  };
  if (entry.error !== undefined || entry.manifest === null) {
    return { ...base, error: entry.error ?? 'manifest 不可用' };
  }
  const manifest = entry.manifest;
  const enabled = state?.enabled === true;
  const changed =
    state !== undefined && state.fingerprint !== '' && state.fingerprint !== entry.fingerprint;
  return {
    ...base,
    version: manifest.version,
    description: manifest.description,
    source: manifest.source,
    permissions: [...manifest.permissions],
    tools: manifest.tools.map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      timeoutMs: t.timeoutMs
    })),
    enabled,
    changed
  };
}

/** 装配当前扫描结果进注册表（先卸载上一轮 skill 工具，再按启用态注册） */
function applyRegistrations(): void {
  const registry = getToolRegistry()
  for (const name of registeredSkillTools) registry.unregister(name)
  registeredSkillTools = []

  const existingNames = registry.list().map((r) => r.tool.definition.function.name)
  const built = buildSkillRegistrations(currentEntries, {
    runtimeExec: process.execPath,
    // electron 以纯 Node 身份跑技能脚本（appendix C 的陷阱是「意外继承」；此处是显式定向注入）
    runtimeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    workspaceRoot: workspaceRoot(),
    existingNames,
    isEnabled: (name) => states[name]?.enabled === true
  })

  for (const reg of built.registrations) {
    try {
      registry.register(reg)
      registeredSkillTools.push(reg.tool.definition.function.name)
    } catch (err) {
      log.warn('[skills]', `注册失败（理论上已被整包冲突检测拦下）：${(err as Error).message}`)
    }
  }
  for (const errItem of built.errors) {
    log.warn('[skills]', `技能拒绝加载 ${errItem.skill}（${errItem.dir}）：${errItem.message}`)
  }
  if (built.loaded.length > 0) {
    log.info(
      '[skills]',
      `已装配：${built.loaded
        .map((l) => `${l.skill} v${l.version}(${l.tools.join('+')})`)
        .join('、')}`
    )
  }
}

/** 扫描 + 状态对账（指纹变更自动禁用）+ 重新装配；返回最新列表 */
function scanAndApply(reason: string): SkillListItem[] {
  currentEntries = discoverSkills(skillsRoot())

  let changedPersist = false
  for (const entry of currentEntries) {
    if (entry.error !== undefined || entry.manifest === null) continue
    const state = states[entry.name]
    if (state === undefined) {
      // 新发现：默认禁用（信任策略——新来源永不自动执行）
      states[entry.name] = { enabled: false, fingerprint: '' }
      changedPersist = true
      log.info('[skills]', `发现新技能（默认禁用）：${entry.name} v${entry.manifest.version}`)
      continue
    }
    if (state.enabled && state.fingerprint !== entry.fingerprint) {
      // 内容变更：自动回禁用（保留旧指纹作为「已变更」标记，需重新启用）
      states[entry.name] = { enabled: false, fingerprint: state.fingerprint }
      changedPersist = true
      log.warn(
        '[skills]',
        `技能内容已变更，自动禁用待确认：${entry.name}（旧指纹 ${state.fingerprint.slice(0, 12)}… ≠ 当前 ${entry.fingerprint.slice(0, 12)}…）`
      )
    }
  }
  // 已不存在的技能：清掉状态（目录被删除）
  for (const name of Object.keys(states)) {
    const present = currentEntries.some((e) => e.error === undefined && e.manifest !== null && e.name === name)
    if (!present) {
      delete states[name]
      changedPersist = true
      log.info('[skills]', `技能目录已移除，清除状态：${name}`)
    }
  }
  if (changedPersist) persistStates()

  applyRegistrations()
  log.info(
    '[skills]',
    `扫描完成（${reason}）：包 ${currentEntries.length} 个，已启用 ${
      Object.values(states).filter((s) => s.enabled).length
    } 个，注册工具 ${registeredSkillTools.length} 个`
  )
  return currentEntries.map(toItem)
}

/** initChat 内调（initAgentTools 之后），幂等 */
export function initSkills(): void {
  if (initialized) return
  initialized = true
  states = loadConfig().skills ?? {}
  scanAndApply('启动')
}

export function listSkills(): SkillListItem[] {
  if (!initialized) return []
  return currentEntries.map(toItem)
}

export function rescanSkills(): SkillListItem[] {
  if (!initialized) return []
  const items = scanAndApply('手动重扫')
  broadcast(IPC.skillsChanged)
  return items
}

/** 启用/禁用：启用需包完整可加载且指纹为当前值 */
export function setSkillEnabled(name: string, enabled: boolean): { ok: boolean; error?: string } {
  if (!initialized) return { ok: false, error: '技能管理器未初始化' }
  const entry = currentEntries.find((e) => e.manifest !== null && e.name === name)
  if (entry === undefined) {
    const broken = currentEntries.find((e) => e.name === name)
    if (broken !== undefined && broken.error !== undefined) {
      return { ok: false, error: `技能加载失败，无法启用：${broken.error}` }
    }
    return { ok: false, error: `未找到技能：${name}` }
  }
  if (entry.error !== undefined || entry.manifest === null || entry.fingerprint === '') {
    return { ok: false, error: `技能加载失败，无法启用：${entry.error ?? 'manifest 不可用'}` }
  }

  const previous = states[name]
  states[name] = {
    enabled,
    fingerprint: enabled ? entry.fingerprint : (previous?.fingerprint ?? '')
  }
  persistStates()
  scanAndApply('启用切换')
  log.info(
    '[skills]',
    `${enabled ? '启用' : '禁用'}技能：${name}（${entry.manifest.version}，来源 ${entry.manifest.source}）`
  )
  broadcast(IPC.skillsChanged)
  return { ok: true }
}
