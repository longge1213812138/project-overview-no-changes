/**
 * 阶段 10：检索/抓取执行器单测（fake fetch，不触真实网络）。
 * 重点验证「四道筛选」与「失败可见」两条不变量。
 */
import { describe, expect, it } from 'vitest';
import { fetchWebPage, normalizeWebAccessConfig, searchWeb } from './search';
import type { FetchLike, WebAccessConfig } from './types';
import { DEFAULT_WEB_ACCESS_CONFIG } from './types';

const BASE = 'https://html.duckduckgo.com/html/';
const enc = (url: string): string => encodeURIComponent(url);

/** 构造结果页：每条 = 标题锚点 + 摘要锚点 */
function resultsHtml(entries: { url: string; title: string; snippet: string }[]): string {
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

  it('只接受已登记的引擎；脏值回落默认', () => {
    expect(normalizeWebAccessConfig({ engine: 'bing' }).engine).toBe('duckduckgo');
    expect(normalizeWebAccessConfig({ engine: 'duckduckgo' }).engine).toBe('duckduckgo');
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
    const html = '<html><head><title>标题A</title><style>a{color:red}</style></head><body><script>x</script><p>正文A</p></body></html>';
    const res = await fetchWebPage('https://example.com/p', cfg(), { fetchImpl: okFetch(html) });
    expect(res.error).toBeUndefined();
    expect(res.title).toBe('标题A');
    expect(res.content).toContain('正文A');
    expect(res.content).not.toContain('color:red');
    expect(res.truncated).toBe(false);
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
