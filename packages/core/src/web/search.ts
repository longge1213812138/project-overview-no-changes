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
 * 失败语义：网络/超时/解析失败 → `error`（+ `errorKind`）返回可见原因（**不抛**），
 * 只有「用户主动中止」才抛 AbortError 交给上层中止整轮生成。
 *
 * 超时/重试（阶段 10 硬化，见 DEV_PLAN §5.10）：
 * - 单请求超时 = `cfg.timeoutMs`；调用方可给 `deadlineAt`（绝对 epoch ms）把
 *   「本阶段总预算」透下来——单请求超时取二者较小值，**绝不越过总预算**；
 * - `retries`（默认 0，编排层给 1）只重试**瞬时失败**（超时/连接失败/5xx），
 *   且重试前检查剩余预算（不够就不再发第二次，避免把用户等待拉长却注定失败）；
 * - 失败一律折成 `errorKind`（timeout/network/http/parse/blocked/empty），
 *   上层据此决定「提示什么、要不要降级」，不靠字符串猜测。
 *
 * 引擎降级（2026-10，DEV_PLAN §5.10）：
 * - 主引擎（配置项，目前 duckduckgo）**连接类失败**（timeout/network）时自动切到内置
 *   备用引擎（bing），让检索源被网络策略挡掉的环境仍能拿到资料——实测本机 DDG 全域
 *   不可达、Bing 可达，没有降级源时联网等于一直失败；
 * - 语义失败（HTTP 4xx / 解析不出条目）**不降级**（换源救不了，只会掩盖原因）；
 * - 主引擎失败后记短期「不可达」（ENGINE_UNREACHABLE_TTL_MS），期间直接走备用引擎，
 *   不再每条消息都先白等一次连接超时；全引擎失败即清空记忆（网络恢复自愈）；
 * - 降级一律**可见**：结果带 `fallback`（谁 → 谁、为什么），进上下文块与用户提示条。
 */
import { extractReadableText, htmlToText, parseBingResultsHtml, parseSearchResultsHtml } from './html';
import type { ParsedSearchResult } from './html';
import type {
  FetchLike,
  WebAccessConfig,
  WebEngineFallback,
  WebErrorKind,
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

/**
 * 引擎端点（免 Key 的 HTML 端点）与结果页解析器：
 * 新增引擎只需在这两张表登记（+ core/web/html.ts 里写解析器）。
 */
const ENGINE_ENDPOINTS: Record<WebSearchEngine, string> = {
  duckduckgo: 'https://html.duckduckgo.com/html/',
  bing: 'https://www.bing.com/search'
};

const ENGINE_PARSERS: Record<WebSearchEngine, (html: string) => ParsedSearchResult[]> = {
  duckduckgo: parseSearchResultsHtml,
  bing: parseBingResultsHtml
};

/** 内置备用引擎（按序顶替连接类失败的主引擎） */
const FALLBACK_ENGINES: readonly WebSearchEngine[] = ['bing'];

/**
 * 「引擎不可达」短期记忆（ms）：连不上/超时的引擎在这段时间内被跳过，
 * 避免每条消息都先白等一次连接超时（实测主引擎不可达时每次 ~10.7s）。
 */
export const ENGINE_UNREACHABLE_TTL_MS = 10 * 60 * 1000;

/** 切换引擎所需的最小剩余预算（ms）：低于它就只报当前失败（换源也来不及） */
export const ENGINE_SWITCH_MIN_BUDGET_MS = 2000;

const unreachableUntil = new Map<WebSearchEngine, number>();

function engineHealthy(engine: WebSearchEngine, now: number): boolean {
  const until = unreachableUntil.get(engine);
  return until === undefined || until <= now;
}

function markEngineUnreachable(engine: WebSearchEngine): void {
  unreachableUntil.set(engine, Date.now() + ENGINE_UNREACHABLE_TTL_MS);
}

/** 清空「引擎不可达」记忆（全引擎失败时的自愈入口；单测重置用） */
export function resetEngineHealth(): void {
  unreachableUntil.clear();
}

/** 还有预算切换引擎吗？无 deadlineAt = 无预算约束（调用方自行约束） */
function hasBudgetForEngineSwitch(deadlineAt: number | undefined): boolean {
  return deadlineAt === undefined || deadlineAt - Date.now() > ENGINE_SWITCH_MIN_BUDGET_MS;
}

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
  /** 本阶段总预算的截止时刻（epoch ms）：单请求超时不得越过它（编排层透传） */
  deadlineAt?: number;
  /** 瞬时失败（超时/连接失败/5xx）额外重试次数；默认 0（编排层按预算给 1） */
  retries?: number;
}

