/**
 * 阶段 10：API 通道联网检索（DEV_PLAN §5.10）。
 *
 * 分层（任一层的失败都可见，不静默降级）：
 * - types/：类型契约与默认配置；
 * - urlguard/：URL 安全守卫（协议/凭据/内网 SSRF/端口）+ 归一与去重键 + 域名策略；
 * - html/：零依赖 HTML 解析（结果页抽取、正文抽取、实体解码）；
 * - search/：检索执行器与页面抓取（四道筛选 + 超时 + 失败可见）；
 * - trigger/：联网触发判定（确定性规则，可回归）；
 * - citations/：编号引用块与引用规范（模型据此作答，UI 据此展示来源）。
 *
 * 本目录是**执行面**（含网络 I/O）：只由完整入口 `@fairy/core`（main/preload 侧）导出，
 * renderer 经 index.web 只拿到 ipc.ts 里的类型契约。
 */
export * from './types';
export * from './urlguard';
export * from './html';
export * from './search';
export * from './trigger';
export * from './citations';
