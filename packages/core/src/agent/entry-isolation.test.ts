/**
 * 阶段 7 验收：「renderer 无直接 OS 执行能力」。
 *
 * index.web.ts 是 renderer 的唯一 @fairy/core 入口（electron-vite alias），
 * 必须只暴露 web-safe 的运行时/契约面：工具执行器（shell/files/clock 等 OS 执行器）
 * 绝不能出现在该导出面——否则打包后 renderer bundle 即持有本机执行能力。
 */
import { describe, expect, it } from 'vitest';
import * as webEntry from '../index.web';
import * as mainEntry from '../index';

const WEB_UNSAFE_EXPORTS = [
  'createBuiltinTools',
  'createShellTool',
  'createWorkspaceFilesTool',
  'createClockTool',
  'resolveWorkspacePath',
  'ALLOWED_COMMANDS',
  // 阶段 8：Skill 执行器/发现（child_process/fs 同样不许进 renderer）
  'runSkillTool',
  'discoverSkills',
  'buildSkillRegistrations',
  'parseSkillManifest',
  // 阶段 8：MCP stdio 客户端（child_process 同样不许进 renderer）
  'McpClient',
  'buildMcpRegistrations',
  'killTree',
  // 阶段 9：cron 调度持久化与授权链（SQLite / main 编排面不许进 renderer）
  'createCronStore',
  'createCronAuthorizer',
  'planTrigger',
  'planRecovery',
  // 阶段 10：联网检索执行面（网络 I/O 与解析器同样不许进 renderer）
  'searchWeb',
  'fetchWebPage',
  'normalizeWebAccessConfig',
  'checkWebUrl',
  'parseSearchResultsHtml',
  'extractReadableText',
  'createWebTools'
];

describe('renderer 入口隔离（index.web）', () => {
  it('导出 OS 执行器相关符号（阶段 7 工具执行器只允许 main 入口持有）', () => {
    for (const name of WEB_UNSAFE_EXPORTS) {
      expect(webEntry, `index.web 泄漏了 ${name}`).not.toHaveProperty(name);
    }
  });

  it('main 完整入口持有执行器与装配函数（对照面）', () => {
    expect(mainEntry).toHaveProperty('createBuiltinTools');
    expect(mainEntry).toHaveProperty('createShellTool');
    expect(mainEntry).toHaveProperty('runSkillTool');
    expect(mainEntry).toHaveProperty('discoverSkills');
    expect(mainEntry).toHaveProperty('buildSkillRegistrations');
    expect(mainEntry).toHaveProperty('createCronStore');
    expect(mainEntry).toHaveProperty('createCronAuthorizer');
  });

  it('web-safe 面仍可用：运行时/审批策略/类型契约可达', () => {
    expect(webEntry).toHaveProperty('runAgent');
    expect(webEntry).toHaveProperty('ToolRegistry');
    expect(webEntry).toHaveProperty('createRegistryAuthorizer');
    expect(webEntry).toHaveProperty('probeToolsSupport');
    expect(webEntry).toHaveProperty('IPC');
  });
});
