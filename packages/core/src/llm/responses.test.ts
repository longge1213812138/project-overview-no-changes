/**
 * Responses API（apiStyle='responses'）协议映射测试：
 * 端点归一、消息/工具映射、非流式解析、流式事件累计（含失败与半途关闭）。
 * 纯函数层；HTTP 传输层在 client.responses.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { LlmError } from './errors';
import { resolveEndpoint } from './client';
import {
  buildResponsesBody,
  createResponsesAccumulator,
  parseResponsesResult,
  toResponsesInput,
  toResponsesTools
} from './responses';
import type { ChatMessage, StreamHandlers } from './types';

describe('resolveEndpoint（两种风格的端点归一）', () => {
  it.each([
    // [baseUrl, style, 期望]
    ['http://127.0.0.1:22217', 'chat', 'http://127.0.0.1:22217/v1/chat/completions'],
    ['http://127.0.0.1:22217', 'responses', 'http://127.0.0.1:22217/v1/responses'],
    ['https://api.deepseek.com/v1', 'chat', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://api.deepseek.com/v1', 'responses', 'https://api.deepseek.com/v1/responses'],
    ['https://api.deepseek.com/v1/', 'responses', 'https://api.deepseek.com/v1/responses'],
    // 已是完整方法路径 → 按风格换/保后缀，绝不二次拼接
    ['https://x/v1/chat/completions', 'chat', 'https://x/v1/chat/completions'],
    ['https://x/v1/chat/completions', 'responses', 'https://x/v1/responses'],
    ['https://x/v1/responses', 'responses', 'https://x/v1/responses'],
    ['https://x/v1/responses', 'chat', 'https://x/v1/chat/completions'],
    ['https://x/v2/chat/completions', 'responses', 'https://x/v2/responses'],
    ['https://x/chat/completions', 'responses', 'https://x/responses']
  ] as const)('%s + %s → %s', (baseUrl, style, expected) => {
    expect(resolveEndpoint(baseUrl, style)).toBe(expected);
  });
});

describe('toResponsesInput（ChatMessage[] → input 项）', () => {
  it('system/user 纯字符串 content；顺序保持', () => {
    const input = toResponsesInput([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]);
    expect(input).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' }
    ]);
  });

  it('assistant 带工具调用 → assistant 文本 + function_call 项；tool → function_call_output', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: '几点' },
      {
        role: 'assistant',
        content: '查一下',
        toolCalls: [
          { id: 'call-1', type: 'function', function: { name: 'get_time', arguments: '{}' } }
        ]
      },
      { role: 'tool', toolCallId: 'call-1', name: 'get_time', content: '{"ok":true}' }
    ];
    expect(toResponsesInput(messages)).toEqual([
      { role: 'user', content: '几点' },
      { role: 'assistant', content: '查一下' },
      { type: 'function_call', call_id: 'call-1', name: 'get_time', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: '{"ok":true}' }
    ]);
  });

  it('assistant 空 content + 工具调用 → 不发空 assistant 消息（只发 function_call 项）', () => {
    const input = toResponsesInput([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"v":1}' } }
        ]
      }
    ]);
    expect(input).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'echo', arguments: '{"v":1}' }
    ]);
  });
});

describe('buildResponsesBody（请求体）', () => {
  it('扁平 tools + tool_choice + max_output_tokens + stream 标记', () => {
    const body = JSON.parse(
      buildResponsesBody({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'x' }],
        stream: false,
        options: {
          tools: [
            {
              type: 'function',
              function: { name: 'echo', description: '回显', parameters: { type: 'object' } }
            }
          ],
          toolChoice: 'required',
          maxTokens: 512
        }
      })
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-4o',
      stream: false,
      tool_choice: 'required',
      max_output_tokens: 512,
      input: [{ role: 'user', content: 'x' }],
      tools: [
        {
          type: 'function',
          name: 'echo',
          description: '回显',
          parameters: { type: 'object' }
        }
      ]
    });
    expect(body).not.toHaveProperty('max_tokens'); // Responses 无此参数
    expect(body).not.toHaveProperty('messages');
    // 扁平结构（无嵌套 function）
    expect((body.tools as Record<string, unknown>[])[0]).not.toHaveProperty('function');
  });
});

describe('parseResponsesResult（非流式）', () => {
  it('output[] → content / reasoning / toolCalls / finishReason', () => {
    const r = parseResponsesResult({
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: '想一想' }]
        },
        {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: '答案' },
            { type: 'output_text', text: '在此' }
          ]
        },
        {
          type: 'function_call',
          call_id: 'call-9',
          name: 'echo',
          arguments: '{"value":"hi"}'
        }
      ]
    });
    expect(r.content).toBe('答案在此');
    expect(r.reasoning).toBe('想一想');
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls).toEqual([
      { id: 'call-9', type: 'function', function: { name: 'echo', arguments: '{"value":"hi"}' } }
    ]);
  });

  it('空 arguments 归一为 {}（runtime JSON.parse 需要合法 JSON）', () => {
    const r = parseResponsesResult({
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'c', name: 'noop', arguments: '' }]
    });
    expect(r.toolCalls?.[0].function.arguments).toBe('{}');
  });

  it('status=completed 纯文本 → finishReason stop；incomplete → length', () => {
    const done = parseResponsesResult({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }]
    });
    expect(done.finishReason).toBe('stop');
    expect(done.toolCalls).toBeUndefined();

    const incomplete = parseResponsesResult({
      status: 'incomplete',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '截断' }] }]
    });
    expect(incomplete.finishReason).toBe('length');
  });

  it('status=failed → 抛 LlmError（不伪装成功）', () => {
    expect(() =>
      parseResponsesResult({ status: 'failed', error: { message: 'model exploded' } })
    ).toThrow(LlmError);
    expect(() => parseResponsesResult({ status: 'failed', error: { message: 'x' } })).toThrow(
      /model exploded|x/
    );
  });

  it('function_call 字段无效 → 抛错（fail-visible）', () => {
    expect(() =>
      parseResponsesResult({ status: 'completed', output: [{ type: 'function_call', call_id: '' }] })
    ).toThrow(LlmError);
  });
});

describe('createResponsesAccumulator（流式事件累计）', () => {
  const frame = (obj: unknown): string => JSON.stringify(obj);

  it('text/reasoning delta 走回调；completed 用 output 权威收尾', () => {
    const contents: string[] = [];
    const reasonings: string[] = [];
    const acc = createResponsesAccumulator({
      onContentDelta: (t) => contents.push(t),
      onReasoningDelta: (t) => reasonings.push(t)
    } satisfies StreamHandlers);

    expect(acc.push(frame({ type: 'response.created' }))).toBe(false);
    expect(acc.push(frame({ type: 'response.reasoning_summary_text.delta', delta: '想' }))).toBe(false);
    expect(acc.push(frame({ type: 'response.output_text.delta', delta: '你' }))).toBe(false);
    expect(acc.push(frame({ type: 'response.output_text.delta', delta: '好' }))).toBe(false);
    expect(acc.push('{"type":"not-a-known-frame"}')).toBe(false);
    expect(acc.push('{"broken')).toBe(false); // 残缺帧忽略
    expect(
      acc.push(
        frame({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '你好' }] }]
          }
        })
      )
    ).toBe(true);

    const r = acc.finish();
    expect(r.content).toBe('你好');
    expect(r.reasoning).toBe('想');
    expect(r.finishReason).toBe('stop');
    expect(contents).toEqual(['你', '好']);
    expect(reasonings).toEqual(['想']);
  });

  it('function_call 流式累计（added → arguments.delta → done）', () => {
    const acc = createResponsesAccumulator();
    acc.push(
      frame({
        type: 'response.output_item.added',
        index: 0,
        item: { type: 'function_call', index: 0, call_id: 'call-1', name: 'echo', arguments: '' }
      })
    );
    acc.push(frame({ type: 'response.function_call_arguments.delta', item_index: 0, delta: '{"val' }));
    acc.push(frame({ type: 'response.function_call_arguments.delta', item_index: 0, delta: 'ue":1}' }));
    acc.push(
      frame({
        type: 'response.completed',
        response: { status: 'completed', output: [] } // 空 output → 回退用事件累计
      })
    );
    const r = acc.finish();
    expect(r.toolCalls).toEqual([
      { id: 'call-1', type: 'function', function: { name: 'echo', arguments: '{"value":1}' } }
    ]);
    expect(r.finishReason).toBe('tool_calls');
  });

  it('无终态帧（连接半途关闭）→ 返回已收内容、finishReason 留空', () => {
    const acc = createResponsesAccumulator();
    acc.push(frame({ type: 'response.output_text.delta', delta: '部分' }));
    const r = acc.finish();
    expect(r.content).toBe('部分');
    expect(r.finishReason).toBeUndefined();
    expect(r.toolCalls).toBeUndefined();
  });

  it('response.failed / 帧内 error → finish 抛 LlmError', () => {
    const failed = createResponsesAccumulator();
    failed.push(frame({ type: 'response.output_text.delta', delta: 'x' }));
    failed.push(frame({ type: 'response.failed', response: { error: { message: 'kaput' } } }));
    expect(() => failed.finish()).toThrow(/kaput/);

    const errored = createResponsesAccumulator();
    errored.push(frame({ type: 'error', error: { message: 'rate limited' } }));
    expect(() => errored.finish()).toThrow(/rate limited/);
  });

  it('[DONE] 标记 → 终止（兼容实现差异）', () => {
    const acc = createResponsesAccumulator();
    expect(acc.push(frame({ type: 'response.output_text.delta', delta: 'ok' }))).toBe(false);
    expect(acc.push('[DONE]')).toBe(true);
    const r = acc.finish();
    expect(r.content).toBe('ok');
    expect(r.finishReason).toBe('stop');
  });
});
