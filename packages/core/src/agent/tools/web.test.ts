/**
 * 阶段 10：联网内置工具单测（web_search / web_fetch）。
 * 验证注册元数据（恒 ask / risk=read）、入参严格校验、URL 守卫前置拒绝，
 * 以及「失败返给模型而不是抛伪成功」的执行语义。网络实现全部注入假对象，不触真实网络。
 */
import { describe, expect, it, vi } from 'vitest';
import { createWebTools } from './web';
import type { WebFetchResult, WebSearchResult } from '../../web/types';

function build(overrides: {
  search?: (query: string, opts: { maxResults?: number; signal?: AbortSignal }) => Promise<WebSearchResult>;
  fetchPage?: (url: string, opts: { maxChars?: number; signal?: AbortSignal }) => Promise<WebFetchResult>;
} = {}) {
  const calls: { url: string; opts: unknown }[] = [];
  const search =
    overrides.search ??
    (async (query: string): Promise<WebSearchResult> => ({
      query,
      engine: 'duckduckgo',
      items: [{ title: '标题', url: 'https://example.com/a', snippet: '摘要' }]
    }));
  const fetchPage =
    overrides.fetchPage ??
    (async (url: string, opts: { maxChars?: number }): Promise<WebFetchResult> => {
      calls.push({ url, opts });
      return { url, title: '页面标题', content: '正文内容', truncated: false };
    });
  const [searchTool, fetchTool] = createWebTools({ search, fetchPage });
  return { searchTool, fetchTool, calls };
}

describe('web_search 注册项', () => {
  it('元数据：ask + read + builtin（模型主动调用也需用户确认）', () => {
    const { searchTool } = build();
    expect(searchTool.tool.definition.function.name).toBe('web_search');
    expect(searchTool.approval).toBe('ask');
    expect(searchTool.risk).toBe('read');
    expect(searchTool.source).toBe('builtin');
  });

  it('validateInput：query 必填非空，maxResults 1-10，未知键拒绝', () => {
    const { searchTool } = build();
    expect(searchTool.tool.validateInput({ query: 'a' })).toBe(true);
    expect(searchTool.tool.validateInput({ query: 'a', maxResults: 5 })).toBe(true);
    expect(searchTool.tool.validateInput({})).toBe(false);
    expect(searchTool.tool.validateInput({ query: '   ' })).toBe(false);
    expect(searchTool.tool.validateInput({ query: 'a', maxResults: 11 })).toBe(false);
    expect(searchTool.tool.validateInput({ query: 'a', maxResults: 0 })).toBe(false);
    expect(searchTool.tool.validateInput({ query: 'a', maxResults: 1.5 })).toBe(false);
    expect(searchTool.tool.validateInput({ query: 'a', extra: 1 })).toBe(false);
    expect(searchTool.tool.validateInput('a')).toBe(false);
    expect(searchTool.tool.validateInput([])).toBe(false);
  });

  it('assess：结构与长度 Defense；超长检索词直接 deny（不进审批）', () => {
    const { searchTool } = build();
    expect(searchTool.assess?.({ query: '正常问题' })).toEqual({ decision: 'allow' });
    expect(searchTool.assess?.({ query: 'x'.repeat(201) })?.decision).toBe('deny');
    expect(searchTool.assess?.({ query: '' })?.decision).toBe('deny');
  });

  it('execute：结果原样返给模型；错误以 error 字段传递（不抛、不伪装成功）', async () => {
    const { searchTool } = build({
      search: async () => ({ query: 'q', engine: 'duckduckgo', items: [], error: '检索请求超时' })
    });
    const out = await searchTool.tool.execute({ query: 'q' }, {});
    expect(out).toEqual({ query: 'q', count: 0, items: [], error: '检索请求超时' });
  });

  it('execute：透传 maxResults 与中止信号', async () => {
    const seen: { maxResults?: number; hadSignal?: boolean }[] = [];
    const { searchTool } = build({
      search: async (query, opts) => {
        seen.push({ maxResults: opts.maxResults, hadSignal: opts.signal !== undefined });
        return { query, engine: 'duckduckgo', items: [] };
      }
    });
    const controller = new AbortController();
    await searchTool.tool.execute({ query: 'q', maxResults: 3 }, { signal: controller.signal });
    expect(seen[0]).toEqual({ maxResults: 3, hadSignal: true });
  });

  it('execute：signal 已取消 → 抛 AbortError', async () => {
    const { searchTool } = build();
    const controller = new AbortController();
    controller.abort();
    await expect(searchTool.tool.execute({ query: 'q' }, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    });
  });

  it('execute：底层实现被调用于清洗后的检索词', async () => {
    const spy = vi.fn(async (query: string) => ({ query, engine: 'duckduckgo' as const, items: [] }));
    const [searchTool] = createWebTools({
      search: spy,
      fetchPage: async (url) => ({ url, title: '', content: '', truncated: false })
    });
    await searchTool.tool.execute({ query: '  Rust 所有权  ' }, {});
    expect(spy).toHaveBeenCalledWith('Rust 所有权', expect.anything());
  });

  /**
   * 正文摘录透传：模型要靠它一次调用拿到事实（摘要多是首页 SEO 样板），
   * 空摘录/缺字段一律不落进输出（不给模型掺空壳）。
   */
  it('execute：items 带 content 摘录（空摘录不落字段）', async () => {
    const [searchTool] = createWebTools({
      search: async (query) => ({
        query,
        engine: 'bing' as const,
        items: [
          { title: '有正文', url: 'https://a.example/', snippet: '摘要一', content: '页面正文摘录' },
          { title: '空摘录', url: 'https://b.example/', snippet: '摘要二', content: '   ' },
          { title: '无字段', url: 'https://c.example/', snippet: '摘要三' }
        ]
      }),
      fetchPage: async (url) => ({ url, title: '', content: '', truncated: false })
    });

    const out = (await searchTool.tool.execute({ query: 'q' }, {})) as {
      items: { title: string; content?: string }[]
    };
    expect(out.items[0]?.content).toBe('页面正文摘录');
    expect(out.items[1]).not.toHaveProperty('content');
    expect(out.items[2]).not.toHaveProperty('content');
  });
});

