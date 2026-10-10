/**
 * 阶段 10：联网编排（main）单测（DEV_PLAN §5.10）。
 *
 * mock 面：./config（内存配置，不落真实磁盘、不碰 electron）、./logger（vi.fn）。
 * 网络面：stub 全局 fetch —— 编排层（web.ts）走 @fairy/core 的默认 fetch，
 * 没有 IO 注入参数，因此这里替换 globalThis.fetch 以保证测试永不触真实网络。
 * 这里的关注点是「编排」：开关/触发走向、失败走向、配置落盘与夹取；
 * 解析与筛选的细节在 @fairy/core 的 web 单测里钉死。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WEB_ACCESS_CONFIG, resetEngineHealth } from '@fairy/core'
import type { FairyConfig } from './config'
import {
  TOOL_EXCERPT_CHARS,
  buildWebNotice,
  createWebToolDeps,
  describeWebFailure,
  getWebConfig,
  isWebEnabled,
  runWebRetrieval,
  saveWebConfig,
  testWebSearch
} from './web'

const cfgState: { current: FairyConfig } = { current: {} }

vi.mock('./logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('./config', () => ({
  loadConfig: () => cfgState.current,
  saveConfig: (next: FairyConfig) => {
    cfgState.current = next
  }
}))

/** 当前唯一检索引擎（Bing）的端点：断言「只打 bing」用它 */
const BING_URL = 'https://www.bing.com/search'

/** 可读正文占位（≥ MIN_READABLE_CHARS=200）：否则会被「正文过短」守卫按导航页拦下 */
const LONG_BODY = `<p>${'正文内容'.repeat(60)}</p>`

/** Bing 结果页（结构与 2026-10 实测一致：b_algo → h2>a 直链 + b_caption>p 摘要） */
function resultHtml(entries: { url: string; title: string; snippet: string }[]): string {
  const parts = entries.map(
    (e) =>
      `<li class="b_algo" data-id iid=SERP.1><h2><a target="_blank" href="${e.url}"><strong>${e.title}</strong></a></h2>` +
      `<div class="b_caption"><p class="b_lineclamp2">${e.snippet}` +
      `<a class="b_algoReadMore" href="${e.url}">阅读更多</a></p></div></li>`
  )
  return `<html><body><ol id="b_results">${parts.join('')}</ol></body></html>`
}

/** stub 全局 fetch：按 URL 前缀返回不同内容 */
function stubFetch(impl: (url: string) => Response): { restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request) =>
    Promise.resolve(impl(String(input)))) as unknown as typeof fetch
  return {
    restore: () => {
      globalThis.fetch = original
    }
  }
}

/**
 * 异步版 stub：需要「挂住直到被中止」或「reject」的场景（超时/连接失败）用它。
 * init.signal 到点即 reject（与真实 fetch 的中止语义一致）。
 */
function stubFetchAsync(
  impl: (url: string, init?: RequestInit) => Promise<Response>
): { restore: () => void } {
  const original = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    impl(String(input), init)) as unknown as typeof fetch
  return {
    restore: () => {
      globalThis.fetch = original
    }
  }
}

/** 挂住直到被中止的响应（模拟「源不可达」：连接建立后不返回） */
function hangUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })
}

afterEach(() => {
  cfgState.current = {}
  resetEngineHealth() // 引擎可达性记忆是 core 侧模块级状态：用例之间必须清掉
  vi.restoreAllMocks()
})

describe('getWebConfig / isWebEnabled（缺省与容脏）', () => {
  it('没有 web 段 → 取 core 默认值', () => {
    expect(getWebConfig()).toEqual(DEFAULT_WEB_ACCESS_CONFIG)
    expect(isWebEnabled()).toBe(DEFAULT_WEB_ACCESS_CONFIG.enabled)
  })

  it('脏值被夹取后再出（契约层不因脏配置崩溃）', () => {
    cfgState.current = {
      ...cfgState.current,
      web: { ...DEFAULT_WEB_ACCESS_CONFIG, enabled: false, maxResults: 99, fetchTopN: 9 }
    }
    const cfg = getWebConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.maxResults).toBe(10)
    expect(cfg.fetchTopN).toBe(3)
    expect(isWebEnabled()).toBe(false)
  })
})

