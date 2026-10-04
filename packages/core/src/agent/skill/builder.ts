/**
 * 阶段 8：SkillEntry → ToolRegistration 装配（DEV_PLAN §5.8 统一注册表）。
 *
 * 安全不变量：
 * - **审批恒 ask**（v1 不给 skill 任何 auto 放行通道）；source='skill'（审批 UI 显示「扩展」徽标）；
 * - risk 取 manifest 声明（作者自述，仅影响徽标展示；放行只认每次审批）；
 * - definition.description 附带 Skill 名/版本/来源/声明权限——审批对话框
 *   与模型看到的都是同一份来源信息（验收要求「展示来源与所需权限」）；
 * - 入参按 manifest.inputSchema 校验（assess 阶段 deny 可见原因 + validateInput 双保险）；
 * - 任何技能级问题（未启用除外）**整包拒绝**并进 errors（fail-visible，不部分加载）。
 */
import type { ChatToolDefinition } from '../../llm/types';
import type { ToolRegistration } from '../registry';
import type { AgentToolContext } from '../runtime';
import { resolveSkillEntryPath, type SkillEntry } from './discovery';
import { runSkillTool } from './executor';
import { validateAgainstSchema } from './schema';

export interface SkillBuildContext {
  /** 运行时可执行（main 传 electron process.execPath） */
  runtimeExec: string;
  /** 定向环境变量（electron-as-node 时为 { ELECTRON_RUN_AS_NODE: '1' }） */
  runtimeEnv?: Record<string, string>;
  /** 工作区根（cwd） */
  workspaceRoot: string;
  /** 现有已注册工具名（builtin / mcp / 先扫描的 skill），冲突即整包拒绝 */
  existingNames: readonly string[];
  /** 该技能是否已启用（main 读配置状态；未启用直接跳过、不计错误） */
  isEnabled(skillName: string): boolean;
}

export interface SkillLoadSummary {
  skill: string;
  version: string;
  tools: string[];
}

export interface SkillBuildResult {
  /** 可直接交给 ToolRegistry.register 的注册项 */
  registrations: ToolRegistration[];
  /** 成功装配的技能（用于日志与 UI 统计） */
  loaded: SkillLoadSummary[];
  /** 技能级拒绝（含发现期 error 与装配期冲突；未启用不算错误） */
  errors: { skill: string; dir: string; message: string }[];
}

/** 审批/设置页展示用的来源行：名称版本 + 来源 + 声明权限 */
function provenanceLine(
  skillName: string,
  version: string,
  source: string,
  permissions: readonly string[]
): string {
  const perms = permissions.length > 0 ? permissions.join('、') : '无';
  return `｜来自 Skill「${skillName} v${version}」· 来源：${source} · 声明权限：${perms}`;
}

/**
 * 把扫描结果按启用状态装配成注册项。
 * 调用方负责：先把上一轮 skill 工具从注册表移除，再拿 existingNames 调本函数。
 */
export function buildSkillRegistrations(
  entries: readonly SkillEntry[],
  ctx: SkillBuildContext
): SkillBuildResult {
  const result: SkillBuildResult = { registrations: [], loaded: [], errors: [] };
  const claimed = new Set(ctx.existingNames);

  for (const entry of entries) {
    const label = entry.name;
    if (entry.error !== undefined || entry.manifest === null) {
      result.errors.push({ skill: label, dir: entry.dir, message: entry.error ?? 'manifest 不可用' });
      continue;
    }
    if (!ctx.isEnabled(label)) continue; // 未启用：静默跳过（不是错误）

    const manifest = entry.manifest;

    // 整包冲突检测：任一工具名与现有注册或本批其他技能冲突 → 拒绝整个技能
    const conflict = manifest.tools.find((tool) => claimed.has(tool.name));
    if (conflict !== undefined) {
      result.errors.push({
        skill: label,
        dir: entry.dir,
        message: `工具名与现有工具冲突，整包拒绝：${conflict.name}`
      });
      continue;
    }

    const registrations: ToolRegistration[] = [];
    let buildError: string | null = null;
    for (const tool of manifest.tools) {
      const abs = resolveSkillEntryPath(entry.dir, tool.entry);
      if (abs === null) {
        buildError = `entry 路径越界：${tool.entry}`;
        break;
      }
      const schema = tool.inputSchema;
      const checkInput = (value: unknown): string | null => validateAgainstSchema(schema, value, '入参');
      const description =
        tool.description +
        provenanceLine(manifest.name, manifest.version, manifest.source, manifest.permissions);
      const definition: ChatToolDefinition = {
        type: 'function',
        function: { name: tool.name, description, parameters: schema }
      };
      registrations.push({
        risk: tool.risk,
        approval: 'ask', // 恒 ask：skill v1 不提供 auto 放行
        source: 'skill',
        assess: (value: unknown) => {
          const err = checkInput(value);
          return err === null ? { decision: 'allow' } : { decision: 'deny', reason: err };
        },
        tool: {
          definition,
          validateInput: (value: unknown) => checkInput(value) === null,
          async execute(raw: unknown, agentCtx: AgentToolContext): Promise<unknown> {
            const err = checkInput(raw);
            if (err !== null) throw new Error(err); // 防御纵深：execute 前再校验一次
            return await runSkillTool({
              runtimeExec: ctx.runtimeExec,
              ...(ctx.runtimeEnv !== undefined ? { runtimeEnv: ctx.runtimeEnv } : {}),
              entryPath: abs,
              skillDir: entry.dir,
              workspaceRoot: ctx.workspaceRoot,
              toolName: tool.name,
              input: raw,
              timeoutMs: tool.timeoutMs,
              ...(agentCtx.signal !== undefined ? { signal: agentCtx.signal } : {})
            });
          }
        }
      });
    }
    if (buildError !== null || registrations.length !== manifest.tools.length) {
      // 整包拒绝且不占用工具名（半成品不得泄漏进注册表，也不得挡住后续技能）
      result.errors.push({ skill: label, dir: entry.dir, message: buildError ?? '装配失败（数量不符）' });
      continue;
    }

    for (const reg of registrations) claimed.add(reg.tool.definition.function.name);
    result.registrations.push(...registrations);
    result.loaded.push({
      skill: manifest.name,
      version: manifest.version,
      tools: registrations.map((r) => r.tool.definition.function.name)
    });
  }

  return result;
}
