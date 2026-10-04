/**
 * 阶段 8：MCP（Model Context Protocol）stdio 客户端子系统（DEV_PLAN §5.8）。
 *
 * 含 node 内建依赖（child_process）——**只从 @fairy/core 完整入口导出，
 * 绝不进 index.web / renderer**（与 agent/tools、agent/skill 同一边界）。
 */
export * from './protocol';
export * from './client';
export * from './builder';