/** 重试前的固定退避（毫秒）：够让瞬时抖动过去，又不占掉多少预算 */
export const RETRY_DELAY_MS = 400;
/** 重试所需的最小剩余预算：低于它就干脆不重试（发出去也赶不上） */
export const RETRY_MIN_BUDGET_MS = 1500;
/**
 * 只有「快失败」才值得重试：瞬时抖动（连接被拒/502/DNS 立即失败）都在 1.5s 内失败；
 * 而耗时接近单请求超时的失败（典型：目标不可达，挂在连接上）大概率是**系统性**的，
 * 重试只会把用户等待翻倍——这种直接如实报超时（2026-10 实测 DDG 域不可达即此形态）。
 */
export const RETRY_FAST_FAILURE_MS = 1500;

/** 该失败是否「值得+来得及」重试（快失败 + 归类允许 + 剩余预算够） */
function worthRetrying(
  kind: WebErrorKind,
  attemptMs: number,
  deadlineAt: number | undefined
): boolean {
  if (attemptMs > RETRY_FAST_FAILURE_MS) return false;
  if (kind !== 'timeout' && kind !== 'network' && kind !== 'http') return false;
  return hasBudgetForRetry(deadlineAt);
}

/**
 * 到点即 abort 的组合信号 + 回收（沿用 llm/client 的组合方式）。
 * `deadlineAt` = 本阶段总预算的截止时刻：单请求超时取 `min(timeoutMs, 剩余预算)`，
 * 剩余预算已耗尽则立即超时——保证「单请求超时 × N」永远不会超出总预算。
 * `timedOut()` 区分「本方计时器到点」与「连接被拒/用户中止」，供失败归类使用。
 */
function withTimeout(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  opts: { reason: string; deadlineAt?: number }
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let fired = false;
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const remaining =
    opts.deadlineAt === undefined ? Number.POSITIVE_INFINITY : opts.deadlineAt - Date.now();
  const budget = Number.isFinite(remaining) ? Math.min(timeoutMs, Math.max(0, remaining)) : timeoutMs;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(new Error(opts.reason));
  }, budget);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
    timedOut: () => fired
  };
}

/** 等待退避（用户中止立即抛，不把等待期拖满） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

/** 瞬时失败归类：本方计时器到点 / TimeoutError / 消息含超时字样 → 'timeout'，其余连接类 → 'network' */
function classifyTransportFailure(error: unknown, timedOut: boolean): { kind: WebErrorKind; message: string } {
  const message = errorMessage(error);
  if (timedOut) return { kind: 'timeout', message };
  const name = typeof error === 'object' && error !== null ? (error as { name?: string }).name : undefined;
  if (name === 'TimeoutError' || /超时|timed? ?out/i.test(message)) return { kind: 'timeout', message };
  return { kind: 'network', message };
}

