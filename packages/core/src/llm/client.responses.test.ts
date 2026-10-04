/**
 * Responses 风格的 HTTP 集成测试（本地 http server，模式同 client.test.ts）：
 * 端点选择、请求体、非流式/流式往返、错误分类复用。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLlmClient } from './index';
import { LlmError, SessionExpiredError } from './errors';

let server: http.Server;
let port = 0;
let requestCount = 0;
let requestUrl = '';
let requestBody: Record<string, unknown> | undefined;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function client(over: Partial<Parameters<typeof createLlmClient>[0]> = {}) {
  return createLlmClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'sk-test',
    apiStyle: 'responses',
    retryBaseDelayMs: 10,
    requestTimeoutMs: 3000,
    idleTimeoutMs: 500,
    ...over
  });
}

function collectBody(req: http.IncomingMessage, res: http.ServerResponse, reply: () => void): void {
  let raw = '';
  req.on('data', (chunk: Buffer) => {
    raw += chunk.toString();
  });
  req.on('end', () => {
    requestUrl = req.url ?? '';
    requestBody = JSON.parse(raw) as Record<string, unknown>;
    reply();
  });
}

beforeEach(() => {
  requestCount = 0;
  requestUrl = '';
  requestBody = undefined;
  handler = (req, res) => collectBody(req, res, () => json(res, 500, { error: 'unset handler' }));
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount++;
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  // 留空：与 client.test.ts 保持一致的结构（handler 每例重置）
});

describe('responses 端点与请求体', () => {
  it('根地址 → POST /v1/responses（stream:false），body 为 input 形态', async () => {
    handler = (req, res) =>
      collectBody(req, res, () =>
        json(res, 200, {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }]
        })
      );
    const r = await client().chatOnce([{ role: 'user', content: 'ping' }]);
    expect(requestUrl).toBe('/v1/responses');
    expect(r.content).toBe('pong');
    expect(requestBody).toMatchObject({
      stream: false,
      input: [{ role: 'user', content: 'ping' }]
    });
    expect(requestBody).not.toHaveProperty('messages');
  });

  it('baseUrl 已是完整 /v1/responses 路径 → 不二次拼接', async () => {
    handler = (req, res) =>
      collectBody(req, res, () => json(res, 200, { status: 'completed', output: [] }));
    await client({ baseUrl: `http://127.0.0.1:${port}/v1/responses` }).chatOnce([
      { role: 'user', content: 'x' }
    ]);
    expect(requestUrl).toBe('/v1/responses');
  });

  it('tools/tool_choice/maxTokens → 扁平 tools + tool_choice + max_output_tokens', async () => {
    handler = (req, res) =>
      collectBody(req, res, () =>
        json(res, 200, {
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'c1', name: 'echo', arguments: '{}' }]
        })
      );
    const r = await client().chatOnce([{ role: 'user', content: 'x' }], {
      tools: [{ type: 'function', function: { name: 'echo', parameters: { type: 'object' } } }],
      toolChoice: 'required',
      maxTokens: 256
    });
    expect(requestBody).toMatchObject({
      tool_choice: 'required',
      max_output_tokens: 256,
      tools: [{ type: 'function', name: 'echo', parameters: { type: 'object' } }]
    });
    expect(r.toolCalls?.[0]).toEqual({
      id: 'c1',
      type: 'function',
      function: { name: 'echo', arguments: '{}' }
    });
    expect(r.finishReason).toBe('tool_calls');
  });

  it('持续 429 overloaded → SessionExpiredError（错误分类与 chat 风格共用）', async () => {
    handler = (_req, res) =>
      json(res, 429, { error: { message: 'service overloaded', code: 'overloaded' } });
    await expect(client().chatOnce([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(
      SessionExpiredError
    );
    expect(requestCount).toBe(4);
  });

  it('status=failed 的 200 响应 → 抛 LlmError（不伪装成功）', async () => {
    handler = (req, res) =>
      collectBody(req, res, () =>
        json(res, 200, { status: 'failed', error: { message: 'provider exploded' } })
      );
    await expect(client().chatOnce([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(
      LlmError
    );
  });
});

describe('responses 流式', () => {
  it('SSE：event: 行忽略、delta 累计、completed 收尾（finishReason/工具调用）', async () => {
    handler = (req, res) =>
      collectBody(req, res, () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const frames = [
          'event: response.created\ndata: {"type":"response.created"}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"半"}\n\n',
          'data: {"type":"response.output_text.delta","delta":"句"}\n\n',
          'data: {"type":"response.output_item.added","index":0,"item":{"type":"function_call","index":0,"call_id":"call-7","name":"echo","arguments":""}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_index":0,"delta":"{\\"v\\":1}"}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"半句"}]},{"type":"function_call","call_id":"call-7","name":"echo","arguments":"{\\"v\\":1}"}]}}\n\n'
        ];
        let i = 0;
        const tick = () => {
          if (i < frames.length) {
            res.write(frames[i++]);
            setTimeout(tick, 10);
          } else {
            res.end();
          }
        };
        tick();
      });

    const contents: string[] = [];
    const r = await client().streamChat([{ role: 'user', content: 'hi' }], {
      onContentDelta: (t) => contents.push(t)
    });
    expect(r.content).toBe('半句');
    expect(contents).toEqual(['半', '句']);
    expect(r.finishReason).toBe('tool_calls'); // 有工具调用 → 与 chat 风格同语义
    expect(r.toolCalls).toEqual([
      { id: 'call-7', type: 'function', function: { name: 'echo', arguments: '{"v":1}' } }
    ]);
    expect(requestUrl).toBe('/v1/responses');
    expect(requestBody).toMatchObject({ stream: true });
  });

  it('response.failed 帧 → 抛 LlmError（可见失败）', async () => {
    handler = (req, res) =>
      collectBody(req, res, () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"response.output_text.delta","delta":"x"}\n\n');
        res.write('data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n');
        res.end();
      });
    await expect(client().streamChat([{ role: 'user', content: 'x' }])).rejects.toThrow(/boom/);
  });

  it('流中断（连接提前关闭，无终态帧）→ 返回已收内容、不抛错', async () => {
    handler = (req, res) =>
      collectBody(req, res, () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"response.output_text.delta","delta":"部分"}\n\n');
        res.end();
      });
    const r = await client().streamChat([{ role: 'user', content: 'x' }]);
    expect(r.content).toBe('部分');
    expect(r.finishReason).toBeUndefined();
  });

  it('流式请求先 429 再成功（建流前可重试，与 chat 风格一致）', async () => {
    let calls = 0;
    handler = (req, res) => {
      calls++;
      if (calls === 1) {
        return json(res, 429, { error: { message: 'overloaded', code: 'overloaded' } });
      }
      collectBody(req, res, () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"response.output_text.delta","delta":"ok"}\n\n');
        res.write('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');
        res.end();
      });
    };
    const r = await client().streamChat([{ role: 'user', content: 'x' }]);
    expect(r.content).toBe('ok');
  });

  it('流式中途中止 → AbortError', async () => {
    const ctrl = new AbortController();
    handler = (req, res) =>
      collectBody(req, res, () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"response.output_text.delta","delta":"先"}\n\n');
        res.on('close', () => undefined);
      });
    const p = client().streamChat(
      [{ role: 'user', content: 'x' }],
      { onContentDelta: () => ctrl.abort() },
      { signal: ctrl.signal }
    );
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
