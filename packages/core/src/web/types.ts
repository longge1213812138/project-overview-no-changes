/**
 * 阶段 10：API 通道联网检索（DEV_PLAN §5.10）— 类型契约与默认值。
 *
 * 设计取向（与既有阶段一致）：
 * - **显式开关**：只有用户打开「联网」开关才会外发请求；关闭即完全不外发。
 * - **零新增依赖**：只用 Node/Electron 内建的 `fetch`，无第三方库、无云端中间服务。
 * - **失败可见**：检索失败以 `error` 字段返回（不抛、不伪装成功），由聊天管线
 *   把「检索失败」如实告诉模型——禁止编造资料是硬规则。
 * 本目录含网络 I/O 与 HTML 解析，属**执行面**：只从完整入口 `@fairy/core` 导出，
 * 绝不进 `index.web.ts`（renderer 面）— 由 agent/entry-isolation.test.ts 钉死。
 */

/**
 * 可配置的**主**检索引擎（设置页可选）。目前 duckduckgo（HTML 端点，免 API Key）。
 */
export type WebPrimaryEngine = 'duckduckgo';

/**
 * 实际执行检索的引擎 = 主引擎 + 内置**备用引擎**。
 *
 * 备用引擎在主引擎**连接类失败**（超时 / 连不上）时自动顶上：「联通性降级」，让
 * 检索源被网络策略挡掉的环境仍能拿到资料（2026-10 实测本机 DDG 全域不可达、
 * Bing 可达，见 core/web/search.ts 的引擎降级逻辑）。
 * 语义失败（HTTP 4xx / 结果页解析不出）**不降级**——换引擎也救不了，只会掩盖真实原因。
 */
export type WebSearchEngine = WebPrimaryEngine | 'bing';

/** 主引擎失败 → 备用引擎顶上时带回的降级说明（可见，不静默切换） */
export interface WebEngineFallback {
  /** 失败的那个引擎 */
  from: WebSearchEngine;
  /** 它为什么失败（人类可读，进日志 / 上下文块 / 用户提示条） */
  reason: string;
  /**
   * 本轮是否**亲自观察到**主引擎失败。
   * false = 命中「主引擎不可达」短期记忆（ENGINE_UNREACHABLE_TTL_MS）直接走备用：
   * 此时只在上下文块里标注引擎，不再打扰用户（降级已是当前常态）。
   */
  observedNow: boolean;
}

/** 联网能力与用法口径（ApI 通道；已取得用户显式开启） */
export interface WebAccessConfig {
  /** 总开关：false = 任何情况都不外发请求（默认 true，尊重「默认可用」但每次可见） */
  enabled: boolean;
  /** 主检索引擎（默认 duckduckgo；不可达时自动降级到备用引擎） */
  engine: WebPrimaryEngine;
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

/**
 * 失败归类（阶段 10 超时硬化）：把「超时 / 连不上 / 被拒 / 解析不了 / 被守卫拦」分开，
 * 上层据此决定 ① 能否重试 ② 向用户怎么交代（超时 ≠ 源不可达 ≠ 被风控）。
 */
export type WebErrorKind =
  /** 单请求超时或总预算耗尽（网络慢或源不可达的典型表现） */
  | 'timeout'
  /** 连接层失败（DNS/代理/连接重置/TLS 失败） */
  | 'network'
  /** 源返回非 2xx */
  | 'http'
  /** 拿到了页面但解析不出条目/正文（引擎改版或缺正文） */
  | 'parse'
  /** 未通过 URL 安全守卫（不发请求） */
  | 'blocked'
  /** 可检索内容为空（空检索词等） */
  | 'empty';

/** 检索结果的单条摘要（未经 MainText 抓取） */
export interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

/** 一次检索的完整结果；items 为空不代表失败，需看 error */
export interface WebSearchResult {
  query: string;
  /** **实际给出结果**的引擎（降级时不是配置里的主引擎） */
  engine: WebSearchEngine;
  items: WebSearchItem[];
  /** 失败原因（超时/网络/解析失败等）；成功且无结果为 undefined */
  error?: string;
  /** 失败归类（error 存在时给出，供重试判定与用户提示措辞） */
  errorKind?: WebErrorKind;
  /** 主引擎不可达、由备用引擎顶替时给出（降级必须可见） */
  fallback?: WebEngineFallback;
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
  /** 失败归类（同 WebSearchResult；'parse' = 页面拿到了但抽不出正文） */
  errorKind?: WebErrorKind;
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
