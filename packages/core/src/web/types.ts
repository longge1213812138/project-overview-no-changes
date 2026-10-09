/**
 * 阶段 10：API 通道联网检索（DEV_PLAN §5.10）— 类型契约与默认值。
 *
 * 设计取向（与既有阶段一致）：
 * - **显式开关**：只有用户打开「联网」开关且在 API 通道下才会外发请求；
 *   网页通道不做联网适配（与「工具调用仅 API 通道」同取向），不静默降级。
 * - **零新增依赖**：只用 Node/Electron 内建的 `fetch`，无第三方库、无云端中间服务。
 * - **失败可见**：检索失败以 `error` 字段返回（不抛、不伪装成功），由聊天管线
 *   把「检索失败」如实告诉模型——禁止编造资料是硬规则。
 * 本目录含网络 I/O 与 HTML 解析，属**执行面**：只从完整入口 `@fairy/core` 导出，
 * 绝不进 `index.web.ts`（renderer 面）— 由 agent/entry-isolation.test.ts 钉死。
 */

/** 可用检索引擎。目前内置 duckduckgo（HTML 端点，**免 API Key**、可实现「开箱即联网」） */
export type WebSearchEngine = 'duckduckgo';

/** 联网能力与用法口径（ApI 通道；已取得用户显式开启） */
export interface WebAccessConfig {
  /** 总开关：false = 任何情况都不外发请求（默认 true，尊重「默认可用」但每次可见） */
  enabled: boolean;
  /** 检索引擎（默认 duckduckgo） */
  engine: WebSearchEngine;
  /** 单次检索最多返回几条结果（1-10，默认 5） */
  maxResults: number;
  /** 检索后自动抓取正文的条数（0-3，默认 2；0 = 只用摘要） */
  fetchTopN: number;
  /** 单页正文字符上限（1000-20000，默认 6000） */
  maxPageChars: number;
  /** 单次 HTTP 超时毫秒（3000-30000，默认 12000） */
  timeoutMs: number;
  /**
   * 域名白名单（可选）：非空时**只保留**命中的来源（后缀匹配，
   * `example.com` 命中 `a.example.com`）。空数组 = 不限制。
   */
  allowedDomains: string[];
  /** 域名黑名单（优先于白名单）：命中即丢弃。用于屏蔽低质/不适来源。 */
  blockedDomains: string[];
}

export const DEFAULT_WEB_ACCESS_CONFIG: WebAccessConfig = {
  enabled: true,
  engine: 'duckduckgo',
  maxResults: 5,
  fetchTopN: 2,
  maxPageChars: 6000,
  timeoutMs: 12_000,
  allowedDomains: [],
  blockedDomains: []
};

/** 检索结果的单条摘要（未经 MainText 抓取） */
export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

/** 一次检索的完整结果；items 为空不代表失败，需看 error */
export interface WebSearchResult {
  query: string;
  engine: WebSearchEngine;
  items: WebSearchItem[];
  /** 失败原因（超时/网络/解析失败等）；成功且无结果为 undefined */
  error?: string;
}

/** 抓取并抽取正文后的页面内容 */
export interface WebPageContent {
  url: string;
  title: string;
  /** 抽取后的纯文本（已去脚本/样式/标签） */
  content: string;
  /** 正文因超过字符上限被截断 */
  truncated: boolean;
}

/** 抓取结果（失败时 content 为空串并带 error） */
export interface WebFetchResult extends WebPageContent {
  error?: string;
}

/** 进入上下文的引用条目（带编号，模型用 [编号] 标注来源） */
export interface WebSource {
  /** 从 1 起的引用编号（与注入块中的 [n] 一一对应） */
  id: number;
  title: string;
  url: string;
  snippet?: string;
}

/** 检索/抓取能力的最小 fetch 面（便于注入假实现做单测，不触真实网络） */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
