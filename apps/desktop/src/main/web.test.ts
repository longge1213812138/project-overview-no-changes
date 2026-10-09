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
import { DEFAULT_WEB_ACCESS_CONFIG } from '@fairy/core'
import type { FairyConfig } from './config'
import { getWebConfig, isWebEnabled, runWebRetrieval, saveWebConfig, testWebSearch } from './web'

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

const DDG_URL = 'https://html.duckduckgo.com/html/'

function resultHtml(entries: { url: string; title: string; snippet: string }[]): string {
  return `<html><body>${entries
    .map(
      (e) =>
        `<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(e.url)}">${e.title}</a></h2>` +
        `<a class="result__snippet" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(e.url)}">${e.snippet}</a>`
    )
    .join('\n')}</body></html>`
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

afterEach(() => {
  cfgState.current = {}
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
    expect(first.config?.engine).toBe('duckduckgo')

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
      url.startsWith(DDG_URL)
        ? new Response(
            resultHtml([
              { url: 'https://example.com/a', title: '来源一', snippet: '摘要一' },
              { url: 'https://example.com/b', title: '来源二', snippet: '摘要二' }
            ]),
            { status: 200 }
          )
        : new Response('<html><head><title>正文标题</title></head><body><p>页面正文内容</p></body></html>', {
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
      if (url.startsWith(DDG_URL)) {
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
        : new Response('<html><head><title>正文标题</title></head><body><p>正文</p></body></html>', { status: 200 })
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
      url.startsWith(DDG_URL)
        ? new Response(
            resultHtml([
              { url: 'https://spam.example/a', title: '黑名单来源', snippet: '不该出现' },
              { url: 'https://docs.example/b', title: '正常来源', snippet: '应保留' }
            ]),
            { status: 200 }
          )
        : new Response('<html><body><p>正文</p></body></html>', { status: 200 })
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
        ? new Response('<html><head><title>文章标题</title></head><body><p>文章内容</p></body></html>', { status: 200 })
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
