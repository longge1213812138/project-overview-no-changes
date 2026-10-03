/**
 * 阶段 7：内置工具装配（DEV_PLAN §5.7）。
 *
 * - createBuiltinTools 用共享的 workspaceRoot 构造三个内置工具注册项：
 *   get_current_time（审批 UI 验收入口，每次 ask）、
 *   workspace_files（只读文件，auto + 路径边界策略）、
 *   shell（受控命令执行，ask + 白名单策略）；
 *   返回值可直接交给 ToolRegistry.register 逐个登记。
 * - 同时导出工具实现所需的类型与安全常量（ALLOWED_COMMANDS、DENY_COMMANDS、
 *   buildMinimalEnv、resolveWorkspacePath 等），供集成方与测试引用。
 * - 本文件只做装配，不含任何工具实现逻辑。
 */
import type { ToolRegistration } from '../registry';
import { createClockTool } from './clock';
import { createShellTool } from './shell';
import { createWorkspaceFilesTool } from './workspace-files';

export interface BuiltinToolsOptions {
  /** 工作区根目录（绝对路径）：路径边界与 shell cwd 都以它为界 */
  workspaceRoot: string;
}

/** 构造三个内置工具的注册项（顺序：时钟、文件、shell） */
export function createBuiltinTools(options: BuiltinToolsOptions): ToolRegistration[] {
  return [
    createClockTool(),
    createWorkspaceFilesTool(options.workspaceRoot),
    createShellTool(options.workspaceRoot)
  ];
}

export type { ToolAssessment, ToolRegistration } from '../registry';
export * from './pathguard';
export * from './clock';
export * from './workspace-files';
export * from './shell';
