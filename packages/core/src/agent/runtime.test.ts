import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatResult, ChatToolCall, LlmClient } from '../llm/types';
import type { AgentTool } from './runtime';
import { AgentLimitError, AgentRunError, runAgent } from './runtime';

const definition = {
  type: 'function' as const,
  function: {
    name: 'echo',
    description: 'Return the supplied value',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    }
  }
};

function isValue(value: unknown): value is { value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    typeof value.value === 'string'
  );
}

function makeTool(execute: AgentTool['execute'] = async (input) => {
  if (!isValue(input)) throw new Error('invalid input');
  return { echoed: input.value };
}): AgentTool {
  return { definition, validateInput: isValue, execute };
}

function call(id: string, args = '{"value":"hello"}'): ChatToolCall {
  return { id, type: 'function', function: { name: 'echo', arguments: args } };
}

function fakeClient(results: ChatResult[]): {
  client: LlmClient;
  requests: ChatMessage[][];
} {
  const requests: ChatMessage[][] = [];
  const client: LlmClient = {
    chatOnce: async () => ({ content: '' }),
    streamChat: async (messages, handlers) => {
      requests.push([...messages]);
      const result = results.shift();
      if (!result) throw new Error('unexpected model call');
      if (result.content) handlers?.onContentDelta?.(result.content);
      return result;
    }
  };
  return { client, requests };
}

