/**
 * 阶段 10：URL 安全守卫单测（DEV_PLAN §5.10「资料来源范围」）。
 * LLM 与检索引擎返回的链接都可能是恶意的：这里把所有「不该访问」的形态钉死。
 */
import { describe, expect, it } from 'vitest';
import { checkWebUrl, domainMatches, isBlockedHost, normalizeResultUrl, urlDedupeKey, urlHost } from './urlguard';

describe('checkWebUrl 协议与基本形态', () => {
  it('接受常规 https/http 地址', () => {
    expect(checkWebUrl('https://example.com/docs').ok).toBe(true);
    expect(checkWebUrl('http://news.example.org/a?b=1').ok).toBe(true);
  });

  it('拒绝非 http/https 协议（file/ftp/data/javascript）', () => {
    for (const url of [
      'file:///C:/Windows/win.ini',
      'ftp://example.com/a.txt',
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)'
    ]) {
      expect(checkWebUrl(url).ok, url).toBe(false);
    }
  });

  it('拒绝携带凭据的 URL', () => {
    expect(checkWebUrl('https://user:pass@example.com/').ok).toBe(false);
    expect(checkWebUrl('https://user:pass@example.com/').reason).toContain('凭据');
  });

  it('拒绝空串与无法解析的字符串', () => {
    expect(checkWebUrl('').reason).toBe('URL 为空');
    expect(checkWebUrl('   ').ok).toBe(false);
    expect(checkWebUrl('不是一个地址').ok).toBe(false);
  });

  it('拒绝非默认端口（内网服务探测面）', () => {
    expect(checkWebUrl('http://example.com:8080/x').ok).toBe(false);
    expect(checkWebUrl('https://example.com:8443/x').ok).toBe(false);
    expect(checkWebUrl('https://example.com:443/x').ok).toBe(true);
  });
});

describe('checkWebUrl 内网/本机（SSRF）', () => {
  it('拒绝回环与本机命名', () => {
    for (const url of [
      'http://127.0.0.1/admin',
      'http://localhost:80/x',
      'https://::1/x',
      'http://host.local/x'
    ]) {
      expect(checkWebUrl(url).ok, url).toBe(false);
    }
  });

  it('拒绝私有网段与元数据地址', () => {
    for (const url of [
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.9.9/x',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/x',
      'http://0.0.0.0/x'
    ]) {
      expect(checkWebUrl(url).ok, url).toBe(false);
    }
  });

  it('拒绝 IPv6 保留段（唯一本地/链路本地/IPv4 映射）', () => {
    expect(checkWebUrl('http://[fc00::1]/x').ok).toBe(false);
    expect(checkWebUrl('http://[fe80::1]/x').ok).toBe(false);
    expect(checkWebUrl('http://[::ffff:127.0.0.1]/x').ok).toBe(false);
  });

  it('公网地址放行（不得误伤）', () => {
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedHost('8.8.8.8')).toBe(false);
    expect(checkWebUrl('https://8.8.8.8/').ok).toBe(true);
  });
});

describe('normalizeResultUrl（引擎跳转 → 真实目标）', () => {
  it('解开 uddg 包装并解码', () => {
    const out = normalizeResultUrl(
      '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fq%3D1&rut=abc',
      'https://html.duckduckgo.com/html/'
    );
    expect(out).toBe('https://example.com/a?q=1');
  });

  it('协议相对 URL 补 https', () => {
    expect(normalizeResultUrl('//example.com/x', 'https://base/')).toBe('https://example.com/x');
  });

  it('相对路径按 base 解析；不可解析返回 undefined', () => {
    expect(normalizeResultUrl('/docs/a', 'https://example.com/')).toBe('https://example.com/docs/a');
    expect(normalizeResultUrl('', 'https://example.com/')).toBeUndefined();
  });
});

describe('urlDedupeKey / urlHost / domainMatches', () => {
  it('去重键忽略 hash、尾斜杠与常见跟踪参数', () => {
    expect(urlDedupeKey('https://example.com/a?utm_source=x#top')).toBe(
      urlDedupeKey('https://example.com/a')
    );
    expect(urlDedupeKey('https://example.com/a/')).toBe(urlDedupeKey('https://example.com/a'));
    expect(urlDedupeKey('https://example.com/a')).not.toBe(urlDedupeKey('https://example.com/b'));
  });

  it('Key 对大小写主机名归一', () => {
    expect(urlDedupeKey('https://Example.com/A')).toBe(urlDedupeKey('https://example.com/A'));
  });

  it('urlHost 取小写主机名；非法地址返回空串', () => {
    expect(urlHost('https://EXample.com/a')).toBe('example.com');
    expect(urlHost('not-a-url')).toBe('');
  });

  it('domainMatches 后缀匹配且不误命中前缀相同域名', () => {
    expect(domainMatches('a.example.com', 'example.com')).toBe(true);
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('notexample.com', 'example.com')).toBe(false);
  });
});

/** Bing 跳转包装（备用引擎的部分变体）：/ck/a?…u=a1<base64url> → 真实目标 */
describe('normalizeResultUrl：Bing 跳转包装解包', () => {
  it('bing.com 的 /ck/a + u=a1<base64url> → 解出真实 URL', () => {
    const target = 'https://nodejs.org/zh-cn?x=1&y=2';
    const wrapped = Buffer.from(target, 'utf8').toString('base64url');
    const href = `https://www.bing.com/ck/a?!&&p=abc&u=a1${wrapped}&ntb=1`;
    expect(normalizeResultUrl(href, 'https://www.bing.com/search')).toBe(target);
  });

  it('非 bing 域 / 非 /ck/a 路径不当作包装（防误解）', () => {
    const fake = 'https://evil.example/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8';
    expect(normalizeResultUrl(fake, 'https://base.example/')).toBe(fake);
    const notCk = 'https://www.bing.com/search?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8';
    expect(normalizeResultUrl(notCk, 'https://base.example/')).toBe(notCk);
  });

  it('Bing 直链（实测主形态）与相对路径照常归一', () => {
    expect(normalizeResultUrl('https://nodejs.org/zh-cn', 'https://www.bing.com/search')).toBe(
      'https://nodejs.org/zh-cn'
    );
    expect(normalizeResultUrl('/docs/a', 'https://www.bing.com/search')).toBe(
      'https://www.bing.com/docs/a'
    );
  });
});