describe('saveWebConfig（局部更新 + 落盘往返）', () => {
  it('局部更新：未提及的字段保留，越界值夹取', () => {
    const first = saveWebConfig({ enabled: true, maxResults: 4 })
    expect(first.ok).toBe(true)
    expect(first.config?.maxResults).toBe(4)
    expect(first.config?.engine).toBe('bing') // 只用 Bing：配置层也归一

    const second = saveWebConfig({ fetchTopN: 99 })
    expect(second.config?.fetchTopN).toBe(3) // 夹到硬上限
    expect(second.config?.maxResults).toBe(4) // 上一轮的字段仍在
    expect(getWebConfig().maxResults).toBe(4)
  })

  it('域名列表归一化：去空白转小写，空项剔除', () => {
    const res = saveWebConfig({ allowedDomains: [' Example.com ', ''], blockedDomains: ['SPAM.net'] })
    expect(res.config?.allowedDomains).toEqual(['example.com'])
    expect(res.config?.blockedDomains).toEqual(['spam.net'])
  })
})

describe('runWebRetrieval 编排走向', () => {
  it('未命中触发规则 → 返回 null（管线应跳过注入，不塞空块）', async () => {
    await expect(runWebRetrieval('帮我写一封请假邮件')).resolves.toBeNull()
  })

  it('命中规则但开关关闭 → 返回 null（不再外发任何请求）', async () => {
    cfgState.current = { ...cfgState.current, web: { ...DEFAULT_WEB_ACCESS_CONFIG, enabled: false } }
    await expect(runWebRetrieval('联网搜一下 Node LTS 最新版本')).resolves.toBeNull()
  })

  it('检索成功 → block 含引用块与规范，sources 编号连续', async () => {
    const net = stubFetch((url) =>
      url.startsWith(BING_URL)
        ? new Response(
            resultHtml([
              { url: 'https://example.com/a', title: '来源一', snippet: '摘要一' },
              { url: 'https://example.com/b', title: '来源二', snippet: '摘要二' }
            ]),
            { status: 200 }
          )
        : new Response(`<html><head><title>正文标题</title></head><body>${LONG_BODY}</body></html>`, {
            status: 200
          })
    )
    try {
      const out = await runWebRetrieval('联网搜一下 Node LTS 最新版本')
      expect(out).not.toBeNull()
      expect(out?.block).toContain('【联网检索结果】')
      expect(out?.block).toContain('[1] 来源一')
      expect(out?.block).toContain('链接：https://example.com/a')
      expect(out?.block).toContain('【引用规范】')
      expect(out?.sources.map((s) => s.id)).toEqual([1, 2])
      expect(out?.sources[0]?.url).toBe('https://example.com/a')
    } finally {
      net.restore()
    }
  })

  it('检索失败 → block 是失败说明（模型据此如实说明），sources 为空', async () => {
    const net = stubFetch(() => new Response('service unavailable', { status: 503 }))
    try {
      const out = await runWebRetrieval('最新一期 Node LTS 是哪个版本')
      expect(out?.sources).toEqual([])
      expect(out?.block).toContain('本次尝试联网检索失败')
      expect(out?.block).toContain('不要凭记忆编造外部事实')
    } finally {
      net.restore()
    }
  })

  it('部分失败：部分来源成功、部分正文抓取失败 → 成功来源仍在，警告进 block', async () => {
    const net = stubFetch((url) => {
      if (url.startsWith(BING_URL)) {
        return new Response(
          resultHtml([
            { url: 'https://example.com/ok', title: '可用来源', snippet: '摘要' },
            { url: 'https://example.com/bad', title: '抓不到来源', snippet: '摘要' }
          ]),
          { status: 200 }
        )
      }
      return url.includes('bad')
        ? new Response('not found', { status: 404 })
        : new Response(`<html><head><title>正文标题</title></head><body>${LONG_BODY}</body></html>`, {
            status: 200
          })
    })
    try {
      const out = await runWebRetrieval('联网查一下最新进展')
      expect(out?.sources).toHaveLength(2)
      expect(out?.block).toContain('可用来源')
      expect(out?.block).toContain('【检索提示】')
    } finally {
      net.restore()
    }
  })

  it('域名黑名单生效：命中来源不进上下文', async () => {
    cfgState.current = { ...cfgState.current, web: { ...DEFAULT_WEB_ACCESS_CONFIG, blockedDomains: ['spam.example'] } }
    const net = stubFetch((url) =>
      url.startsWith(BING_URL)
        ? new Response(
            resultHtml([
              { url: 'https://spam.example/a', title: '黑名单来源', snippet: '不该出现' },
              { url: 'https://docs.example/b', title: '正常来源', snippet: '应保留' }
            ]),
            { status: 200 }
          )
        : new Response(`<html><body>${LONG_BODY}</body></html>`, { status: 200 })
    )
    try {
      const out = await runWebRetrieval('联网查一下资料')
      expect(out?.sources.map((s) => s.url)).toEqual(['https://docs.example/b'])
      expect(out?.block).not.toContain('黑名单来源')
    } finally {
      net.restore()
    }
  })

  it('直达链接模式：抽该类链接为来源（抓不到的走失败块，不伪装成功）', async () => {
    const net = stubFetch((url) =>
      url === 'https://example.com/post'
        ? new Response(`<html><head><title>文章标题</title></head><body>${LONG_BODY}</body></html>`, {
            status: 200
          })
        : new Response('no', { status: 404 })
    )
    try {
      const out = await runWebRetrieval('总结一下 https://example.com/post 的要点')
      expect(out?.sources).toHaveLength(1)
      expect(out?.sources[0]?.title).toBe('文章标题')
      expect(out?.block).toContain('正文摘录')
    } finally {
      net.restore()
    }
  })
})