describe('web_fetch 注册项', () => {
  it('元数据：ask + read + builtin', () => {
    const { fetchTool } = build();
    expect(fetchTool.tool.definition.function.name).toBe('web_fetch');
    expect(fetchTool.approval).toBe('ask');
    expect(fetchTool.risk).toBe('read');
  });

  it('validateInput：url 必填，maxChars 500-20000', () => {
    const { fetchTool } = build();
    expect(fetchTool.tool.validateInput({ url: 'https://example.com/a' })).toBe(true);
    expect(fetchTool.tool.validateInput({ url: 'https://example.com/a', maxChars: 1000 })).toBe(true);
    expect(fetchTool.tool.validateInput({ url: '' })).toBe(false);
    expect(fetchTool.tool.validateInput({})).toBe(false);
    expect(fetchTool.tool.validateInput({ url: 'https://a.example/', maxChars: 499 })).toBe(false);
    expect(fetchTool.tool.validateInput({ url: 'https://a.example/', maxChars: 20001 })).toBe(false);
  });

  it('assess：内网/非 http(s)/带凭据 URL 直接 deny 且不进审批', () => {
    const { fetchTool } = build();
    for (const url of [
      'http://127.0.0.1/x',
      'http://169.254.169.254/latest',
      'file:///C:/secret',
      'https://user:pwd@example.com/'
    ]) {
      const r = fetchTool.assess?.({ url });
      expect(r?.decision, url).toBe('deny');
      expect(r?.reason).toBeTruthy();
    }
    expect(fetchTool.assess?.({ url: 'https://example.com/a' })).toEqual({ decision: 'allow' });
  });

  it('execute：成功返回标题/正文/截断标记；失败返回 error 字段', async () => {
    const { fetchTool } = build({
      fetchPage: async (url) => (url.includes('bad') ? { url, title: '', content: '', truncated: false, error: '页面返回 HTTP 404' } : { url, title: 'T', content: 'C', truncated: true })
    });
    expect(await fetchTool.tool.execute({ url: 'https://example.com/ok' }, {})).toEqual({
      url: 'https://example.com/ok',
      title: 'T',
      content: 'C',
      truncated: true
    });
    expect(await fetchTool.tool.execute({ url: 'https://example.com/bad' }, {})).toEqual({
      url: 'https://example.com/bad',
      error: '页面返回 HTTP 404'
    });
  });

  it('execute：防御纵深 —— 绕过 assess 直调时仍被 URL 守卫拦住', async () => {
    const { fetchTool } = build();
    await expect(fetchTool.tool.execute({ url: 'http://localhost/x' }, {})).rejects.toThrow(/内网|安全校验/);
  });

  it('execute：maxChars 透传，signal 已取消抛 AbortError', async () => {
    const { fetchTool, calls } = build();
    await fetchTool.tool.execute({ url: 'https://example.com/a', maxChars: 1200 }, {});
    expect(calls[0]?.opts).toEqual({ maxChars: 1200 });

    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchTool.tool.execute({ url: 'https://example.com/a' }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