/** 5xx 视为瞬时（源侧抖动），4xx 是确定性拒绝，重试无意义 */
function isTransientStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/** 还有预算重试吗？无 deadlineAt = 无预算约束（调用方自行约束） */
function hasBudgetForRetry(deadlineAt: number | undefined): boolean {
  return deadlineAt === undefined || deadlineAt - Date.now() > RETRY_DELAY_MS + RETRY_MIN_BUDGET_MS;
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

/** 单引擎检索结果（内部）：成功带条目，失败带归类 */
type EngineAttempt =
  | { ok: true; items: WebSearchItem[] }
  | { ok: false; error: string; errorKind: WebErrorKind };

/**
 * 用**指定引擎**检索一次（含快失败重试与四道筛选）。
 * 失败不抛（除用户中止）：折成 `errorKind` 返回，由 searchWeb 决定是否降级/报错。
 */
async function searchWithEngine(
  engine: WebSearchEngine,
  q: string,
  config: WebAccessConfig,
  limit: number,
  options: SearchOptions
): Promise<EngineAttempt> {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<FetchLike>) => fetch(...args));
  const attempts = 1 + clampInt(options.retries, 0, 3, 0);
  let failure: { error: string; errorKind: WebErrorKind } = {
    error: '检索失败：未执行任何尝试',
    errorKind: 'network'
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      if (!hasBudgetForRetry(options.deadlineAt)) break; // 剩余预算不够：如实报上一次的失败
      await sleep(RETRY_DELAY_MS, options.signal);
    }
    const timer = withTimeout(options.signal, config.timeoutMs, {
      reason: '检索请求超时',
      ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {})
    });
    const attemptStartedAt = Date.now();

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
        failure = { error: `检索引擎返回 HTTP ${res.status}`, errorKind: 'http' };
        if (
          !isTransientStatus(res.status) ||
          !worthRetrying('http', Date.now() - attemptStartedAt, options.deadlineAt)
        ) {
          return { ok: false, ...failure };
        }
        continue; // 5xx 快失败：源侧抖动，交给重试
      }
      const html = await res.text();
      throwIfAborted(options.signal);
      const parsed = ENGINE_PARSERS[engine](html);
      if (parsed.length === 0) {
        // 引擎改版/风控页面/无结果页都落在这里：如实报错，不降级为 "没查到"（重试也没用）
        return {
          ok: false,
          error: '未能从检索结果页解析出任何条目（引擎页面结构可能已变更）',
          errorKind: 'parse'
        };
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
      return { ok: true, items };
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      const classified = classifyTransportFailure(error, timer.timedOut());
      failure = { error: `检索失败：${classified.message}`, errorKind: classified.kind };
      if (!worthRetrying(classified.kind, Date.now() - attemptStartedAt, options.deadlineAt)) break;
    } finally {
      timer.dispose();
    }
  }
  return { ok: false, ...failure };
}

/**
 * 执行一次联网检索：主引擎 → （连接类失败时）备用引擎降级，已含全量筛选。
 *
 * @param query 检索词（调用方负责清洗；空串直接按无可检索内容返回）
 */
export async function searchWeb(
  query: string,
  cfg: WebAccessConfig,
  options: SearchOptions = {}
): Promise<WebSearchResult> {
  const config = normalizeWebAccessConfig(cfg);
  const primary = config.engine;
  const q = typeof query === 'string' ? query.trim() : '';
  if (q === '') {
    return { query: '', engine: primary, items: [], error: '检索词为空', errorKind: 'empty' };
  }
  const limit = clampInt(options.maxResults, 1, 10, config.maxResults);

  // 引擎顺序：主引擎（若未被记忆为不可达）→ 内置备用引擎（跳过与主引擎同名者）
  const primarySkipped = !engineHealthy(primary, Date.now());
  const order: WebSearchEngine[] = [];
  if (!primarySkipped) order.push(primary);
  for (const candidate of FALLBACK_ENGINES) {
    if (candidate !== primary) order.push(candidate);
  }

  let failure: { error: string; errorKind: WebErrorKind } = {
    error: '检索失败：未执行任何尝试',
    errorKind: 'network'
  };
  let lastEngine: WebSearchEngine = order[order.length - 1] ?? primary;
  // 主源被短期记忆跳过时也要可见（否则会被当成「配的就是备用源」）
  let fallback: WebEngineFallback | undefined = primarySkipped
    ? {
        from: primary,
        reason: `此前判定为不可达（${Math.round(ENGINE_UNREACHABLE_TTL_MS / 60000)} 分钟内直接改用备用源）`,
        observedNow: false
      }
    : undefined;
  let observedPrimaryFailure = false;
  const tried: WebSearchEngine[] = [];

  for (let index = 0; index < order.length; index += 1) {
    const engine = order[index]!;
    lastEngine = engine;
    tried.push(engine);
    const attempt = await searchWithEngine(engine, q, config, limit, options);
    if (attempt.ok) {
      return { query: q, engine, items: attempt.items, ...(fallback !== undefined ? { fallback } : {}) };
    }
    failure = { error: attempt.error, errorKind: attempt.errorKind };
    // 连接类失败（超时/连不上）= 源被挡掉，才值得换源；语义失败换源救不了
    const connectivityFailure = attempt.errorKind === 'timeout' || attempt.errorKind === 'network';
    if (engine === primary) {
      observedPrimaryFailure = true;
      if (connectivityFailure) markEngineUnreachable(engine);
    }
    const next = order[index + 1];
    if (next === undefined) break;
    if (!connectivityFailure) break;
    if (!hasBudgetForEngineSwitch(options.deadlineAt)) break;
    fallback = { from: engine, reason: attempt.error, observedNow: observedPrimaryFailure };
  }

  // 所有引擎都没成 → 清空可达性记忆：下一条消息从头重试（网络恢复能自愈）
  resetEngineHealth();
  // 试过多个源才能说清「不只是一个源的问题」（避免用户以为换个源就好了）
  const suffix = tried.length > 1 ? `（已尝试：${tried.join('、')}）` : '';
  return {
    query: q,
    engine: lastEngine,
    items: [],
    error: `${failure.error}${suffix}`,
    errorKind: failure.errorKind
  };
}