/**
 * 阶段 10 硬化：超时的用户可见结论（提示条口径）。
 * 纯函数口径先钉死：超时 ≠ 失败 ≠ 部分成功，措辞不能混。
 */
describe('buildWebNotice / describeWebFailure（超时口径）', () => {
  it('没取到资料 + 超时 → kind=timeout（建议重试）', () => {
    const notice = buildWebNotice({
      engine: 'duckduckgo',
      timedOut: true,
      sources: [],
      warnings: [],
      elapsedMs: 25_000
    })
    expect(notice?.kind).toBe('timeout')
    expect(notice?.message).toContain('超时')
    expect(notice?.message).toContain('重试')
  })

  it('没取到资料 + 源不可达 → kind=failed（说清是源的问题）', () => {
    const notice = buildWebNotice({
      engine: 'duckduckgo',
      timedOut: false,
      sources: [],
      warnings: [],
      failure: { message: '检索失败：fetch failed', kind: 'network' },
      elapsedMs: 10_700
    })
    expect(notice?.kind).toBe('failed')
    expect(notice?.message).toContain('检索源不可达')
    expect(notice?.message).not.toContain('超时')
  })

  it('有资料 + 部分页面失败 → kind=partial（说清用了几条、缺了几项）', () => {
    const notice = buildWebNotice({
      engine: 'duckduckgo',
      timedOut: false,
      sources: [{ id: 1, title: 'a', url: 'https://a' }],
      warnings: ['https://b 抓取失败（页面返回 HTTP 404）'],
      elapsedMs: 900
    })
    expect(notice?.kind).toBe('partial')
    expect(notice?.message).toContain('1 条来源可用')
    expect(notice?.message).toContain('404')
  })

  it('有资料 + 超时 → kind=timeout 且注明「结果可能不完整」', () => {
    const notice = buildWebNotice({
      engine: 'duckduckgo',
      timedOut: true,
      sources: [
        { id: 1, title: 'a', url: 'https://a' },
        { id: 2, title: 'b', url: 'https://b' }
      ],
      warnings: [],
      elapsedMs: 25_000
    })
    expect(notice?.kind).toBe('timeout')
    expect(notice?.message).toContain('2 条来源')
    expect(notice?.message).toContain('不完整')
  })

  it('一切正常 → 不产生提示（不打扰用户）', () => {
    expect(
      buildWebNotice({
        engine: 'duckduckgo',
        timedOut: false,
        sources: [{ id: 1, title: 'a', url: 'https://a' }],
        warnings: [],
        elapsedMs: 800
      })
    ).toBeUndefined()
  })

  it('降级（主源不可达 → 备用源顶上）→ 提示一次，说清换了源', () => {
    const notice = buildWebNotice({
      engine: 'bing',
      timedOut: false,
      sources: [{ id: 1, title: 'a', url: 'https://a' }],
      warnings: [],
      fallback: { from: 'duckduckgo', reason: '检索失败：fetch failed', observedNow: true },
      elapsedMs: 11_200
    })
    expect(notice?.kind).toBe('degraded')
    expect(notice?.message).toContain('duckduckgo')
    expect(notice?.message).toContain('bing')
    expect(notice?.message).toContain('降级')

    // 命中短期记忆（未亲自观察到失败）→ 安静运行，不打扰用户
    expect(
      buildWebNotice({
        engine: 'bing',
        timedOut: false,
        sources: [{ id: 1, title: 'a', url: 'https://a' }],
        warnings: [],
        fallback: { from: 'duckduckgo', reason: '检索失败：fetch failed', observedNow: false },
        elapsedMs: 700
      })
    ).toBeUndefined()
  })

  it('失败归类措辞：超时/不可达/解析/守卫分开', () => {
    expect(describeWebFailure({ message: '检索请求超时', kind: 'timeout' })).toContain('检索超时')
    expect(describeWebFailure({ message: 'fetch failed', kind: 'network' })).toContain('检索源不可达')
    expect(describeWebFailure({ message: '未能解析', kind: 'parse' })).toContain('解析失败')
    expect(describeWebFailure({ message: '内网地址', kind: 'blocked' })).toContain('安全守卫')
    expect(describeWebFailure({ message: '检索引擎返回 HTTP 429', kind: 'http' })).toBe(
      '检索引擎返回 HTTP 429'
    )
  })
})

