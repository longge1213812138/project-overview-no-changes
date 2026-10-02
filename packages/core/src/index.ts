/**
 * @fairy/core — Fairy 助手核心逻辑（纯 TypeScript，不依赖 Electron）。
 *
 * 阶段 2：llm/（OpenAI 兼容客户端）、gateway/（sidecar 管理器）、IPC 契约。
 * 阶段 4：memory/（FTS5 记忆）、intent/（意图解析）。
 * 阶段 5：calendar/（日程 events）。
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
