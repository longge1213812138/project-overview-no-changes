/**
 * 阶段 10：联网检索执行器（DEV_PLAN §5.10「资料来源范围 / 数据筛选」核心）。
 *
 * 链路：`searchWeb(query, cfg)` → 引擎端点（HTTP GET）→ HTML 解析 → 四道筛选：
 *   ① URL 安全守卫（checkWebUrl：协议/凭据/内网/端口）
 *   ② 域名白/黑名单（用户可配的资料来源范围）
 *   ③ 去重（忽略跟踪参数与 hash 后的同一 URL 只留一条靠前的）
 *   ④ 字数/条数裁剪（标题/摘要截断、结果数上限）
 * 任一步拿到空结果都如实反映，不用「假装无事发生」的假结果填补。
 *
 * 失败语义：网络/超时/解析失败 → `error` 字段返回可见原因（**不抛**），
 * 只有「用户主动中止」才抛 AbortError 交给上层中止整轮生成。
 */
import { extractReadableText, htmlToText, parseSearchResultsHtml } from './html';
import type {
  FetchLike,
  WebAccessConfig,
  WebFetchResult,
  WebSearchEngine,
  WebSearchItem,
  WebSearchResult
} from './types';
import { DEFAULT_WEB_ACCESS_CONFIG } from './types';
import { checkWebUrl, domainMatches, normalizeResultUrl, urlDedupeKey, urlHost } from './urlguard';

/** 标题上限字符 */
export const MAX_TITLE_CHARS = 200;
/** 摘要上限字符（摘要只用于「值不值得点」，正文由 fetchWebPage 负责） */
export const MAX_SNIPPET_CHARS = 300;

/** 引擎端点（免 Key 的 HTML 端点；后续新增引擎只需在此登记 + 解析器） */
const ENGINE_ENDPOINTS: Record<WebSearchEngine, string> = {
  duckduckgo: 'https://html.duckduckgo.com/html/'
};

/** 通用 UA：部分引擎会拒绝无 UA 的请求 */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface SearchOptions {
  /** 注入的 fetch（测试用；缺省用全局 fetch） */
  fetchImpl?: FetchLike;
  /** 中止信号（用户停止生成 → 抛 AbortError） */
  signal?: AbortSignal;
  /** 覆盖结果条数上限（工具调用场景由模型给；仍受硬上限夹取） */
  maxResults?: number;
}

/** 到点即 reject 的组合信号 + 回收（参考 llm/client 的爬山逻辑） */
function withTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('检索请求超时')), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    }
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** 夹到 [min,max] 内的整数（脏值 → 默认值） */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** 配置归一（容忍脏配置；不抛错，按硬边界夹取） */
export function normalizeWebAccessConfig(raw: unknown): WebAccessConfig {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const pickStringArray = (key: 'allowedDomains' | 'blockedDomains'): string[] => {
    const value = o[key];
    if (!Array.isArray(value)) return [...DEFAULT_WEB_ACCESS_CONFIG[key]];
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v !== '');
  };
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_WEB_ACCESS_CONFIG.enabled,
    engine: o.engine === 'duckduckgo' ? 'duckduckgo' : DEFAULT_WEB_ACCESS_CONFIG.engine,
    maxResults: clampInt(o.maxResults, 1, 10, DEFAULT_WEB_ACCESS_CONFIG.maxResults),
    fetchTopN: clampInt(o.fetchTopN, 0, 3, DEFAULT_WEB_ACCESS_CONFIG.fetchTopN),
    maxPageChars: clampInt(o.maxPageChars, 1000, 20_000, DEFAULT_WEB_ACCESS_CONFIG.maxPageChars),
    timeoutMs: clampInt(o.timeoutMs, 3000, 30_000, DEFAULT_WEB_ACCESS_CONFIG.timeoutMs),
    allowedDomains: pickStringArray('allowedDomains'),
    blockedDomains: pickStringArray('blockedDomains')
  };
}

/** 域名策略判定：命中黑名单 / 白名单非空却未命中 → false */
function domainAllowed(
  host: string,
  cfg: Pick<WebAccessConfig, 'allowedDomains' | 'blockedDomains'>
): boolean {
  if (cfg.blockedDomains.some((d) => domainMatches(host, d))) return false;
  if (cfg.allowedDomains.length > 0) {
    return cfg.allowedDomains.some((d) => domainMatches(host, d));
  }
  return true;
}

function buildUrl(query: string, engine: WebSearchEngine): string {
  return `${ENGINE_ENDPOINTS[engine]}?q=${encodeURIComponent(query)}`;
}

