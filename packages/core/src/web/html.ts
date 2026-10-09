/**
 * 阶段 10：HTML 处理（零依赖，DEV_PLAN §5.10「数据筛选」的落地处）。
 *
 * 三方workers：
 * - `stripTags/decodeEntities/collapseSpace`：把 HTML 片段变成可读纯文本
 *   （检索引擎的标题/摘要、抓取页面的正文都用它）；
 * - `parseSearchResultsHtml`：从检索引擎返回的 HTML 里抽结构化结果；
 * - `extractReadableText`：页面 → {title, content}，去掉脚本/样式/导航等噪声。
 *
 * 为什么自己写而不用 jsdom/cheerio：本项目不引入新依赖，且这里只需要「够用且稳定」的
 * 标签级抽取。解析器对畸形 HTML 容忍（正则 + 状态无关），解析不出结果时由上层
 * 以 `error` 形式**可见失败**，绝不返回伪装成功的空块。
 */

/** 需要整体丢弃的内容区块（成对标签内的全部内容） */
const DROP_BLOCK_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form'];

/** 语义噪声区块（导航/页脚/侧栏/广告），同样整体丢弃 */
const DROP_NOISE_TAGS = ['nav', 'footer', 'aside', 'header'];

/** HTML 实体解码表（够用集：常见 named + numeric） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  lscr: 'ℓ'
};

/** 解码 HTML 实体（含十进制/十六进制数字实体） */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const digits = isHex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const key = body.toLowerCase();
    return NAMED_ENTITIES[key] ?? match;
  });
}

/**
 * 内联标签清单：这些标签 strip 时不插空格，
 * 否则引擎用于高亮关键词的 `<b>关键词</b>` 会把中文词组撕出空格（"摘要 文本"）。
 */
const INLINE_TAG_PATTERN = /<\/?(b|i|em|strong|span|code|u|s|small|sup|sub|mark|a|abbr|cite|kbd|q)\b[^>]*>/gi;

/**
 * 去掉全部标签（保留文本），并解码实体。
 * 内联标签直接删除（不插空格），其余按块级处理插入空格，避免词被粘成一团。
 */
export function stripTags(html: string): string {
  const withoutInline = html.replace(INLINE_TAG_PATTERN, '');
  return decodeEntities(withoutInline.replace(/<[^>]*>/g, ' '));
}

/** 空白折叠（连续空白 → 单个空格；首尾去空白） */
export function collapseSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** HTML 片段 → 可读纯文本（去标签 + 解码 + 折叠空白） */
export function htmlToText(html: string): string {
  return collapseSpace(stripTags(html));
}

/** 移除指定的成对标签块（大小写不敏感，含多行内容） */
function removeTags(html: string, tags: readonly string[]): string {
  let out = html;
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');
  }
  return out;
}

/** 提取 <title> 文本；无 title 返回 undefined */
export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!m) return undefined;
  const title = htmlToText(m[1] ?? '');
  return title === '' ? undefined : title;
}

/**
 * 页面 HTML → 正文纯文本与标题。
 * @param html 原始 HTML
 * @param maxChars 正文字符上限（超出截断并标记 truncated）
 */
export function extractReadableText(
  html: string,
  maxChars: number
): { title?: string; content: string; truncated: boolean } {
  const title = extractTitle(html);
  let body = html;
  body = removeTags(body, DROP_BLOCK_TAGS);
  body = removeTags(body, DROP_NOISE_TAGS);
  body = body.replace(/<!--[\s\S]*?-->/g, ' '); // HTML 注释
  body = body.replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, '\n'); // 块级换行粗糙近似
  let content = htmlToText(body);
  content = content
    .split('\n')
    .map((line) => collapseSpace(line))
    .filter((line) => line !== '')
    .join('\n');
  let truncated = false;
  if (content.length > maxChars) {
    content = content.slice(0, Math.max(0, maxChars));
    truncated = true;
  }
  return { content, truncated, ...(title !== undefined ? { title } : {}) };
}

/** 检索引擎结果页里的一条原始候选（尚未过安全/去重/字数筛选） */
export interface ParsedSearchResult {
  title: string;
  href: string;
  snippet: string;
}

const RESULT_LIMIT = 30; // 解析上限：拒绝把整页异常内容全塞进上下文

/**
 * 解析 DuckDuckGo HTML 端点的结果页。
 *
 * 结果锚点形如 `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=…">标题</a>`，
 * 摘要为 `<a class="result__snippet" …>摘要</a>`；两者在文档里的出现顺序一一对应，
 * 因此按出现顺序配对（缺摘要的条目摘要留空，仍可能因有标题而被保留）。
 */
export function parseSearchResultsHtml(html: string): ParsedSearchResult[] {
  if (typeof html !== 'string' || html.trim() === '') return [];
  const titles: { href: string; title: string }[] = [];
  const titleRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null && titles.length < RESULT_LIMIT) {
    const href = typeof m[1] === 'string' ? m[1] : '';
    const title = htmlToText(m[2] ?? '');
    titles.push({ href, title });
  }
  const snippets: string[] = [];
  const snippetRe = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = snippetRe.exec(html)) !== null && snippets.length < RESULT_LIMIT) {
    snippets.push(htmlToText(m[1] ?? ''));
  }
  if (titles.length === 0) return [];
  return titles.map((t, i) => ({
    title: t.title,
    href: t.href,
    snippet: snippets[i] ?? ''
  }));
}
