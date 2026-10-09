import { describe, expect, it, vi } from 'vitest';
import { LlmAuthError, LlmError } from '../llm/errors';
import type {
  ChatCallOptions,
  ChatMessage,
  ChatResult,
  LlmClient
} from '../llm/types';
import { probeToolsSupport } from './capability';

/** 构造只关心 chatOnce 的假客户端，并暴露 vi.fn 供断言入参 */
function fakeClient(chatOnce: ReturnType<typeof vi.fn>): LlmClient {
  return {
    chatOnce: chatOnce as unknown as LlmClient['chatOnce'],
    streamChat: async () => ({ content: '' })
  };
}

/** 模型成功调用 capability_probe 的返回形状 */
function probeToolCallResult(): ChatResult {
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [
      {
        id: 'probe-1',
        type: 'function',
        function: { name: 'capability_probe', arguments: '{"value":"ping"}' }
      }
    ]
  };
}

function firstCallArgs(chatOnce: ReturnType<typeof vi.fn>): {
  messages: ChatMessage[];
  opts: ChatCallOptions;
} {
  const [messages, opts] = chatOnce.mock.calls[0] as [ChatMessage[], ChatCallOptions];
  return { messages, opts };
}

describe('probeToolsSupport', () => {
  it('tool_choice=required 返回工具调用 → supported（required）', async () => {
    const chatOnce = vi.fn().mockResolvedValue(probeToolCallResult());

    const probe = await probeToolsSupport(fakeClient(chatOnce));

    expect(probe).toEqual({ support: 'supported', probeToolChoice: 'required' });
    expect(chatOnce).toHaveBeenCalledTimes(1);
    const { messages, opts } = firstCallArgs(chatOnce);
    expect(opts.toolChoice).toBe('required');
    expect(opts.tools?.[0]?.function.name).toBe('capability_probe');
    expect(opts.tools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { value: { type: 'string', description: '回显值' } },
      required: ['value'],
      additionalProperties: false
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('capability_probe');
  });

  it('tool_choice=required 被拒后改用 auto 成功 → supported（auto），第二次入参 toolChoice=auto', async () => {
    const chatOnce = vi
      .fn()
      .mockRejectedValueOnce(new LlmError("Unsupported parameter: 'tool_choice'", 400))
      .mockResolvedValueOnce(probeToolCallResult());

    const probe = await probeToolsSupport(fakeClient(chatOnce));

    expect(probe).toEqual({ support: 'supported', probeToolChoice: 'auto' });
    expect(chatOnce).toHaveBeenCalledTimes(2);
    expect(firstCallArgs(chatOnce).opts.toolChoice).toBe('required');
    const [, secondOpts] = chatOnce.mock.calls[1] as [ChatMessage[], ChatCallOptions];
    expect(secondOpts.toolChoice).toBe('auto');
    expect(secondOpts.tools?.[0]?.function.name).toBe('capability_probe');
  });

  it("400 \"Unknown parameter: 'tools'\" → unsupported 并带 detail", async () => {
    const message = "Unknown parameter: 'tools'";
    const chatOnce = vi.fn().mockRejectedValue(new LlmError(message, 400));

    const probe = await probeToolsSupport(fakeClient(chatOnce));

    expect(probe.support).toBe('unsupported');
    expect(probe.detail).toBe(message);
    expect(chatOnce).toHaveBeenCalledTimes(1);
  });

  it('400 但 message 不含 tool → unknown', async () => {
    const chatOnce = vi.fn().mockRejectedValue(new LlmError('Invalid request body', 400));

    const probe = await probeToolsSupport(fakeClient(chatOnce));

    expect(probe.support).toBe('unknown');
    expect(probe.detail).toBe('Invalid request body');
    expect(chatOnce).toHaveBeenCalledTimes(1);
  });

  it('5xx LlmError（重试耗尽）→ unknown', async () => {
    const chatOnce = vi
      .fn()
      .mockRejectedValue(new LlmError('Service Unavailable（重试耗尽）', 503));

    const probe = await probeToolsSupport(fakeClient(chatOnce));

    expect(probe.support).toBe('unknown');
    expect(probe.detail).toContain('Service Unavailable');
    expect(chatOnce).toHaveBeenCalledTimes(1);
  });

  it('LlmAuthError 原样 rethrow（不吞通道级错误）', async () => {
    const chatOnce = vi.fn().mockRejectedValue(new LlmAuthError());

    await expect(probeToolsSupport(fakeClient(chatOnce))).rejects.toBeInstanceOf(LlmAuthError);
    expect(chatOnce).toHaveBeenCalledTimes(1);
  });

  it('降级到 auto 后成功但无 toolCalls → unknown（模型未调用）', async () => {
    const chatOnce = vi
      .fn()
      .mockRejectedValueOnce(new LlmError("Unsupported parameter: 'tool_choice'", 400))
      .mockResolvedValueOnce({ content: '我不能调用工具，直接回答你。' });

    const probe = await probeToolsSupport(fakeClient(chatOnce));

    expect(probe.support).toBe('unknown');
    expect(probe.detail).toBe('模型未返回工具调用（tool_choice=auto）');
    expect(probe.probeToolChoice).toBeUndefined();
    expect(chatOnce).toHaveBeenCalledTimes(2);
  });

  it('把 AbortSignal 透传给 chatOnce', async () => {
    const chatOnce = vi.fn().mockResolvedValue(probeToolCallResult());
    const controller = new AbortController();

    await probeToolsSupport(fakeClient(chatOnce), { signal: controller.signal });

    const { opts } = firstCallArgs(chatOnce);
    expect(opts.signal).toBe(controller.signal);
  });
});
