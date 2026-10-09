/**
 * 阶段 10：联网触发判定（DEV_PLAN §5.10「联网触发的条件」）。
 *
 * 为什么用确定性规则而不是每轮都问模型：① 零额外计费/延迟；② 触发口径可审计、可回归测试；
 * ③ 联网会**把用户的原话片段外发给检索引擎**，触发面必须收窄且可被用户预期。
 *
 * 判定优先级（任一命中即触发；括号后的排除表先于普通检索信号生效）：
 *   0. 排除：空消息 / 过短寒暄 / 指向对话自身的句子（"刚才我说了什么"）/ 纯创作类指令
 *      （"帮我写一封邮件"不需要外部资料）；
 *   1. **用户明确要求**：联网、上网、搜一下、查一下、帮我查/搜、查资料、search…；
 *   2. **时效信号**：最新、最近、今天/今年/本周、新闻、天气、股价、汇率、热搜…；
 *   3. **给出了外部链接**：直接抓取该链接（走同一套 URL 安全守卫）。
 * 纯函数、无网络、无 node 内建依赖，便于单测钉死口径。
 */

/** 触发后的 richness 标签（进日志与面板，便于事后解释「为什么联网了」） */
export type WebTriggerKind = 'none' | 'explicit' | 'freshness' | 'link';

export interface WebTriggerDecision {
  needed: boolean;
  kind: WebTriggerKind;
  /** 触发原因（人类可读，进日志/可从 Philosophical不会被模型看到） */
  reason: string;
  /** 清洗后的检索词（去掉命令词与链接后的自然语言查询；未触发时为空串） */
  query: string;
  /** 消息里给出的外部链接（已去重、未经安全校验；由调用方走 checkWebUrl） */
  urls: string[];
}

/** ① 用户明确要求联网的表达 */
const EXPLICIT_PATTERNS: readonly RegExp[] = [
  /(联网|上网)(搜|搜索|查|查询|找|看看|核对)?/,
  /(搜一下|搜索一下|查一下|查一查|查询一下|查查|搜搜|找一下资料|查资料|核实一下)/,
  /(帮我搜|帮我查|帮我搜索|帮我查询|帮我找)/,
  /(网上(查|搜|搜索|查询)|网上的资料)/,
  /** 裸祈使句：`搜索棉花价格` / `检索最近的公告`（不带「一下」也算明确指令） */
  /(搜索|检索)(?=\S)/,
  /\b(search|google|bing|look\s+up)\b/i
];

/** ② 时效/外部事实信号：这类问题答案随时间变化，本地资料库不可信 */
const FRESHNESS_PATTERNS: readonly RegExp[] = [
  /(最新|最近|近日|近期|今天|今日|昨天|昨日|本周|本月|今年|最近几年|刚刚|即将|下周|下个月)/,
  /(新闻|快讯|消息通报|热搜|公告|通报)/,
  /(天气|气温|空气质量)/,
  /(股价|收盘|汇率| inflation|GDP|财报|季报)/i,
  /(最新版本|最新版|新版本|发布了吗|什么时候发布|多少钱|售价|排行|排名)/
];

/** ⓪ 排除：指向对话自身/本地上下文的句子（这些答案在会话里，不在网上） */
const SELF_REFERENCE_PATTERNS: readonly RegExp[] = [
  /(刚才|刚刚我|上一句|上一条|之前说|前面说|你还记得|我说过|第一次|上一次)/
];

/** ⓪ 排除：纯创作/加工类指令（不需要外部资料即可完成） */
const CREATION_PATTERNS: readonly RegExp[] = [
  /(帮我写|帮我改|帮我润色|帮我翻译|帮我总结(这段|以上|上面|下面)|改写|续写|润色|起个(名字|标题)|取个标题|大纲)/
];

