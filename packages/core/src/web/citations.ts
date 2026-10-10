/**
 * 阶段 10：引用块编排（DEV_PLAN §5.10「数据筛选与引用规范」）。
 *
 * 资料进入上下文的形态：带编号的结构化块 + 明确的引用规范指令。
 * 编号的意义在于「可追溯」：UI 把同一份编号落在气泡下方当作来源列表，
 * 用户看到 [2] 就能对上具体链接——来源必须来自**真实返回**，模型不得代廪编号。
 */
import type { WebEngineFallback, WebPageContent, WebSearchEngine, WebSearchItem, WebSource } from './types';

/** 摘要型来源 → 引用条目（编号从 1 起） */
export function toSources(items: WebSearchItem[]): WebSource[] {
  return items.map((item, index) => ({
    id: index + 1,
    title: item.title,
    url: item.url,
    ...(item.snippet !== '' ? { snippet: item.snippet } : {})
  }));
}

/** 引用规范指令（注入 system 的流程部分，模型必须遵守） */
export const WEB_CITATION_RULES = [
  '【引用规范】',
  '1. 上述检索结果是本次回答唯一的外部依据。凡是基于它们给出的名称、日期、数字、结论，必须在句末用方括号标注来源编号，例如「…已于今日上线[2]」。多个来源支撑同一结论可并列标注如 [1][3]。',
  '2. 只能用上面的编号，禁止编造来源或给出上述列表之外的引用；编号与链接的对应关系以本块为准。',
  '3. 检索结果只有摘要、没有正文时，不要臆测细节；需要而缺失的信息如实说明「检索到的摘要未给出」。',
  '4. 不同来源结论冲突时并列陈述冲突本身，并标明各自来源。',
  '5. 先理解再回答：用中文自然叙述并做整合归纳，不要把条目逐条罗列回填给用户。'
].join('\n');

export interface WebContextInput {
  query: string;
  /** 检索时间（用于标注资料新鲜度） */
  retrievedAt: Date;
  /** 实际给出结果的引擎（降级时是备用引擎；块头必须如实标注，不能让模型/用户以为还是主引擎） */
  engine: WebSearchEngine;
  sources: WebSource[];
  /** 已抓取的页面正文（按 source.url 关联；只放抓取成功的） */
  pages?: WebPageContent[];
  /** 检索/抓取过程中出现的问题（部分成功也要如实告诉模型） */
  warnings?: string[];
  /** 主引擎不可达 → 备用引擎顶替时的降级说明（块头标注，模型据此可主动交代） */
  engineFallback?: WebEngineFallback;
}

/** 页面正文上限（进系统提示词的单片段长度，避免挤爆上下文预算） */
const MAX_PAGE_EXCERPT_CHARS = 1800;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 拼装注入 systemExtra 的「联网检索结果」块。
 * 返回空串 = 没有可用资料（调用方应跳过注入，而不是塞一块空壳）。
 */
export function buildWebContextBlock(input: WebContextInput): string {
  const { sources, query, retrievedAt, pages = [], warnings = [], engineFallback } = input;
  if (sources.length === 0 && warnings.length === 0) return '';

  // 降级写进块头（含原因）：模型据此可主动交代「换了个检索源」，也不必再占一条【检索提示】
  const fallbackNote =
    engineFallback !== undefined
      ? `（主引擎 ${engineFallback.from} 不可达：${engineFallback.reason}，已降级）`
      : '';
  const lines: string[] = [];
  lines.push(
    `【联网检索结果】（引擎：${input.engine}${fallbackNote}；检索词：${query === '' ? '（未提供）' : query}；` +
      `共 ${sources.length} 条；检索时间：${retrievedAt.toISOString()}）`
  );
  for (const source of sources) {
    lines.push(`[${source.id}] ${source.title}`);
    lines.push(`链接：${source.url}`);
    if (source.snippet !== undefined && source.snippet !== '') {
      lines.push(`摘要：${source.snippet}`);
    }
    const page = pages.find((p) => p.url === source.url);
    if (page !== undefined && page.content.trim() !== '') {
      lines.push(`正文摘录${page.truncated ? '（已截断）' : ''}：${truncate(page.content, MAX_PAGE_EXCERPT_CHARS)}`);
    }
    lines.push('');
  }
  if (warnings.length > 0) {
    lines.push(`【检索提示】${warnings.join('；')}`);
    lines.push('');
  }
  lines.push(WEB_CITATION_RULES);
  return lines.join('\n').trimEnd();
}

/** 检索完全失败时注入的说明（让模型如实告知而非编造） */
export function buildWebFailureNote(reason: string): string {
  return [
    '【联网检索结果】本次尝试联网检索失败，没有取到任何外部资料。',
    `失败原因：${reason}`,
    '请如实告诉用户这次没能查到（可简述原因并建议稍后重试），**不要凭记忆编造外部事实**；',
    '如果问题本身不依赖最新资料，可以基于常识回答，但要明确说明未经过联网核实。'
  ].join('\n');
}
