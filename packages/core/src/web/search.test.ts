/**
 * 阶段 10：检索/抓取执行器单测（fake fetch，不触真实网络）。
 * 重点验证「四道筛选」与「失败可见」两条不变量。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWebPage, normalizeWebAccessConfig, resetEngineHealth, searchWeb } from './search';
import type { FetchLike, WebAccessConfig } from './types';
import { DEFAULT_WEB_ACCESS_CONFIG } from './types';

/** 引擎可达性记忆是模块级状态：用例之间必须清掉，否则「不可达」会串到下一个用例 */
afterEach(() => {
  resetEngineHealth();
});

/** 当前主引擎（Bing）端点基址：只用 Bing，测试据此断言请求地址 */
const BASE = 'https://www.bing.com/search';
const DDG_BASE = 'https://html.duckduckgo.com/html/';
const enc = (url: string): string => encodeURIComponent(url);

/**
 * 构造**当前引擎（Bing）**的结果页（结构与 2026-10 实测一致）：
 * 每条 = `<li class="b_algo">` → `<h2><a href>` 标题（直链）+ `<div class="b_caption"><p>` 摘要。
 */
function resultsHtml(entries: { url: string; title: string; snippet: string }[]): string {
  const parts = entries.map(
    (e) =>
      `<li class="b_algo" data-id iid=SERP.1><h2><a target="_blank" href="${e.url}"><strong>${e.title}</strong></a></h2>` +
      `<div class="b_caption"><p class="b_lineclamp2">${e.snippet}` +
      `<a class="b_algoReadMore" href="${e.url}">阅读更多</a></p></div></li>`
  );
  return `<html><body><ol id="b_results">${parts.join('')}</ol></body></html>`;
}

/** DuckDuckGo 结果页（备用引擎的解析入口；仅在注入备用链的用例里用） */
function ddgResultsHtml(entries: { url: string; title: string; snippet: string }[]): string {
  const parts = entries.map(
    (e) =>
      `<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=${enc(e.url)}">${e.title}</a></h2>` +
      `<a class="result__snippet" href="//duckduckgo.com/l/?uddg=${enc(e.url)}">${e.snippet}</a>`
  );
  return `<html><body>${parts.join('\n')}</body></html>`;
}

function okFetch(html: string, status = 200): FetchLike {
  return (() => Promise.resolve(new Response(html, { status, headers: { 'content-type': 'text/html' } }))) as FetchLike;
}

/** 记录请求的 fetch 桩：便于断言请求地址与是否带中止信号 */
function recordingFetch(html: string): { fetchImpl: FetchLike; seen: RequestInit[]; urls: string[] } {
  const seen: RequestInit[] = [];
  const urls: string[] = [];
  const fetchImpl = ((input: string, init?: RequestInit) => {
    urls.push(input);
    seen.push(init ?? {});
    return Promise.resolve(new Response(html, { status: 200 }));
  }) as FetchLike;
  return { fetchImpl, seen, urls };
}

const cfg = (patch: Partial<WebAccessConfig> = {}): WebAccessConfig => ({
  ...DEFAULT_WEB_ACCESS_CONFIG,
  ...patch
});