describe('runAgent', () => {
  it('executes a tool call and returns the final assistant response', async () => {
    const { client, requests } = fakeClient([
      { content: '', finishReason: 'tool_calls', toolCalls: [call('call-1')] },
      { content: 'done', finishReason: 'stop' }
    ]);
    const execute = vi.fn(makeTool().execute);
    const chunks: string[] = [];

    const result = await runAgent(
      client,
      [{ role: 'user', content: 'hello' }],
      [makeTool(execute)],
      { onContentDelta: (text) => chunks.push(text) },
      { authorize: async () => true }
    );

    expect(result.content).toBe('done');
    expect(result.toolCalls).toBeUndefined();
    expect(chunks).toEqual(['done']);
    expect(execute).toHaveBeenCalledWith(
      { value: 'hello' },
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(requests[1]).toContainEqual(
      expect.objectContaining({ role: 'assistant', toolCalls: [call('call-1')] })
    );
    expect(requests[1]).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-1',
        content: '{"echoed":"hello"}'
      })
    );
  });

  it('denies tools by default and reports the denial to the model', async () => {
    const { client, requests } = fakeClient([
      { content: '', toolCalls: [call('call-1')] },
      { content: 'not run' }
    ]);
    const execute = vi.fn(makeTool().execute);
    const events: string[] = [];

    await runAgent(client, [{ role: 'user', content: 'run it' }], [makeTool(execute)], undefined, {
      onToolEvent: (event) => events.push(event.status)
    });

    expect(execute).not.toHaveBeenCalled();
    expect(events).toEqual(['requested', 'denied']);
    expect(requests[1]).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        content: '{"error":"工具调用未获授权"}'
      })
    );
  });

  it('rejects schema-invalid tool arguments without invoking the executor', async () => {
    const { client, requests } = fakeClient([
      { content: '', toolCalls: [call('call-1', '[]')] },
      { content: 'invalid arguments rejected' }
    ]);
    const execute = vi.fn(makeTool().execute);

    const result = await runAgent(
      client,
      [{ role: 'user', content: 'run it' }],
      [makeTool(execute)],
      undefined,
      { authorize: async () => true }
    );

    expect(result.content).toBe('invalid arguments rejected');
    expect(execute).not.toHaveBeenCalled();
    expect(requests[1]).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        content: '{"error":"工具参数未通过 schema 校验"}'
      })
    );
  });

  it('surfaces malformed tool JSON without invoking the executor', async () => {
    const { client } = fakeClient([{ content: '', toolCalls: [call('call-1', '{')] }]);
    const execute = vi.fn(makeTool().execute);

    await expect(
      runAgent(client, [{ role: 'user', content: 'run it' }], [makeTool(execute)], undefined, {
        authorize: async () => true
      })
    ).rejects.toBeInstanceOf(AgentRunError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns tool execution failures to the model and continues', async () => {
    const { client, requests } = fakeClient([
      { content: '', toolCalls: [call('call-1')] },
      { content: 'tool failed' }
    ]);
    const tool = makeTool(async () => {
      throw new Error('controlled failure');
    });

    const result = await runAgent(client, [{ role: 'user', content: 'run it' }], [tool], undefined, {
      authorize: async () => true
    });

    expect(result.content).toBe('tool failed');
    expect(requests[1]).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        content: '{"error":"controlled failure"}'
      })
    );
  });

  it('bounds tool error results before returning them to the model', async () => {
    const { client, requests } = fakeClient([
      { content: '', toolCalls: [call('call-1')] },
      { content: 'handled' }
    ]);
    const tool = makeTool(async () => {
      throw new Error('x'.repeat(1000));
    });

    await runAgent(client, [{ role: 'user', content: 'run it' }], [tool], undefined, {
      authorize: async () => true,
      maxToolResultChars: 32
    });

    const toolResult = requests[1].find((message) => message.role === 'tool');
    expect(toolResult?.content.length).toBeLessThanOrEqual(32);
    expect(JSON.parse(toolResult?.content ?? '')).toHaveProperty('error');
  });

  it('enforces the total tool-call limit before executing a batch', async () => {
    const { client } = fakeClient([
      { content: '', toolCalls: [call('call-1'), call('call-2')] }
    ]);
    const execute = vi.fn(makeTool().execute);

    await expect(
      runAgent(client, [{ role: 'user', content: 'run it' }], [makeTool(execute)], undefined, {
        authorize: async () => true,
        maxToolCalls: 1
      })
    ).rejects.toBeInstanceOf(AgentLimitError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('aborts an overlong tool execution', async () => {
    const { client } = fakeClient([{ content: '', toolCalls: [call('call-1')] }]);
    const tool = makeTool(
      (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal?.addEventListener(
            'abort',
            () => reject(ctx.signal?.reason),
            { once: true }
          );
        })
    );

    await expect(
      runAgent(client, [{ role: 'user', content: 'run it' }], [tool], undefined, {
        authorize: async () => true,
        maxToolExecutionMs: 10
      })
    ).rejects.toBeInstanceOf(AgentLimitError);
  });

  it('等待用户审批的时间不计入 maxDurationMs（审批慢不该判 Agent 超时）', async () => {
    const { client } = fakeClient([
      { content: '', toolCalls: [call('call-1')] },
      { content: 'done' }
    ]);
    const execute = vi.fn(makeTool().execute);

    const result = await runAgent(
      client,
      [{ role: 'user', content: 'run it' }],
      [makeTool(execute)],
      undefined,
      {
        maxDurationMs: 60, // Agent 自己的预算只有 60ms
        authorize: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150)); // 用户思考 150ms
          return true;
        }
      }
    );

    expect(result.content).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('limits the total assistant output', async () => {
    const { client } = fakeClient([{ content: 'too long' }]);
    await expect(
      runAgent(client, [{ role: 'user', content: 'hello' }], [], undefined, {
        maxAssistantChars: 2
      })
    ).rejects.toBeInstanceOf(AgentLimitError);
  });

  it('rejects invalid loop limits', async () => {
    const { client } = fakeClient([]);
    await expect(
      runAgent(client, [{ role: 'user', content: 'hello' }], [], undefined, { maxRounds: 0 })
    ).rejects.toThrow('maxRounds');
  });

  it('authorize 拒绝时把 reason 回传模型并上报 denied 事件', async () => {
    const { client, requests } = fakeClient([
      { content: '', toolCalls: [call('call-1')] },
      { content: 'refused' }
    ]);
    const execute = vi.fn(makeTool().execute);
    const events: Array<{ status: string; id: string; name: string; reason?: string }> = [];

    await runAgent(client, [{ role: 'user', content: 'run it' }], [makeTool(execute)], undefined, {
      authorize: async () => ({ approved: false, reason: '白名单外命令' }),
      onToolEvent: (event) => events.push(event)
    });

    expect(execute).not.toHaveBeenCalled();
    expect(events).toEqual([
      { status: 'requested', id: 'call-1', name: 'echo' },
      { status: 'denied', id: 'call-1', name: 'echo', reason: '白名单外命令' }
    ]);
    expect(requests[1]).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-1',
        content: '{"error":"白名单外命令"}'
      })
    );
  });

  it('authorize 批准并允许越界时把 allowOutside 与 signal 传给执行器', async () => {
    const { client } = fakeClient([
      { content: '', toolCalls: [call('call-1')] },
      { content: 'done' }
    ]);
    const execute = vi.fn(makeTool().execute);

    await runAgent(client, [{ role: 'user', content: 'run it' }], [makeTool(execute)], undefined, {
      authorize: async () => ({ approved: true, allowOutside: true })
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const ctx = execute.mock.calls[0]?.[1];
    expect(ctx?.allowOutside).toBe(true);
    expect(ctx?.signal).toBeInstanceOf(AbortSignal);
  });

  it('authorize 返回布尔 true 时 allowOutside 默认为 false', async () => {
    const { client } = fakeClient([
      { content: '', toolCalls: [call('call-1')] },
      { content: 'done' }
    ]);
    const execute = vi.fn(makeTool().execute);

    await runAgent(client, [{ role: 'user', content: 'run it' }], [makeTool(execute)], undefined, {
      authorize: async () => true
    });

    expect(execute).toHaveBeenCalledTimes(1);
    const ctx = execute.mock.calls[0]?.[1];
    expect(ctx?.allowOutside).toBe(false);
    expect(ctx?.signal).toBeInstanceOf(AbortSignal);
  });

  it('同批部分 tool_calls 被拒时仍把全部结果回传给模型', async () => {
    const { client, requests } = fakeClient([
      {
        content: '',
        toolCalls: [
          call('call-1', '{"value":"first"}'),
          call('call-2', '{"value":"second"}')
        ]
      },
      { content: 'done' }
    ]);
    const execute = vi.fn(makeTool().execute);
    const events: Array<{ status: string; id: string; name: string; reason?: string }> = [];

    const result = await runAgent(
      client,
      [{ role: 'user', content: 'run both' }],
      [makeTool(execute)],
      undefined,
      {
        authorize: async (_tool, input) =>
          (input as { value: string }).value !== 'second'
          ? true
          : { approved: false, reason: '白名单外命令' },
        onToolEvent: (event) => events.push(event)
      }
    );

    expect(result.content).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ value: 'first' }, expect.anything());
    expect(events.filter((event) => event.status === 'denied')).toEqual([
      { status: 'denied', id: 'call-2', name: 'echo', reason: '白名单外命令' }
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-1',
        content: '{"echoed":"first"}'
      })
    );
    expect(requests[1]).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-2',
        content: '{"error":"白名单外命令"}'
      })
    );
  });
});