/** 提取 http(s) 链接（收缩到空白/标点边界） */
const URL_PATTERN = /https?:\/\/[^\s"'<>()[\]{}，。！？、；：）】]+/gi;

const MAX_URLS = 3;

/** 返回第一个命中的匹配结果（含命中文本，进触发原因便于排障）；未命中返回 null */
function hit(patterns: readonly RegExp[], text: string): RegExpExecArray | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m;
  }
  return null;
}

/** 抽取消息里的外部链接（去重，保留出现顺序） */
export function extractUrls(message: string): string[] {
  const out: string[] = [];
  if (typeof message !== 'string') return out;
  for (const m of message.matchAll(URL_PATTERN)) {
    const url = (m[0] ?? '').replace(/[.,;:!?]+$/, ''); // 句末标点不算链接一部分
    if (url !== '' && !out.includes(url)) out.push(url);
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

/**
 * 清洗检索词：去掉命令动词、联网词、链接与客套话，留下真正要查的内容。
 * 清洗后为空则回退到原句（保证「总有东西可查」）。
 */
export function cleanupQuery(message: string): string {
  const original = typeof message === 'string' ? message.trim() : '';
  if (original === '') return '';
  let text = original;
  text = text.replace(URL_PATTERN, ' '); // 链接另走直链抓取，不进检索词
  // 顺序有讲究：先剥客套/命令词，再剥「查一下」这类整体短语，避免切一半留下「一下」
  text = text.replace(/(帮我|麻烦|给我|请|请你|能不能|可不可以|顺便|再)/g, ' ');
  text = text.replace(/(联网|上网|网上)/g, ' ');
  text = text.replace(
    /(搜一下|搜索一下|查一下|查一查|查询一下|查查|搜搜|查资料|找一下资料|核实一下|跟我搜索)/g,
    ' '
  );
  text = text.replace(/(搜索|检索|查询|查找|一下)/g, ' ');
  text = text.replace(/[，。！？、；：,.!?；:]{2,}/g, '，');
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? original : cleaned;
}

const NOT_NEEDED: WebTriggerDecision = { needed: false, kind: 'none', reason: '', query: '', urls: [] };

/**
 * 判定本条用户消息是否需要联网检索。
 *
 * 仅做**是否触发**的判断；开关（用户是否允许联网）与通道門控由调用方负责，
 * 这样 UI/日志能明确区分「关了所以没联网」与「这个问题不需要联网」。
 */
export function decideWebSearch(message: string): WebTriggerDecision {
  const text = typeof message === 'string' ? message.trim() : '';
  if (text === '') return NOT_NEEDED;

  const urls = extractUrls(text);
  const explicit = hit(EXPLICIT_PATTERNS, text);
  if (explicit) {
    return {
      needed: true,
      kind: 'explicit',
      reason: `用户明确要求联网检索（命中：${explicit[0]}）`,
      query: cleanupQuery(text),
      urls
    };
  }
  if (urls.length > 0) {
    return {
      needed: true,
      kind: 'link',
      reason: `消息包含外部链接（${urls.length} 条），抓取该页面作为资料`,
      query: cleanupQuery(text),
      urls
    };
  }
  if (hit(SELF_REFERENCE_PATTERNS, text)) {
    return { ...NOT_NEEDED, reason: '指向对话自身/本地上下文，无需联网' };
  }
  if (hit(CREATION_PATTERNS, text)) {
    return { ...NOT_NEEDED, reason: '创作/加工类指令，无需外部资料' };
  }
  if (text.length < 6) {
    return { ...NOT_NEEDED, reason: '短句（寒暄/口语）不触发联网' };
  }
  const fresh = hit(FRESHNESS_PATTERNS, text);
  if (fresh) {
    return {
      needed: true,
      kind: 'freshness',
      reason: `问题涉及实时/最新信息（命中：${fresh[0]}）`,
      query: cleanupQuery(text),
      urls
    };
  }
  return { ...NOT_NEEDED, reason: '未命中联网触发规则（常规对话不联网）' };
}
