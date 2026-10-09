/**
 * 阶段 10：引用块编排单测（DEV_PLAN §5.10「数据筛选与引用规范」）。
 * 注入模型的文本必须由真实来源构成；拿不到资料时给的是「失败说明」而不是空壳或假数据。
 */
import { describe, expect, it } from 'vitest';
import { WEB_CITATION_RULES, buildWebContextBlock, buildWebFailureNote, toSources } from './citations';
import type { WebSearchItem } from './types';

const RETRIEVED_AT = new Date('2026-10-07T08:00:00.000Z');

function items(count = 2): WebSearchItem[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `来源 ${i + 1}`,
    url: `https://example.com/${i + 1}`,
    snippet: `摘要 ${i + 1}`
  }));
}

describe('toSources（编号与顺序）', () => {
  it('编号从 1 起并与条目顺序一致', () => {
    const sources = toSources(items(3));
    expect(sources.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(sources[0]).toEqual({ id: 1, title: '来源 1', url: 'https://example.com/1', snippet: '摘要 1' });
  });

  it('空摘要不落字段', () => {
    const sources = toSources([{ title: 't', url: 'https://a.example/', snippet: '' }]);
    expect(sources[0]?.snippet).toBeUndefined();
  });
});

describe('buildWebContextBlock', () => {
  it('无来源且无警告 → 空串（调用方应跳过注入，不塞空壳）', () => {
    expect(buildWebContextBlock({ query: 'q', retrievedAt: RETRIEVED_AT, sources: [] })).toBe('');
  });

  it('块内含检索词/时间/编号/链接/摘要 + 引用规范', () => {
    const block = buildWebContextBlock({
      query: '格莱美获奖名单',
      retrievedAt: RETRIEVED_AT,
      sources: toSources(items(2))
    });
    expect(block).toContain('检索词：格莱美获奖名单');
    expect(block).toContain(RETRIEVED_AT.toISOString());
    expect(block).toContain('[1] 来源 1');
    expect(block).toContain('链接：https://example.com/1');
    expect(block).toContain('摘要：摘要 2');
    expect(block).toContain(WEB_CITATION_RULES);
  });

  it('按 url 关联正文摘录并标记截断', () => {
    const block = buildWebContextBlock({
      query: 'q',
      retrievedAt: RETRIEVED_AT,
      sources: toSources(items(1)),
      pages: [{ url: 'https://example.com/1', title: '来源 1', content: '正文内容很长', truncated: true }]
    });
    expect(block).toContain('正文摘录（已截断）：正文内容很长');
  });

  it('正文过长时截断注入（防挤爆上下文预算）', () => {
    const long = '字'.repeat(5000);
    const block = buildWebContextBlock({
      query: 'q',
      retrievedAt: RETRIEVED_AT,
      sources: toSources(items(1)),
      pages: [{ url: 'https://example.com/1', title: 't', content: long, truncated: false }]
    });
    expect(block).toContain('…');
    expect(block.length).toBeLessThan(long.length);
  });

  it('部分失败：警告进块且仍有可用来源', () => {
    const block = buildWebContextBlock({
      query: 'q',
      retrievedAt: RETRIEVED_AT,
      sources: toSources(items(2)),
      warnings: ['https://example.com/2 正文抓取失败（超时）']
    });
    expect(block).toContain('【检索提示】');
    expect(block).toContain('正文抓取失败');
    expect(block).toContain('[1] 来源 1');
  });

  it('引用规范明确禁止编造来源', () => {
    expect(WEB_CITATION_RULES).toContain('禁止编造来源');
    expect(WEB_CITATION_RULES).toContain('在句末用方括号标注来源编号');
  });
});

describe('buildWebFailureNote', () => {
  it('失败原因可见且要求模型不能编造', () => {
    const note = buildWebFailureNote('检索请求超时');
    expect(note).toContain('检索请求超时');
    expect(note).toContain('不要凭记忆编造外部事实');
  });
});
