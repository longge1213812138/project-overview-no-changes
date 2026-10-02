/**
 * 阶段 4 任务 A2 / 阶段 5 任务 A4：意图解析测试（docs/DEV_PLAN.md §5.1）。
 * 用假 LlmClient（结构匹配 + as unknown as LlmClient）覆盖正常/容错/兜底全场景。
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage, LlmClient } from '../llm/types';
import { createIntentParser, type IntentParser } from './index';

/** 假 client：固定返回 content，或抛错 */
function fakeClient(
  handler: (messages: ChatMessage[]) => { content: string } | Promise<{ content: string }>
): { client: LlmClient; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const client = {
    chatOnce: async (messages: ChatMessage[]) => {
      calls.push(messages);
      return handler(messages);
    }
  } as unknown as LlmClient;
  return { client, calls };
}

function parserReturning(content: string): IntentParser {
  return createIntentParser(fakeClient(() => ({ content })).client);
}

describe('parse 正常路径', () => {
  it('remember：返回 payload.content', async () => {
    const parser = parserReturning('{"intent":"remember","payload":{"content":"喜欢简洁回答"}}');
    await expect(parser.parse('记住我喜欢简洁回答')).resolves.toEqual({
      intent: 'remember',
      payload: { content: '喜欢简洁回答' }
    });
  });

  it('remember：content 首尾空白 trim 后返回', async () => {
    const parser = parserReturning('{"intent":"remember","payload":{"content":"  在写 Fairy 项目  "}}');
    await expect(parser.parse('记一下：在写 Fairy 项目')).resolves.toEqual({
      intent: 'remember',
      payload: { content: '在写 Fairy 项目' }
    });
  });

  it('forget：返回 payload.keyword', async () => {
    const parser = parserReturning('{"intent":"forget","payload":{"keyword":"咖啡"}}');
    await expect(parser.parse('忘掉咖啡的事')).resolves.toEqual({
      intent: 'forget',
      payload: { keyword: '咖啡' }
    });
  });

  it('chat：无 payload', async () => {
    const parser = parserReturning('{"intent":"chat"}');
    await expect(parser.parse('今天天气怎么样')).resolves.toEqual({ intent: 'chat' });
  });

  it('system prompt 注入当前时间与 7 个 intent 字样，用户消息照发', async () => {
    const { client, calls } = fakeClient(() => ({ content: '{"intent":"chat"}' }));
    const parser = createIntentParser(client);
    const now = new Date('2024-09-20T04:00:00.000Z');

    await parser.parse('记住我喝美式不加糖', { now });

    expect(calls).toHaveLength(1);
    const [system, user] = calls[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain(now.toISOString());
    // 阶段 5 扩展：7 个 intent 定义齐全（§5.1）
    for (const kind of [
      'remember',
      'forget',
      'schedule_add',
      'schedule_done',
      'schedule_cancel',
      'schedule_query',
      'chat'
    ]) {
      expect(system.content).toContain(kind);
    }
    expect(user).toEqual({ role: 'user', content: '记住我喝美式不加糖' });
  });
});

describe('parse 解析容错', () => {
  it('```json 围栏 + 前后废话也能提取 balanced {...}', async () => {
    const parser = parserReturning(
      '好的，我判断如下：\n```json\n{"intent":"remember","payload":{"content":"喜欢简洁回答"}}\n```\n以上。'
    );
    await expect(parser.parse('记住')).resolves.toEqual({
      intent: 'remember',
      payload: { content: '喜欢简洁回答' }
    });
  });

  it('内容字符串里的花括号/转义不影响 balanced 提取', async () => {
    const parser = parserReturning(
      '结果 {"intent":"remember","payload":{"content":"配置是 {\\"a\\": 1} 这样"}} 尾部废话 {"x":'
    );
    await expect(parser.parse('x')).resolves.toEqual({
      intent: 'remember',
      payload: { content: '配置是 {"a": 1} 这样' }
    });
  });

  it('第一个 {...} 是坏 JSON 时继续往后找能解析的', async () => {
    const parser = parserReturning('前缀 {"intent": broken} 再来 {"intent":"chat"} 尾巴');
    await expect(parser.parse('x')).resolves.toEqual({ intent: 'chat' });
  });

  it('坏 JSON / 无 JSON → chat', async () => {
    await expect(parserReturning('这不是 JSON').parse('x')).resolves.toEqual({ intent: 'chat' });
    await expect(parserReturning('{"intent": ').parse('x')).resolves.toEqual({ intent: 'chat' });
    await expect(parserReturning('42').parse('x')).resolves.toEqual({ intent: 'chat' });
  });

  it('intent 非法/缺失 → chat（阶段 5 后 schedule_* 为合法 intent，不再兜底）', async () => {
    await expect(parserReturning('{"intent":"DELETE_ALL"}').parse('x')).resolves.toEqual({
      intent: 'chat'
    });
    await expect(parserReturning('{"payload":{"content":"x"}}').parse('x')).resolves.toEqual({
      intent: 'chat'
    });
    await expect(parserReturning('{"intent":42}').parse('x')).resolves.toEqual({ intent: 'chat' });
  });

  it('remember 的 content trim 后为空 → chat', async () => {
    await expect(
      parserReturning('{"intent":"remember","payload":{"content":"   "}}').parse('x')
    ).resolves.toEqual({ intent: 'chat' });
    await expect(
      parserReturning('{"intent":"remember","payload":{}}').parse('x')
    ).resolves.toEqual({ intent: 'chat' });
  });

  it('forget 的 keyword trim 后为空 → chat', async () => {
    await expect(
      parserReturning('{"intent":"forget","payload":{"keyword":"  "}}').parse('x')
    ).resolves.toEqual({ intent: 'chat' });
    await expect(
      parserReturning('{"intent":"forget","payload":{"keyword":123}}').parse('x')
    ).resolves.toEqual({ intent: 'chat' });
  });
});

describe('parse 异常兜底', () => {
  it('chatOnce 抛错（网络/超时）→ chat，绝不抛错', async () => {
    const { client } = fakeClient(() => {
      throw new Error('ECONNRESET');
    });
    await expect(createIntentParser(client).parse('x')).resolves.toEqual({ intent: 'chat' });

    const rejecting = {
      chatOnce: async () => {
        throw new Error('timeout');
      }
    } as unknown as LlmClient;
    await expect(createIntentParser(rejecting).parse('x')).resolves.toEqual({ intent: 'chat' });
  });

  it('AbortError → chat（stop 由外层 signal 控制流式阶段）', async () => {
    const aborting = {
      chatOnce: async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
    } as unknown as LlmClient;

    const controller = new AbortController();
    controller.abort();
    await expect(
      createIntentParser(aborting).parse('x', { signal: controller.signal })
    ).resolves.toEqual({ intent: 'chat' });
  });

  it('chatOnce 返回非预期结构（undefined/null content）→ chat', async () => {
    const weird = { chatOnce: async () => ({}) } as unknown as LlmClient;
    await expect(createIntentParser(weird).parse('x')).resolves.toEqual({ intent: 'chat' });
    const nully = { chatOnce: async () => null } as unknown as LlmClient;
    await expect(createIntentParser(nully).parse('x')).resolves.toEqual({ intent: 'chat' });
  });

  it('signal 透传给 chatOnce', async () => {
    const calls: Array<{ signal?: AbortSignal }> = [];
    const client = {
      chatOnce: async (_messages: ChatMessage[], opts?: { signal?: AbortSignal }) => {
        calls.push(opts ?? {});
        return { content: '{"intent":"chat"}' };
      }
    } as unknown as LlmClient;
    const controller = new AbortController();
    await createIntentParser(client).parse('x', { signal: controller.signal });
    expect(calls[0].signal).toBe(controller.signal);
  });
});

describe('parse schedule_add', () => {
  it('正常：title/remindAt/notes 齐全（ISO 原样透传，不换算）', async () => {
    const parser = parserReturning(
      '{"intent":"schedule_add","payload":{"title":"交周报","remind_at":"2024-09-28T10:00:00+08:00","notes":"发老板"}}'
    );
    await expect(parser.parse('9/28 上午十点提醒我交周报')).resolves.toEqual({
      intent: 'schedule_add',
      payload: { title: '交周报', remindAt: '2024-09-28T10:00:00+08:00', notes: '发老板' }
    });
  });

  it('remind_at 缺失仍返回 schedule_add（main 校验后追问，parse 不降级）', async () => {
    await expect(
      parserReturning('{"intent":"schedule_add","payload":{"title":"交周报"}}').parse('x')
    ).resolves.toEqual({ intent: 'schedule_add', payload: { title: '交周报' } });
  });

  it('remind_at 非法/非 ISO 任意字符串也透传，不降级 chat', async () => {
    await expect(
      parserReturning(
        '{"intent":"schedule_add","payload":{"title":"交周报","remind_at":"明天上午十点"}}'
      ).parse('x')
    ).resolves.toEqual({
      intent: 'schedule_add',
      payload: { title: '交周报', remindAt: '明天上午十点' }
    });
    await expect(
      parserReturning(
        '{"intent":"schedule_add","payload":{"title":"交周报","remind_at":"not-a-date"}}'
      ).parse('x')
    ).resolves.toEqual({
      intent: 'schedule_add',
      payload: { title: '交周报', remindAt: 'not-a-date' }
    });
  });

  it('title trim 后为空 / payload 缺失 → chat', async () => {
    await expect(
      parserReturning('{"intent":"schedule_add","payload":{"title":"   "}}').parse('x')
    ).resolves.toEqual({ intent: 'chat' });
    await expect(
      parserReturning('{"intent":"schedule_add","payload":{"remind_at":"2024-09-28T10:00:00Z"}}').parse('x')
    ).resolves.toEqual({ intent: 'chat' });
  });
});

describe('parse schedule_done/cancel/query', () => {
  it('keyword 单独命中（三个 intent 各一）', async () => {
    for (const kind of ['schedule_done', 'schedule_cancel', 'schedule_query'] as const) {
      const parser = parserReturning(`{"intent":"${kind}","payload":{"keyword":"周报"}}`);
      await expect(parser.parse('x')).resolves.toEqual({
        intent: kind,
        payload: { keyword: '周报' }
      });
    }
  });

  it('scope 单独命中（四个枚举值）', async () => {
    for (const scope of ['today', 'tomorrow', 'week', 'all'] as const) {
      const parser = parserReturning(
        `{"intent":"schedule_query","payload":{"scope":"${scope}"}}`
      );
      await expect(parser.parse('x')).resolves.toEqual({
        intent: 'schedule_query',
        payload: { scope }
      });
    }
  });

  it('keyword + scope 并存（AND 语义由 store 层保证）', async () => {
    await expect(
      parserReturning(
        '{"intent":"schedule_cancel","payload":{"keyword":"周报","scope":"tomorrow"}}'
      ).parse('x')
    ).resolves.toEqual({
      intent: 'schedule_cancel',
      payload: { keyword: '周报', scope: 'tomorrow' }
    });
  });

  it('keyword 与 scope 皆无/皆空 → chat', async () => {
    for (const kind of ['schedule_done', 'schedule_cancel', 'schedule_query'] as const) {
      await expect(
        parserReturning(`{"intent":"${kind}","payload":{}}`).parse('x')
      ).resolves.toEqual({ intent: 'chat' });
    }
    await expect(
      parserReturning(
        '{"intent":"schedule_query","payload":{"keyword":"  ","scope":""}}'
      ).parse('x')
    ).resolves.toEqual({ intent: 'chat' });
  });

  it('scope 非法枚举 → 丢 scope 保留 intent；keyword 也没有则 chat', async () => {
    await expect(
      parserReturning(
        '{"intent":"schedule_done","payload":{"keyword":"周报","scope":"thismonth"}}'
      ).parse('x')
    ).resolves.toEqual({ intent: 'schedule_done', payload: { keyword: '周报' } });
    await expect(
      parserReturning('{"intent":"schedule_done","payload":{"scope":"next week"}}').parse('x')
    ).resolves.toEqual({ intent: 'chat' });
  });

  it('围栏 + 前后废话 / 坏 JSON 兜底', async () => {
    const parser = parserReturning(
      '```json\n{"intent":"schedule_query","payload":{"scope":"today"}}\n```'
    );
    await expect(parser.parse('x')).resolves.toEqual({
      intent: 'schedule_query',
      payload: { scope: 'today' }
    });
    await expect(
      parserReturning('{"intent":"schedule_query" broken').parse('x')
    ).resolves.toEqual({ intent: 'chat' });
  });
});