describe('normalizeWebAccessConfig（脏配置容错）', () => {
  it('缺省/package 补齐默认值', () => {
    expect(normalizeWebAccessConfig(undefined)).toEqual(DEFAULT_WEB_ACCESS_CONFIG);
    expect(normalizeWebAccessConfig({})).toEqual(DEFAULT_WEB_ACCESS_CONFIG);
  });

  it('越界值夹取、非法类型回落默认', () => {
    const out = normalizeWebAccessConfig({
      enabled: 'yes',
      maxResults: 99,
      fetchTopN: -1,
      maxPageChars: 1,
      timeoutMs: 0,
      allowedDomains: [' A.com ', 42, ''],
      blockedDomains: 'nope'
    });
    expect(out.enabled).toBe(DEFAULT_WEB_ACCESS_CONFIG.enabled);
    expect(out.maxResults).toBe(10);
    expect(out.fetchTopN).toBe(0);
    expect(out.maxPageChars).toBe(1000);
    expect(out.timeoutMs).toBe(3000);
    expect(out.allowedDomains).toEqual(['a.com']);
    expect(out.blockedDomains).toEqual([]);
  });

  /**
   * 引擎口径（2026-10 定案）：**只用 Bing**。历史配置里的 'duckduckgo'（本机不可达）
   * 一律归一为 Bing——不再"先打一个不可达的源再降级"，那等于每条消息白等 6–12s。
   */
  it('引擎归一为 Bing：旧配置的 duckduckgo/脏值都不生效', () => {
    expect(normalizeWebAccessConfig({ engine: 'bing' }).engine).toBe('bing');
    expect(normalizeWebAccessConfig({ engine: 'duckduckgo' }).engine).toBe('bing');
    expect(normalizeWebAccessConfig({ engine: 'whatever' as never }).engine).toBe('bing');
    expect(normalizeWebAccessConfig(undefined).engine).toBe('bing');
  });
});

describe('searchWeb 四道筛选', () => {
  it('① URL 守卫：内网/非 http(s) 条目直接丢弃', async () => {
    const html = resultsHtml([
      { url: 'http://127.0.0.1/admin', title: '内网', snippet: '不该保留' },
      { url: 'file:///C:/secret', title: '本地文件', snippet: '不该保留' },
      { url: 'https://good.example/a', title: '正常来源', snippet: '应保留' }
    ]);
    const res = await searchWeb('测试', cfg(), { fetchImpl: okFetch(html) });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.url).toBe('https://good.example/a');
  });

  it('② 域名策略：黑名单优先于白名单', async () => {
    const html = resultsHtml([
      { url: 'https://spam.example/a', title: '垃圾站', snippet: 'x' },
      { url: 'https://docs.example/b', title: '文档', snippet: 'y' },
      { url: 'https://other.com/c', title: '其他', snippet: 'z' }
    ]);
    const whitelist = await searchWeb('t', cfg({ allowedDomains: ['example'] }), {
      fetchImpl: okFetch(html)
    });
    expect(whitelist.items.map((i) => i.url)).toEqual([
      'https://spam.example/a',
      'https://docs.example/b'
    ]);
    const blacklist = await searchWeb('t', cfg({ allowedDomains: ['example'], blockedDomains: ['spam.example'] }), {
      fetchImpl: okFetch(html)
    });
    expect(blacklist.items.map((i) => i.url)).toEqual(['https://docs.example/b']);
  });

  it('③ 去重：同一 URL 的不同参数/尾斜杠写法只留一条', async () => {
    const html = resultsHtml([
      { url: 'https://example.com/a', title: '首次', snippet: '第一条' },
      { url: 'https://example.com/a/', title: '重复（尾斜杠）', snippet: '应被丢' },
      { url: 'https://example.com/a?utm_source=x', title: '重复（跟踪参数）', snippet: '应被丢' }
    ]);
    const res = await searchWeb('t', cfg(), { fetchImpl: okFetch(html) });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.title).toBe('首次');
  });

  it('④ 条数上限：配置默认 + 调用方可下调', async () => {
    const html = resultsHtml(
      Array.from({ length: 8 }, (_, i) => ({
        url: `https://example.com/${i}`,
        title: `条 ${i}`,
        snippet: `摘要 ${i}`
      }))
    );
    expect((await searchWeb('t', cfg({ maxResults: 3 }), { fetchImpl: okFetch(html) })).items).toHaveLength(3);
    expect(
      (await searchWeb('t', cfg({ maxResults: 6 }), { fetchImpl: okFetch(html), maxResults: 2 })).items
    ).toHaveLength(2);
  });

  it('标题/摘要去标签解码，超长截断；标题缺失用 URL 兜底', async () => {
    const html = resultsHtml([
      { url: 'https://example.com/a', title: 'Tom &amp; Jerry', snippet: 'x'.repeat(500) },
      { url: 'https://example.com/b', title: '', snippet: '只有摘要' }
    ]);
    const res = await searchWeb('t', cfg(), { fetchImpl: okFetch(html) });
    expect(res.items[0]?.title).toBe('Tom & Jerry');
    expect(res.items[0]?.snippet.length).toBe(301); // 300 + 省略号
    expect(res.items[0]?.snippet.endsWith('…')).toBe(true);
    expect(res.items[1]?.title).toBe('https://example.com/b');
  });

  it('标题与摘要都为空的条目丢弃', async () => {
    const html = resultsHtml([{ url: 'https://example.com/a', title: '', snippet: '' }]);
    const res = await searchWeb('t', cfg(), { fetchImpl: okFetch(html) });
    expect(res.items).toHaveLength(0);
  });
});

