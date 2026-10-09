/**
 * 阶段 10：HTML 抽取单测（零依赖解析器的行为契约）。
 * 用例形态尽量贴近真实页面：脚本/样式必须排除、实体必须解码、标题要能取出。
 */
import { describe, expect, it } from 'vitest';
import {
  collapseSpace,
  decodeEntities,
  extractReadableText,
  extractTitle,
  htmlToText,
  parseSearchResultsHtml,
  stripTags
} from './html';

const ESCAPED_TARGET = 'https%3A%2F%2Fexample.com%2Fa%3Fq%3D1';

function ddgHtml(): string {
  return [
    '<html><body>',
    '<div class="result results_links results_links_deep web-result">',
    '<div class="links_main links_deep result__body">',
    '<h2 class="result__title">',
    `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${ESCAPED_TARGET}&amp;rut=abc">Example &amp; Co</a>`,
    '</h2>',
    '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">这是<b>摘要</b>文本</a>',
    '</div></div>',
    '<div class="result results_links web-result">',
    '<h2 class="result__title">',
    '<a class="result__a" href="https://second.example.org/post">第二条 &quot;标题&quot;</a>',
    '</h2>',
    '<a class="result__snippet" href="https://second.example.org/post">第二条摘要</a>',
    '</div>',
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fonly-title.example%2F">只有标题没有摘要</a>',
    '</body></html>'
  ].join('\n');
}

describe('实体解码与标签剥离', () => {
  it('常见实体与数字实体都能解码', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeEntities('&nbsp;|&hellip;')).toBe(' |…');
    expect(decodeEntities('&unknown_entity;')).toBe('&unknown_entity;');
  });

  it('stripTags 去掉标签保留文本', () => {
    expect(stripTags('<p>你好<br/>世界</p>')).toBe(' 你好 世界 ');
  });

  it('collapseSpace 折叠连续空白', () => {
    expect(collapseSpace('  a   b \n\t c  ')).toBe('a b c');
  });

  it('htmlToText = 去标签 + 解码 + 折叠', () => {
    expect(htmlToText('<b>Tom &amp; Jerry</b>')).toBe('Tom & Jerry');
  });
});

describe('parseSearchResultsHtml（结果页抽取）', () => {
  it('按出现顺序抽出标题链接与摘要，缺摘要的条目摘要为空', () => {
    const items = parseSearchResultsHtml(ddgHtml());
    expect(items).toHaveLength(3);
    expect(items[0]?.title).toBe('Example & Co');
    expect(items[0]?.href).toContain('uddg=');
    expect(items[0]?.snippet).toBe('这是摘要文本');
    expect(items[1]?.title).toBe('第二条 "标题"');
    expect(items[1]?.snippet).toBe('第二条摘要');
    expect(items[2]?.snippet).toBe('');
  });

  it('空输入/无结果页返回空数组（由上层报可见错误，不在解析层伪装成功）', () => {
    expect(parseSearchResultsHtml('')).toEqual([]);
    expect(parseSearchResultsHtml('<html><body>没有结果</body></html>')).toEqual([]);
  });
});

describe('extractReadableText（页面正文抽取）', () => {
  it('取出标题并排除脚本/样式/导航噪声', () => {
    const html = [
      '<html><head><title>页面标题</title><style>body{color:red}</style></head><body>',
      '<script>alert("不该出现")</script>',
      '<nav>导航 不该出现</nav>',
      '<article><h1>正文标题</h1><p>第一段内容。</p><p>第二段内容。</p></article>',
      '<footer>页脚 不该出现</footer>',
      '</body></html>'
    ].join('');
    const out = extractReadableText(html, 5000);
    expect(out.title).toBe('页面标题');
    expect(out.content).toContain('第一段内容。');
    expect(out.content).toContain('第二段内容。');
    expect(out.content).not.toContain('alert');
    expect(out.content).not.toContain('color:red');
    expect(out.content).not.toContain('导航');
    expect(out.content).not.toContain('页脚');
  });

  it('超出上限即截断并标记 truncated', () => {
    const html = `<p>${'很长的内容'.repeat(200)}</p>`;
    const out = extractReadableText(html, 20);
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBe(20);
  });

  it('无 title 时 title 缺省，空体返回空 content', () => {
    const out = extractReadableText('<p>你好</p>', 100);
    expect(out.title).toBeUndefined();
    expect(out.content).toBe('你好');
    expect(extractReadableText('<script>x</script>', 100).content).toBe('');
  });

  it('extractTitle 单独可用；缺失/空返回 undefined', () => {
    expect(extractTitle('<title>  标题  </title>')).toBe('标题');
    expect(extractTitle('<p>无标题</p>')).toBeUndefined();
    expect(extractTitle('<title>   </title>')).toBeUndefined();
  });
});
