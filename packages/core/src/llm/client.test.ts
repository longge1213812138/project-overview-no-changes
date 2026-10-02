import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLlmClient } from './index';
import { LlmAuthError, LlmError, SessionExpiredError } from './errors';

let server: http.Server;
let port = 0;
let requestCount = 0;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function client(over: Partial<Parameters<typeof createLlmClient>[0]> = {}) {
  return createLlmClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'sk-test',
    retryBaseDelayMs: 10,
    requestTimeoutMs: 3000,
    idleTimeoutMs: 500,
    ...over
  });
}

beforeEach(() => {
  requestCount = 0;
  handler = (_req, res) => json(res, 500, { error: 'unset handler' });
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

describe('chatOnce', () => {
  it('非流式正常返回 content/reasoning', async () => {
    handler = (_req, res) =>
      json(res, 200, {
        choices: [
          { message: { content: '你好', reasoning_content: '想想' }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 }
      });
    const r = await client().chatOnce([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('你好');
    expect(r.reasoning).toBe('想想');
    expect(r.finishReason).toBe('stop');
    expect(requestCount).toBe(1);
  });

  it('401 invalid_api_token → LlmAuthError 且不重试', async () => {
    handler = (_req, res) =>
      json(res, 401, {
        error: { message: 'invalid api token', type: 'authentication_error', code: 'invalid_api_token' }
      });
    await expect(client().chatOnce([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(
      LlmAuthError
    );
    expect(requestCount).toBe(1);
  });

  it('持续 429 overloaded → SessionExpiredError（重试 3 次后）', async () => {
    handler = (_req, res) =>
      json(res, 429, { error: { message: 'service overloaded', type: 'server_error', code: 'overloaded' } });
    await expect(client().chatOnce([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(
      SessionExpiredError
    );
    expect(requestCount).toBe(4); // 1 次原始 + 3 次重试
  });

  it('5xx 指数退避重试后成功', async () => {
    handler = (_req, res) => {
      if (requestCount <= 2) return json(res, 500, { error: 'boom' });
      json(res, 200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    };
    const r = await client().chatOnce([{ role: 'user', content: 'x' }]);
    expect(r.content).toBe('ok');
    expect(requestCount).toBe(3);
  });

  it('400 不重试 → LlmError', async () => {
    handler = (_req, res) => json(res, 400, { error: { message: 'bad request' } });
    await expect(client().chatOnce([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      name: 'LlmError',
      status: 400
    });
    expect(requestCount).toBe(1);
  });

  it('用户 AbortSignal 中止 → AbortError', async () => {
    const ctrl = new AbortController();
    handler = (_req, res) => {
      // 挂住不响应，等中止
      setTimeout(() => ctrl.abort(), 30);
    };
    const p = client().chatOnce([{ role: 'user', content: 'x' }], { signal: ctrl.signal });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('streamChat', () => {
  it('SSE 解析：忽略 obfuscation、跨 chunk 半行、无 [DONE]、reasoning+content 累积', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frames = [
        'data: {"choices":[{"delta":{"role":"assistant","obfuscation":"QUJD"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n',
        'data: {"choices":[{"delta":{"co', // 半行，下一帧补完
        'ntent":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        // 故意不发 [DONE]
      ];
      let i = 0;
      const tick = () => {
        if (i < frames.length) {
          res.write(frames[i++]);
          setTimeout(tick, 15);
        } else {
          res.end();
        }
      };
      tick();
    };
    const contents: string[] = [];
    const reasons: string[] = [];
    const r = await client().streamChat([{ role: 'user', content: 'hi' }], {
      onContentDelta: (t) => contents.push(t),
      onReasoningDelta: (t) => reasons.push(t)
    });
    expect(r.content).toBe('你好');
    expect(r.reasoning).toBe('思考');
    expect(r.finishReason).toBe('stop');
    expect(contents).toEqual(['你', '好']);
    expect(reasons).toEqual(['思考']);
  });

  it('流式请求先 429 overloaded 再成功（建流前可重试）', async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls++;
      if (calls === 1) {
        return json(res, 429, { error: { message: 'service overloaded', code: 'overloaded' } });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.end();
    };
    const r = await client().streamChat([{ role: 'user', content: 'x' }]);
    expect(r.content).toBe('ok');
  });

  it('流中断（连接提前关闭）→ 返回已收内容，不抛错', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n');
      res.end();
    };
    const r = await client().streamChat([{ role: 'user', content: 'x' }]);
    expect(r.content).toBe('部分');
    expect(r.finishReason).toBeUndefined();
  });

  it('idle 超时 → LlmError', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      // 之后不再写也不结束，直到连接被取消
      res.on('close', () => undefined);
    };
    const c = client({ idleTimeoutMs: 100 });
    await expect(c.streamChat([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(LlmError);
  });

  it('流式中途中止 → AbortError', async () => {
    const ctrl = new AbortController();
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"先"}}]}\n\n');
      // 保持连接，等待客户端中止
      res.on('close', () => undefined);
    };
    const p = client().streamChat(
      [{ role: 'user', content: 'x' }],
      {
        onContentDelta: () => ctrl.abort()
      },
      { signal: ctrl.signal }
    );
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
