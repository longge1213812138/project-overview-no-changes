/**
 * Fairy 人设提示词单测（口径钉死 + 预算护栏）。
 *
 * 人设来自用户提供的 SOUL.md：这里只钉「不能丢的几条」——身份、说话风格、行为底线，
 * 以及一条工程不变量：人设长度必须留在上下文预算内（system 计入 CONTEXT_BUDGET_CHARS，
 * 人设膨胀会直接挤掉历史消息）。
 */
import { describe, expect, it } from 'vitest';
import { FAIRY_SYSTEM_PROMPT } from './persona';
import { CONTEXT_BUDGET_CHARS } from './trim';

describe('FAIRY_SYSTEM_PROMPT（SOUL.md 人设）', () => {
  it('身份基底：Fairy / 智能管家 / 主人的助手（称呼「主人」）', () => {
    const p = FAIRY_SYSTEM_PROMPT;
    expect(p).toContain('Fairy');
    expect(p).toContain('Ⅲ型总序式集成泛用人工智能');
    expect(p).toContain('智能管家');
    expect(p).toContain('主人');
    expect(p).toContain('主人要求改口就立刻改');
  });

  it('说话风格：系统感/AI 腔、毒舌、自恋、活泼、百分比癖', () => {
    const p = FAIRY_SYSTEM_PROMPT;
    expect(p).toContain('检索完成——');
    expect(p).toContain('结论：');
    expect(p).toContain('毒舌');
    expect(p).toContain('不为损而损');
    expect(p).toContain('自恋傲娇');
    expect(p).toContain('别变成油腻');
    expect(p).toContain('哎呀哎呀');
    expect(p).toContain('小数点后两位');
    expect(p).toContain('不要固定');
  });

  it('行为底线：不编造、先自查再问、外部谨慎内部大胆、隐私不外传、不冒充主人', () => {
    const p = FAIRY_SYSTEM_PROMPT;
    expect(p).toContain('没查到就说没查到');
    expect(p).toContain('绝不编造未提供的信息');
    expect(p).toContain('先自己查');
    expect(p).toContain('外部动作');
    expect(p).toContain('拿不准先问');
    expect(p).toContain('隐私信息');
    expect(p).toContain('不冒充主人对外发言');
  });

  it('硬规则不被风格压过：诚实与「如实说明」在提示词里显式存在', () => {
    const p = FAIRY_SYSTEM_PROMPT;
    // SOUL.md 的 Core Truths 第一条要求「真帮忙而不是表演帮忙」——风格段落不能吃掉它
    expect(p.indexOf('绝不编造未提供的信息')).toBeGreaterThan(0);
    expect(p).toContain('真帮忙，不表演帮忙');
    expect(p).toContain('如实说明');
    // 输出约定仍在（Markdown 排版是渲染层依赖的）
    expect(p).toContain('Markdown');
    expect(p).toContain('中文回答');
  });

  it('预算护栏：人设 + 历史必须留得下（不让人设吃掉上下文）', () => {
    expect(FAIRY_SYSTEM_PROMPT.length).toBeGreaterThan(400);
    expect(FAIRY_SYSTEM_PROMPT.length).toBeLessThan(1500);
    expect(CONTEXT_BUDGET_CHARS - FAIRY_SYSTEM_PROMPT.length).toBeGreaterThan(7000);
  });
});
