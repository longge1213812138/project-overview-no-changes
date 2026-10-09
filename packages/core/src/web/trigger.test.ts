/**
 * 阶段 10：触发判定单测（DEV_PLAN §5.10「联网触发的条件」的可回归口径）。
 * 触发面要窄：要么用户明确要求，要么问题确实随时间变化，否则不外发请求。
 */
import { describe, expect, it } from 'vitest';
import { cleanupQuery, decideWebSearch, extractUrls } from './trigger';

describe('decideWebSearch 触发：用户明确要求', () => {
  it('中文显式指令全部命中', () => {
    for (const text of [
      '联网搜一下最新的 Rust 1.9x 版本变化',
      '帮我查一下 vscode 怎么配置远程开发',
      '上网查查今天上海天气',
      '帮我校对一下这个说法：查资料',
      '帮我搜索 MVP 架构的最佳实践',
      '搜索棉花今天的价格'
    ]) {
      const d = decideWebSearch(text);
      expect(d.needed, text).toBe(true);
      expect(d.kind, text).toBe('explicit');
    }
  });

  it('英文显式指令（search/look up）也命中', () => {
    const d = decideWebSearch('search the latest release notes of electron');
    expect(d.needed).toBe(true);
    expect(d.kind).toBe('explicit');
  });
});

describe('decideWebSearch 触发：时效/外部事实信号', () => {
  it('最新/今天/新闻/天气/股价类命中', () => {
    for (const text of [
      '最新一版的 Node LTS 是哪个版本？',
      '今天上海下雨吗',
      '最近的 LLM 推理框架有什么新进展',
      '本周有什么值得关注的 AI 新闻',
      '英伟达股价现在多少钱'
    ]) {
      const d = decideWebSearch(text);
      expect(d.needed, text).toBe(true);
      expect(d.kind, text).toBe('freshness');
    }
  });
});

describe('decideWebSearch 触发：给出了外部链接', () => {
  it('提取链接并确保 https? 以外不匹配', () => {
    expect(extractUrls('看这个 https://example.com/a 和 http://b.cn/c')).toEqual([
      'https://example.com/a',
      'http://b.cn/c'
    ]);
    expect(extractUrls('ftp://x/y 不算链接')).toEqual([]);
  });

  it('消息含链接 → 走抓直链（kind=link）', () => {
    const d = decideWebSearch('帮我总结一下 https://example.com/post 这篇讲了什么');
    expect(d.needed).toBe(true);
    expect(d.kind).toBe('link');
    expect(d.urls).toEqual(['https://example.com/post']);
  });

  it('句末标点不算链接的一部分', () => {
    expect(extractUrls('参考 https://example.com/a。谢谢')).toEqual(['https://example.com/a']);
  });
});

describe('decideWebSearch 不触发（排除面同样重要）', () => {
  it('空消息 / 短寒暄不触发', () => {
    expect(decideWebSearch('').needed).toBe(false);
    expect(decideWebSearch('   ').needed).toBe(false);
    expect(decideWebSearch('你好').needed).toBe(false);
  });

  it('指向对话自身的问题不联网（答案在会话里）', () => {
    for (const text of ['刚才我说了什么', '你还记得我最喜欢什么饮料吗']) {
      expect(decideWebSearch(text).needed, text).toBe(false);
    }
  });

  it('创作/加工类指令不联网', () => {
    for (const text of ['帮我写一封请假邮件', '帮我把这段话润色一下', '给这个方案起个名字']) {
      expect(decideWebSearch(text).needed, text).toBe(false);
    }
  });

  it('不涉时效的常识提问不联网（避免无意义外发）', () => {
    expect(decideWebSearch('用三句话介绍一下 Transformer 的注意力机制').needed).toBe(false);
    expect(decideWebSearch('今晚吃什么？给三个 20 分钟能做完的家常菜').needed).toBe(false);
  });

  it('排除规则不压过用户的显式要求', () => {
    expect(decideWebSearch('帮我查一下刚才那位作者还写过什么').needed).toBe(true);
    expect(decideWebSearch('写篇文章，先联网核对一下数据').needed).toBe(true);
  });
});

describe('cleanupQuery（检索词清洗）', () => {
  it('去掉命令词与客套话，留下真问题', () => {
    expect(cleanupQuery('帮我查一下 Rust 的所有权')).toBe('Rust 的所有权');
    expect(cleanupQuery('请上网搜索 2026 年格莱美获奖名单')).toBe('2026 年格莱美获奖名单');
  });

  it('去掉消息里的链接', () => {
    expect(cleanupQuery('总结下 https://example.com/a 这个页面的要点')).toBe('总结下 这个页面的要点');
  });

  it('清洗后为空则回退原句（保证总有东西可查）', () => {
    expect(cleanupQuery('搜一下')).toBe('搜一下');
  });
});