describe('searchWeb 失败可见（不抛、不伪装成功）', () => {
  it('引擎非 2xx → error 字段', async () => {
    const res = await searchWeb('t', cfg(), { fetchImpl: okFetch('rate limited', 429) });
    expect(res.items).toEqual([]);
    expect(res.error).toContain('429');
  });

  it('结果页结构不可识别 → 解析层错误可见', async () => {
    const res = await searchWeb('t', cfg(), { fetchImpl: okFetch('<html><body>风控页面</body></html>') });
    expect(res.error).toContain('未能从检索结果页解析出任何条目');
  });

  it('网络异常（fetch reject）→ error 字段而非抛错', async () => {
    const boom: FetchLike = (() => Promise.reject(new Error('ECONNREFUSED'))) as FetchLike;
    const res = await searchWeb('t', cfg(), { fetchImpl: boom });
    expect(res.error).toContain('ECONNREFUSED');
  });

  it('空检索词不动网络，直接返回可见错误', async () => {
    const rec = recordingFetch('');
    const res = await searchWeb('   ', cfg(), { fetchImpl: rec.fetchImpl });
    expect(res.error).toBe('检索词为空');
    expect(rec.urls).toHaveLength(0);
  });

  it('用户中止（signal 已 abort）→ 抛 AbortError 交给上层中断生成', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(searchWeb('t', cfg(), { fetchImpl: okFetch(''), signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    });
  });

  it('请求带超时信号与 UA，并把检索词编码进 URL', async () => {
    const rec = recordingFetch(resultsHtml([]));
    await searchWeb('今天天气 & 温度', cfg(), { fetchImpl: rec.fetchImpl });
    expect(rec.urls[0]?.startsWith(BASE)).toBe(true);
    expect(rec.urls[0]).toContain(encodeURIComponent('今天天气 & 温度'));
    expect((rec.seen[0]?.headers as Record<string, string>)['User-Agent']).toBeTruthy();
    expect(rec.seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('fetchWebPage', () => {
  it('抓取成功：抽出标题与正文，脚本/样式不进正文', async () => {
    const html =
      '<html><head><title>标题A</title><style>a{color:red}</style></head><body><script>x</script>' +
      `<p>${'正文A'.repeat(100)}</p></body></html>`;
    const res = await fetchWebPage('https://example.com/p', cfg(), { fetchImpl: okFetch(html) });
    expect(res.error).toBeUndefined();
    expect(res.title).toBe('标题A');
    expect(res.content).toContain('正文A');
    expect(res.content).not.toContain('color:red');
    expect(res.truncated).toBe(false);
  });

  it('正文过短（导航/目录页）→ parse 失败，不拿导航壳冒充正文', async () => {
    // 实测形态：中国天气网的省份目录页只有百余字城市名菜单
    const nav = '<html><head><title>天气网</title></head><body><p>预警 信息 地图 卫星 全国 北京 上海 广东 广西</p></body></html>';
    const res = await fetchWebPage('https://example.com/nav', cfg(), { fetchImpl: okFetch(nav) });
    expect(res.errorKind).toBe('parse');
    expect(res.error).toContain('正文过短');
    expect(res.content).toBe('');
  });

  it('URL 未过守卫 → 不发请求，返回可见错误', async () => {
    const rec = recordingFetch('');
    const res = await fetchWebPage('http://192.168.0.10/x', cfg(), { fetchImpl: rec.fetchImpl });
    expect(res.error).toContain('内网');
    expect(res.content).toBe('');
    expect(rec.urls).toHaveLength(0);
  });

  it('HTTP 非 2xx / 空正文 → 均有可见错误', async () => {
    expect((await fetchWebPage('https://example.com/a', cfg(), { fetchImpl: okFetch('', 404) })).error).toContain('404');
    const empty = await fetchWebPage('https://example.com/a', cfg(), { fetchImpl: okFetch('<html></html>') });
    expect(empty.error).toContain('未能从页面抽取到正文');
  });

  it('上限夹取：maxChars 不超过配置值', async () => {
    const html = `<p>${'字'.repeat(5000)}</p>`;
    const res = await fetchWebPage('https://example.com/a', cfg({ maxPageChars: 1200 }), {
      fetchImpl: okFetch(html),
      maxChars: 9999
    });
    expect(res.content.length).toBe(1200);
    expect(res.truncated).toBe(true);
  });

  it('用户中止 → 抛 AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchWebPage('https://example.com/a', cfg(), { fetchImpl: okFetch('x'), signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/**
 * 阶段 10 硬化：超时归类 / 有界重试 / 总预算（deadlineAt）。
 * 这些用例钉死「用户等待有界 + 失败可归类 + 不把等待翻倍」三条口径。
 */
describe('searchWeb 超时与重试', () => {
  /** 挂住直到被中止的 fetch 桩：模拟「源不可达」（连接建立后不返回） */
  const hangingFetch: FetchLike = ((_input: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as FetchLike;

  it('单请求超时 → errorKind=timeout（不抛，交给上层提示）', async () => {
    vi.useFakeTimers();
    try {
      const pending = searchWeb('t', cfg({ timeoutMs: 3000 }), { fetchImpl: hangingFetch });
      // 主源超时后会按降级链再试备用源（本桩对所有地址都挂住）→ 等两轮
      await vi.advanceTimersByTimeAsync(6500);
      const res = await pending;
      expect(res.items).toEqual([]);
      expect(res.errorKind).toBe('timeout');
      expect(res.error).toContain('超时');
    } finally {
      vi.useRealTimers();
    }
  });

  it('快失败（立即拒绝）→ 自动重试一次并成功', async () => {
    let calls = 0;
    const flaky: FetchLike = (() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('ECONNRESET'));
      return Promise.resolve(
        new Response(resultsHtml([{ url: 'https://example.com/a', title: '标题', snippet: '摘要' }]), {
          status: 200
        })
      );
    }) as FetchLike;
    const res = await searchWeb('t', cfg(), { fetchImpl: flaky, retries: 1 });
    expect(calls).toBe(2);
    expect(res.items).toHaveLength(1);
    expect(res.error).toBeUndefined();
  });

  it('慢失败（耗时接近单请求超时）不重试，但按备用链换源', async () => {
    vi.useFakeTimers();
    try {
      let primaryCalls = 0;
      const slowFail: FetchLike = ((input: string) => {
        if (input.startsWith(BASE)) {
          primaryCalls += 1;
          return new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('ECONNRESET')), 1600);
          });
        }
        // 备用源（注入的 duckduckgo）正常：本用例只关心「主源慢失败不重试」
        return Promise.resolve(
          new Response(ddgResultsHtml([{ url: 'https://example.com/b', title: '备用源', snippet: '摘要' }]), {
            status: 200
          })
        );
      }) as FetchLike;
      const pending = searchWeb('t', cfg(), {
        fetchImpl: slowFail,
        retries: 1,
        fallbackEngines: ['duckduckgo'] // 默认链为空（只用 Bing）：这里显式注入以覆盖降级机件
      });
      await vi.advanceTimersByTimeAsync(2500);
      const res = await pending;
      expect(primaryCalls).toBe(1); // 1.6s > RETRY_FAST_FAILURE_MS：不重试
      expect(res.engine).toBe('duckduckgo');
      expect(res.fallback?.from).toBe('bing');
      expect(res.fallback?.observedNow).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('attemptTimeoutMs 压短单次尝试（工具路径：别让死主源吃光整次调用预算）', async () => {
    vi.useFakeTimers();
    try {
      const stamps: number[] = [];
      const hang = ((_input: string, init?: RequestInit) => {
        stamps.push(Date.now()); // 请求开始
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            stamps.push(Date.now()); // 被中止
            reject(init.signal?.reason);
          });
        });
      }) as FetchLike;

      const pending = searchWeb('t', cfg({ timeoutMs: 12_000 }), {
        fetchImpl: hang,
        retries: 0,
        attemptTimeoutMs: 3000
      });
      await vi.advanceTimersByTimeAsync(6600); // 主源 3s + 备用源 3s
      const res = await pending;

      // 单次尝试被压到 3s（而非 cfg 的 12s）——这正是「换源 + 摘录还有时间」的前提
      expect(stamps[1]! - stamps[0]!).toBe(3000);
      expect(res.errorKind).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('deadlineAt 把单请求超时夹到剩余预算内，且预算已尽不再重试', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const counted: FetchLike = ((_input: string, init?: RequestInit) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }) as FetchLike;
      const pending = searchWeb('t', cfg({ timeoutMs: 12_000 }), {
        fetchImpl: counted,
        retries: 1,
        deadlineAt: Date.now() + 300
      });
      await vi.advanceTimersByTimeAsync(300);
      const res = await pending;
      expect(calls).toBe(1);
      expect(res.errorKind).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('4xx → errorKind=http 且不重试；5xx 快失败 → 重试一次', async () => {
    let calls = 0;
    const rejected: FetchLike = (() => {
      calls += 1;
      return Promise.resolve(new Response('nope', { status: 404 }));
    }) as FetchLike;
    const res = await searchWeb('t', cfg(), { fetchImpl: rejected, retries: 1 });
    expect(calls).toBe(1);
    expect(res.errorKind).toBe('http');
    expect(res.error).toContain('404');

    let calls2 = 0;
    const flaky5xx: FetchLike = (() => {
      calls2 += 1;
      if (calls2 === 1) return Promise.resolve(new Response('boom', { status: 502 }));
      return Promise.resolve(
        new Response(resultsHtml([{ url: 'https://example.com/a', title: '标题', snippet: '摘要' }]), {
          status: 200
        })
      );
    }) as FetchLike;
    const ok = await searchWeb('t', cfg(), { fetchImpl: flaky5xx, retries: 1 });
    expect(calls2).toBe(2);
    expect(ok.items).toHaveLength(1);
  });

  it('失败归类：解析不出条目 → parse；URL 守卫拒绝 → blocked', async () => {
    const parse = await searchWeb('t', cfg(), { fetchImpl: okFetch('<html>风控页面</html>') });
    expect(parse.errorKind).toBe('parse');

    const blocked = await fetchWebPage('http://127.0.0.1/x', cfg(), { fetchImpl: okFetch('') });
    expect(blocked.errorKind).toBe('blocked');
  });

  it('页面抓取超时的文案与检索区分（抓取请求超时）', async () => {
    vi.useFakeTimers();
    try {
      const pending = fetchWebPage('https://example.com/a', cfg({ timeoutMs: 3000 }), {
        fetchImpl: hangingFetch
      });
      await vi.advanceTimersByTimeAsync(3100);
      const res = await pending;
      expect(res.errorKind).toBe('timeout');
      expect(res.error).toContain('抓取');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 阶段 10 降级机件（**当前生产路径不启用**：默认链为空，只用 Bing）。
 * 这里用 `fallbackEngines` 注入备用源（duckduckgo）钉死机件本身的三条口径：
 * 只在连接类失败时降级、降级可见（fallback）、短期记忆避免每次白等。
 */
describe('searchWeb 引擎降级机件（注入备用链）', () => {
  /** 挂住直到被中止（模拟主源不可达） */
  const hangUntilAbort = (init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

  /** 生产形态不用备用链：机件用例显式注入 */
  const chain = { fallbackEngines: ['duckduckgo'] as const };
  const ddgHtml = (title: string): string =>
    ddgResultsHtml([{ url: 'https://example.com/b', title, snippet: '摘要文本' }]);

  it('主引擎（Bing）超时 → 备用源顶上并带回降级说明（observedNow=true）', async () => {
    vi.useFakeTimers();
    try {
      const urls: string[] = [];
      const fetchImpl = ((input: string, init?: RequestInit) => {
        urls.push(input);
        return input.startsWith(BASE)
          ? hangUntilAbort(init)
          : Promise.resolve(new Response(ddgHtml('备用源结果'), { status: 200 }));
      }) as FetchLike;

      const pending = searchWeb('t', cfg({ timeoutMs: 3000 }), {
        fetchImpl,
        retries: 0,
        ...chain
      });
      await vi.advanceTimersByTimeAsync(3500);
      const res = await pending;

      expect(urls[0]?.startsWith(BASE)).toBe(true);
      expect(urls[1]?.startsWith(DDG_BASE)).toBe(true);
      expect(res.engine).toBe('duckduckgo');
      expect(res.items[0]?.title).toBe('备用源结果');
      expect(res.fallback).toEqual({
        from: 'bing',
        reason: '检索失败：检索请求超时',
        observedNow: true
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('语义失败（HTTP 4xx）不降级：换源救不了，如实报错', async () => {
    const urls: string[] = [];
    const fetchImpl = ((input: string) => {
      urls.push(input);
      return Promise.resolve(new Response('nope', { status: 404 }));
    }) as FetchLike;

    const res = await searchWeb('t', cfg(), { fetchImpl, retries: 0, ...chain });
    expect(urls).toHaveLength(1);
    expect(res.engine).toBe('bing');
    expect(res.errorKind).toBe('http');
    expect(res.fallback).toBeUndefined();
  });

  it('短期记忆：主源不可达后，下一条检索直接走备用源且不再提示降级', async () => {
    vi.useFakeTimers();
    try {
      const urls: string[] = [];
      const fetchImpl = ((input: string, init?: RequestInit) => {
        urls.push(input);
        return input.startsWith(BASE)
          ? hangUntilAbort(init)
          : Promise.resolve(new Response(ddgHtml('备用源结果'), { status: 200 }));
      }) as FetchLike;

      const first = searchWeb('t1', cfg({ timeoutMs: 3000 }), { fetchImpl, retries: 0, ...chain });
      await vi.advanceTimersByTimeAsync(3500);
      expect((await first).fallback?.observedNow).toBe(true);

      const second = await searchWeb('t2', cfg({ timeoutMs: 3000 }), { fetchImpl, retries: 0, ...chain });
      expect(second.engine).toBe('duckduckgo');
      expect(second.fallback?.observedNow).toBe(false); // 已是常态：安静运行
      expect(urls.filter((u) => u.startsWith(BASE))).toHaveLength(1); // 没有再白等主源一次
    } finally {
      vi.useRealTimers();
    }
  });

  it('全引擎失败 → 清空可达性记忆（下一条消息从头重试，网络恢复能自愈）', async () => {
    const failing = (() => Promise.reject(new Error('fetch failed'))) as FetchLike;
    const first = await searchWeb('t', cfg(), { fetchImpl: failing, retries: 0, ...chain });
    expect(first.errorKind).toBe('network');

    const recovered = await searchWeb('t2', cfg(), {
      fetchImpl: okFetch(resultsHtml([{ url: 'https://example.com/a', title: '恢复后来源', snippet: '摘要' }])),
      retries: 0,
      ...chain
    });
    expect(recovered.engine).toBe('bing');
    expect(recovered.items[0]?.title).toBe('恢复后来源');
  });

  /**
   * 空链守卫：唯一引擎被「不可达记忆」跳过时仍要实打实试一次，
   * 否则「主源刚失败过一次」会变成「未执行任何尝试」这种假失败；且不得虚报降级。
   */
  it('备用链为空 + 主源被判不可达 → 仍尝试主源，且不虚报降级', async () => {
    const urls: string[] = [];
    const stub = ((input: string, init?: RequestInit) => {
      urls.push(input);
      return input.startsWith(BASE)
        ? hangUntilAbort(init)
        : Promise.resolve(new Response(ddgHtml('备用源结果'), { status: 200 }));
    }) as FetchLike;

    // 第一次：注入链 → bing 超时被记为不可达，备用源顶上（记忆保留）
    vi.useFakeTimers();
    try {
      const first = searchWeb('t1', cfg({ timeoutMs: 3000 }), { fetchImpl: stub, retries: 0, ...chain });
      await vi.advanceTimersByTimeAsync(3500);
      expect((await first).fallback?.observedNow).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    // 第二次：链为空（生产形态）→ 唯一引擎照常尝试，且不该声称「已降级」
    const urls2: string[] = [];
    const onlyBing = ((input: string) => {
      urls2.push(input);
      return Promise.resolve(
        new Response(resultsHtml([{ url: 'https://example.com/a', title: '照常取回', snippet: '摘要' }]), {
          status: 200
        })
      );
    }) as FetchLike;
    const res = await searchWeb('t2', cfg(), { fetchImpl: onlyBing, retries: 0 });

    expect(urls2[0]?.startsWith(BASE)).toBe(true);
    expect(res.engine).toBe('bing');
    expect(res.items[0]?.title).toBe('照常取回');
    expect(res.fallback).toBeUndefined(); // 没换源就不许说换过
  });
});

/** 只用 Bing：默认（不注入备用链）时绝不请求其它检索引擎。 */
describe('只用 Bing（默认引擎口径）', () => {
  it('检索只打 bing，完全不请求 DuckDuckGo', async () => {
    const rec = recordingFetch(resultsHtml([{ url: 'https://example.com/a', title: '来源', snippet: '摘要' }]));
    const res = await searchWeb('Node LTS 最新版本', cfg(), { fetchImpl: rec.fetchImpl, retries: 0 });

    expect(res.engine).toBe('bing');
    expect(res.items).toHaveLength(1);
    expect(rec.urls).toHaveLength(1); // 一次就够：没有「先打一个不可达的源」的浪费
    expect(rec.urls[0]?.startsWith(BASE)).toBe(true);
    expect(rec.urls.some((u) => u.includes('duckduckgo'))).toBe(false);
  });

  it('主源不可达时如实失败（无备用源可换，不假装换过）', async () => {
    const boom: FetchLike = (() => Promise.reject(new Error('fetch failed'))) as FetchLike;
    const res = await searchWeb('t', cfg(), { fetchImpl: boom, retries: 0 });
    expect(res.engine).toBe('bing');
    expect(res.errorKind).toBe('network');
    expect(res.items).toEqual([]);
    expect(res.fallback).toBeUndefined();
  });
});
