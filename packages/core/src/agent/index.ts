/**
 * agent/ 统一导出（阶段 7）。
 * runtime/registry/capability 为 web-safe（纯 TS，无 node 内建），
 * renderer 经 index.web.ts 可拿到类型与策略面；
 * tools/（shell 等 OS 执行器）只从 @fairy/core 完整入口（index.ts）导出，绝不进 renderer。
 */
export * from './runtime';
export * from './registry';
export * from './permissions';
export * from './capability';