describe('runWebRetrieval 超时硬化（部分结果不丢 + 等待有界）', () => {
  const page = (title: string): Response =>
    new Response(`<html><head><title>${title}</title></head><body>${LONG_BODY}</body></html>`, {
      status: 200
    })

  it('抓取超时 → 已取到的来源与正文照常进上下文，并给出 timeout 提示', async () => {
    vi.useFakeTimers()
    const calls: string[] = []
    const net = stubFetchAsync((url, init) => {
      calls.push(url)
      if (url.startsWith(BING_URL)) {
        return Promise.resolve(
          new Response(
            resultHtml([
              { url: 'https://example.com/ok', title: '可用来源', snippet: '摘要一' },
              { url: 'https://example.com/slow', title: '慢来源', snippet: '摘要二' }
            ]),
            { status: 200 }
          )
        )
      }
      // 第二页挂住（源不可达形态）→ 只能靠超时收场
      return url.includes('slow') ? hangUntilAbort(init) : Promise.resolve(page('可用页面'))
    })
    try {
      const pending = runWebRetrieval('联网查一下最新进展')
      await vi.advanceTimersByTimeAsync(13_000)
      const out = await pending
      expect(out).not.toBeNull()
      // 关键：超时不再推翻已取到的资料
      expect(out?.sources).toHaveLength(2)
      expect(out?.block).toContain('可用来源')
      expect(out?.block).toContain('正文摘录')
      expect(out?.block).toContain('【检索提示】')
      expect(out?.notice?.kind).toBe('timeout')
      expect(out?.notice?.message).toContain('2 条来源')
    } finally {
      net.restore()
      vi.useRealTimers()
    }
  })

  it('总预算封顶：余量不够时不再发起注定赶不上的抓取（保住已有资料）', async () => {
    cfgState.current = { ...cfgState.current, web: { ...DEFAULT_WEB_ACCESS_CONFIG, fetchTopN: 3 } }
    vi.useFakeTimers()
    let pageCalls = 0
    const net = stubFetchAsync((url, init) => {
      if (url.startsWith(BING_URL)) {
        return Promise.resolve(
          new Response(
            resultHtml([
              { url: 'https://example.com/a', title: '来源一', snippet: '摘要' },
              { url: 'https://example.com/b', title: '来源二', snippet: '摘要' },
              { url: 'https://example.com/c', title: '来源三', snippet: '摘要' }
            ]),
            { status: 200 }
          )
        )
      }
      pageCalls += 1
      return hangUntilAbort(init) // 每页都挂到超时：默认 12s × 3 页 = 36s > 25s 上限
    })
    try {
      const pending = runWebRetrieval('联网查一下最新进展')
      await vi.advanceTimersByTimeAsync(60_000)
      const out = await pending
      // 25s 上限内只够两次 12s 超时；第 3 页不发起（否则用户白等一轮）
      expect(pageCalls).toBe(2)
      expect(out?.sources).toHaveLength(3)
      expect(out?.block).toContain('剩余预算不足')
      expect(out?.notice?.kind).toBe('timeout')
    } finally {
      net.restore()
      vi.useRealTimers()
    }
  })

  it('检索源不可达（连接失败）→ 失败块 + failed 提示，措辞指向源而非「超时」', async () => {
    const net = stubFetchAsync(() => Promise.reject(new Error('fetch failed')))
    try {
      const out = await runWebRetrieval('最新一期 Node LTS 是哪个版本')
      expect(out?.sources).toEqual([])
      expect(out?.block).toContain('本次尝试联网检索失败')
      expect(out?.notice?.kind).toBe('failed')
      expect(out?.notice?.message).toContain('检索源不可达')
    } finally {
      net.restore()
    }
  })
})

