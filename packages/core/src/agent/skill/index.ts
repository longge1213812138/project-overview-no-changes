/**
 * 阶段 8：Skill 扩展子系统（DEV_PLAN §5.8）。
 *
 * 含 node 内建依赖（fs/crypto/child_process）——**只从 @fairy/core 完整入口
 * （index.ts）导出，绝不进 index.web / renderer**（与 agent/tools 同一边界）。
 * renderer 需要的类型（SkillListItem 等）在 ipc.ts 定义，随 web 入口可用。
 */
export * from './schema';
export * from './manifest';
export * from './discovery';
export * from './executor';
export * from './builder';
