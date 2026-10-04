/**
 * @fairy/core — Fairy 助手核心逻辑（纯 TypeScript，不依赖 Electron）。
 *
 * 阶段 2：llm/（OpenAI 兼容客户端）、gateway/（sidecar 管理器）、IPC 契约。
 * 阶段 4：memory/（FTS5 记忆）、intent/（意图解析）。
 * 阶段 5：calendar/（日程 events）。
 * 阶段 7：agent/（有界工具调用运行时）；agent/tools/（内置工具执行器，含 OS 执行，仅 main）。
 * 渲染层请用 index.web.ts（本入口含 node 内建依赖，仅供 main/preload）。
 */

export * from './constants';
export * from './ipc';
export * from './llm';
export * from './gateway';
export * from './store';
export * from './sessions';
export * from './memory';
export * from './calendar';
export * from './intent';
export * from './agent';
export * from './agent/tools';
export * from './agent/skill';
export * from './agent/mcp';