/**
 * **只用 Bing**（生产引擎口径）：一条消息的联网只打 bing，不再"先试 DuckDuckGo 再降级"——
 * 本机 DDG 全域不可达，那种顺序等于每次白等 6–12s（实测首轮 11.3s），还会挤掉正文摘录。
 */
describe('runWebRetrieval：只用 Bing（不再先打 DuckDuckGo）', () => {
  it('检索只请求 bing：块头标注引擎、sources 齐全、零 ddg 请求', async () => {
    cfgState.current = {
      ...cfgState.current,
      web: { ...DEFAULT_WEB_ACCESS_CONFIG, fetchTopN: 0 } // 只看检索链，不抓正文
    }
    const urls: string[] = []
    const net = stubFetchAsync((url) => {
      urls.push(url)
      return Promise.resolve(
        new Response(
          resultHtml([
            { url: 'https://nodejs.org/zh-cn', title: 'Node.js 官网', snippet: 'Node.js 是运行时' }
          ]),
          { status: 200 }
        )
      )
    })
    try {
      const out = await runWebRetrieval('联网查一下 Node LTS 最新版本')
      expect(out?.sources.map((s) => s.url)).toEqual(['https://nodejs.org/zh-cn'])
      expect(out?.block).toContain('引擎：bing')
      expect(out?.notice).toBeUndefined() // 正常完成：不打扰用户
      expect(urls).toHaveLength(1) // 一次就够：没有"先打一个不可达的源"的浪费
      expect(urls[0]?.startsWith(BING_URL)).toBe(true)
      expect(urls.some((u) => u.includes('duckduckgo'))).toBe(false)
    } finally {
      net.restore()
    }
  })

  it('bing 不可达 → 如实失败（没有备用源可换，不假装降级）', async () => {
    cfgState.current = {
      ...cfgState.current,
      web: { ...DEFAULT_WEB_ACCESS_CONFIG, fetchTopN: 0 }
    }
    const net = stubFetchAsync(() => Promise.reject(new Error('fetch failed')))
    try {
      const out = await runWebRetrieval('联网查一下 Node LTS 最新版本')
      expect(out?.sources).toEqual([])
      expect(out?.block).toContain('本次尝试联网检索失败')
      expect(out?.block).not.toContain('已降级')
      expect(out?.notice?.kind).toBe('failed')
      expect(out?.notice?.message).toContain('bing')
    } finally {
      net.restore()
    }
  })
})