/**
 * 执行一次联网检索（已含全量筛选）。
 * @param query 检索词（调用方负责清洗；空串直接按无可检索内容返回）
 */
export async function searchWeb(
  query: string,
  cfg: WebAccessConfig,
  options: SearchOptions = {}
): Promise<WebSearchResult> {
  const config = normalizeWebAccessConfig(cfg);
  const engine = config.engine;
  const q = typeof query === 'string' ? query.trim() : '';
  if (q === '') {
    return { query: '', engine, items: [], error: '检索词为空' };
  }
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<FetchLike>) => fetch(...args));
  const limit = clampInt(options.maxResults, 1, 10, config.maxResults);
  const timer = withTimeout(options.signal, config.timeoutMs);

  try {
    throwIfAborted(options.signal);
    const res = await fetchImpl(buildUrl(q, engine), {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      signal: timer.signal
    });
    if (!res.ok) {
      return { query: q, engine, items: [], error: `检索引擎返回 HTTP ${res.status}` };
    }
    const html = await res.text();
    throwIfAborted(options.signal);
    const parsed = parseSearchResultsHtml(html);
    if (parsed.length === 0) {
      // 引擎改版/风控页面/无结果页都落在这里：如实报错，不清醒降级为 "没查到"
      return { query: q, engine, items: [], error: '未能从检索结果页解析出任何条目（引擎页面结构可能已变更）' };
    }
    const seen = new Set<string>();
    const items: WebSearchItem[] = [];
    for (const raw of parsed) {
      const url = normalizeResultUrl(raw.href, ENGINE_ENDPOINTS[engine]);
      if (url === undefined) continue;
      const check = checkWebUrl(url);
      if (!check.ok || check.url === undefined) continue; // ① URL 守卫
      const safeUrl = check.url;
      const host = urlHost(safeUrl);
      if (!domainAllowed(host, config)) continue; // ② 域名白/黑名单
      const key = urlDedupeKey(safeUrl);
      if (seen.has(key)) continue; // ③ 去重
      const title = truncate(htmlToText(raw.title), MAX_TITLE_CHARS);
      const snippet = truncate(htmlToText(raw.snippet), MAX_SNIPPET_CHARS);
      if (title === '' && snippet === '') continue; // 空条目没有任何资料价值
      seen.add(key);
      items.push({ title: title === '' ? safeUrl : title, url: safeUrl, snippet });
      if (items.length >= limit) break; // ④ 条数上限
    }
    return { query: q, engine, items };
  } catch (error) {
    if (options.signal?.aborted) throwIfAborted(options.signal);
    return { query: q, engine, items: [], error: `检索失败：${errorMessage(error)}` };
  } finally {
    timer.dispose();
  }
}

export interface FetchPageOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  /** 覆盖单页正文上限（仍受配置上限夹取） */
  maxChars?: number;
}

/**
 * 抓取指定页面并抽取正文（走与检索一致的 URL 守卫）。
 * 同一 proofs：失败不抛，返回 error 字段让用户/模型可见。
 */
export async function fetchWebPage(
  url: string,
  cfg: WebAccessConfig,
  options: FetchPageOptions = {}
): Promise<WebFetchResult> {
  const config = normalizeWebAccessConfig(cfg);
  const check = checkWebUrl(url);
  if (!check.ok || check.url === undefined) {
    return { url: String(url), title: '', content: '', truncated: false, error: check.reason ?? 'URL 未通过安全校验' };
  }
  const target = check.url;
  const limit = Math.min(config.maxPageChars, clampInt(options.maxChars, 200, 20_000, config.maxPageChars));
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<FetchLike>) => fetch(...args));
  const timer = withTimeout(options.signal, config.timeoutMs);

  try {
    throwIfAborted(options.signal);
    const res = await fetchImpl(target, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
      signal: timer.signal
    });
    if (!res.ok) {
      return { url: target, title: '', content: '', truncated: false, error: `页面返回 HTTP ${res.status}` };
    }
    const html = await res.text();
    throwIfAborted(options.signal);
    const { content, truncated, title } = extractReadableText(html, limit);
    return {
      url: target,
      title: title === undefined ? '' : truncate(title, MAX_TITLE_CHARS),
      content,
      truncated,
      ...(content.trim() === '' ? { error: '未能从页面抽取到正文' } : {})
    };
  } catch (error) {
    if (options.signal?.aborted) throwIfAborted(options.signal);
    return {
      url: target,
      title: '',
      content: '',
      truncated: false,
      error: `抓取失败：${errorMessage(error)}`
    };
  } finally {
    timer.dispose();
  }
}