export interface FetchPageOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  /** 覆盖单页正文上限（仍受配置上限夹取） */
  maxChars?: number;
  /** 本阶段总预算的截止时刻（epoch ms）：单页抓取不得越过它（编排层透传） */
  deadlineAt?: number;
  /** 瞬时失败（超时/连接失败/5xx）额外重试次数；默认 0（编排层按预算给 1） */
  retries?: number;
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
    return {
      url: String(url),
      title: '',
      content: '',
      truncated: false,
      error: check.reason ?? 'URL 未通过安全校验',
      errorKind: 'blocked'
    };
  }
  const target = check.url;
  const limit = Math.min(config.maxPageChars, clampInt(options.maxChars, 200, 20_000, config.maxPageChars));
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<FetchLike>) => fetch(...args));
  const attempts = 1 + clampInt(options.retries, 0, 3, 0);
  let failure: { error: string; errorKind: WebErrorKind } = {
    error: '抓取失败：未执行任何尝试',
    errorKind: 'network'
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      if (!hasBudgetForRetry(options.deadlineAt)) break; // 剩余预算不够：如实报上一次的失败
      await sleep(RETRY_DELAY_MS, options.signal);
    }
    const timer = withTimeout(options.signal, config.timeoutMs, {
      reason: '抓取请求超时',
      ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {})
    });
    const attemptStartedAt = Date.now();

    try {
      throwIfAborted(options.signal);
      const res = await fetchImpl(target, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
        signal: timer.signal
      });
      if (!res.ok) {
        failure = { error: `页面返回 HTTP ${res.status}`, errorKind: 'http' };
        if (
          !isTransientStatus(res.status) ||
          !worthRetrying('http', Date.now() - attemptStartedAt, options.deadlineAt)
        ) {
          return { url: target, title: '', content: '', truncated: false, ...failure };
        }
        continue; // 5xx 快失败：源侧抖动，交给重试
      }
      const html = await res.text();
      throwIfAborted(options.signal);
      const { content, truncated, title } = extractReadableText(html, limit);
      return {
        url: target,
        title: title === undefined ? '' : truncate(title, MAX_TITLE_CHARS),
        content,
        truncated,
        ...(content.trim() === '' ? { error: '未能从页面抽取到正文', errorKind: 'parse' as const } : {})
      };
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      const classified = classifyTransportFailure(error, timer.timedOut());
      failure = { error: `抓取失败：${classified.message}`, errorKind: classified.kind };
      if (!worthRetrying(classified.kind, Date.now() - attemptStartedAt, options.deadlineAt)) break;
    } finally {
      timer.dispose();
    }
  }
  return { url: target, title: '', content: '', truncated: false, ...failure };
}