/**
 * 工具路径（模型主动调 web_search）要顺带带回正文摘录：
 * 检索摘要多是门户首页 SEO 样板（实测「今天天气怎么样」5 条全是首页简介、零事实），
 * 模型只能反复 web_fetch 猜 URL——每次都弹审批、都吃 Agent 时长预算。
 */
describe('createWebToolDeps：web_search 顺带正文摘录', () => {
  it('前 2 条附摘录、第 3 条不带；摘录失败不影响检索结果', async () => {
    cfgState.current = {
      ...cfgState.current,
      web: { ...DEFAULT_WEB_ACCESS_CONFIG, maxResults: 3 }
    }
    const net = stubFetchAsync((url) => {
      if (url.startsWith(BING_URL)) {
        return Promise.resolve(
          new Response(
            resultHtml([
              { url: 'https://example.com/ok1', title: '来源一', snippet: '摘要一' },
              { url: 'https://example.com/bad', title: '来源二', snippet: '摘要二' },
              { url: 'https://example.com/ok3', title: '来源三', snippet: '摘要三' }
            ]),
            { status: 200 }
          )
        )
      }
      if (url.includes('/bad')) return Promise.resolve(new Response('nope', { status: 404 }))
      return Promise.resolve(new Response(`<html><body>${LONG_BODY}</body></html>`, { status: 200 }))
    })
    try {
      const res = await createWebToolDeps().search('Node LTS 最新版本', {})
      expect(res.items).toHaveLength(3)
      expect(res.items[0]?.content).toContain('正文内容')
      expect(res.items[0]?.content?.length).toBeLessThanOrEqual(TOOL_EXCERPT_CHARS)
      expect(res.items[1]?.content).toBeUndefined() // 抓取失败 → 该条退回纯摘要，不影响其它条
      expect(res.items[2]?.content).toBeUndefined() // 只摘前 2 条（预算控制）
      expect(res.error).toBeUndefined()
      expect(res.items[1]?.snippet).toBe('摘要二')
    } finally {
      net.restore()
    }
  })
})

describe('testWebSearch（设置页试跑）', () => {
  it('开关关闭 → 明确提示先开启（不静默返回空结果）', async () => {
    cfgState.current = { ...cfgState.current, web: { ...DEFAULT_WEB_ACCESS_CONFIG, enabled: false } }
    const res = await testWebSearch('abc')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('请先开启')
  })

  it('空检索词 → 可见错误', async () => {
    await expect(testWebSearch('   ')).resolves.toEqual({ ok: false, error: '检索词为空' })
  })

  it('链路通 → 返回带编号的来源列表', async () => {
    const net = stubFetch(() =>
      new Response(
        resultHtml([{ url: 'https://example.com/a', title: '标题', snippet: '摘要' }]),
        { status: 200 }
      )
    )
    try {
      const res = await testWebSearch('abc')
      expect(res.ok).toBe(true)
      expect(res.items).toEqual([
        { id: 1, title: '标题', url: 'https://example.com/a', snippet: '摘要' }
      ])
    } finally {
      net.restore()
    }
  })
})
