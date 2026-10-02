import { LlmAuthError, LlmError, SessionExpiredError } from './errors';
import type {
  ChatCallOptions,
  ChatMessage,
  ChatResult,
  LlmClient,
  LlmClientOptions,
  StreamHandlers
} from './types';

const RETRY_LIMIT = 3; // 最多重试 3 次（DEV_PLAN §6 阶段 2：4xx 指数退避 ≤3）

type Failure =
  | { kind: 'expired'; status: 429 }
  | { kind: 'auth'; message: string }
  | { kind: 'retry'; status?: number; message: string }
  | { kind: 'fatal'; status: number; message: string };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return (e instanceof DOMException && e.name === 'AbortError') || signal?.aborted === true;
}

export function createLlmClient(opts: LlmClientOptions): LlmClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const model = opts.model ?? 'default';
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
  const base = opts.retryBaseDelayMs ?? 1000;

  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json'
  };

  function buildBody(messages: ChatMessage[], stream: boolean, maxTokens?: number): string {
    const body: Record<string, unknown> = { model, stream, messages };
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    return JSON.stringify(body);
  }

  /** 非 2xx / 网络失败 → 失败分类（指纹见 llm-bridge-notes §4） */
  function classify(status: number, text: string): Failure {
    if (status === 401 && text.includes('invalid_api_token')) {
      return { kind: 'auth', message: '401 invalid_api_token' };
    }
    if (status === 429 && /overloaded/i.test(text)) {
      return { kind: 'expired', status: 429 };
    }
    if (status === 429 || status >= 500) {
      return { kind: 'retry', status, message: text.slice(0, 300) };
    }
    return { kind: 'fatal', status, message: text.slice(0, 300) };
  }

  function toError(f: Failure): Error {
    switch (f.kind) {
      case 'expired':
        return new SessionExpiredError();
      case 'auth':
        return new LlmAuthError(`LLM API Key 无效：${f.message}`);
      case 'fatal':
        return new LlmError(`LLM 请求失败 [${f.status}] ${f.message}`, f.status);
      case 'retry':
        return new LlmError(`LLM 请求重试耗尽 [${f.status ?? 'net'}] ${f.message}`, f.status);
    }
  }

  /** 发起请求（建连/响应头阶段受 timeoutMs 约束；流存活另由 idle 计时控制） */
  async function post(
    body: string,
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<Response> {
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(
      () => timeoutCtrl.abort(new DOMException('timeout', 'TimeoutError')),
      timeoutMs
    );
    const onAbort = () => timeoutCtrl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: timeoutCtrl.signal
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async function readErrorBody(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return '';
    }
  }

  async function chatOnce(messages: ChatMessage[], o?: ChatCallOptions): Promise<ChatResult> {
    const body = buildBody(messages, false, o?.maxTokens);
    let last: Failure = { kind: 'retry', message: 'no attempt' };

    for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
      if (attempt > 0) await sleep(base * 2 ** (attempt - 1), o?.signal);
      let res: Response;
      try {
        res = await post(body, o?.signal, requestTimeoutMs);
      } catch (e) {
        if (isAbort(e, o?.signal)) {
          // 用户中止 vs 超时：超时可重试，中止直接抛
          if (o?.signal?.aborted) throw e;
          last = { kind: 'retry', message: 'request timeout' };
          continue;
        }
        last = { kind: 'retry', message: e instanceof Error ? e.message : String(e) };
        continue;
      }

      if (!res.ok) {
        const f = classify(res.status, await readErrorBody(res));
        if (f.kind === 'auth' || f.kind === 'fatal') throw toError(f);
        last = f;
        continue;
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
      };
      const msg = json.choices?.[0]?.message;
      return {
        content: msg?.content ?? '',
        reasoning: msg?.reasoning_content,
        finishReason: json.choices?.[0]?.finish_reason
      };
    }
    throw toError(last);
  }

  async function streamChat(
    messages: ChatMessage[],
    handlers?: StreamHandlers,
    o?: ChatCallOptions
  ): Promise<ChatResult> {
    const body = buildBody(messages, true, o?.maxTokens);
    let last: Failure = { kind: 'retry', message: 'no attempt' };

    for (let attempt = 0; attempt <= RETRY_LIMIT; attempt++) {
      if (attempt > 0) await sleep(base * 2 ** (attempt - 1), o?.signal);
      let res: Response;
      try {
        res = await post(body, o?.signal, requestTimeoutMs);
      } catch (e) {
        if (isAbort(e, o?.signal)) {
          if (o?.signal?.aborted) throw e;
          last = { kind: 'retry', message: 'connect timeout' };
          continue;
        }
        last = { kind: 'retry', message: e instanceof Error ? e.message : String(e) };
        continue;
      }

      if (!res.ok) {
        const f = classify(res.status, await readErrorBody(res));
        if (f.kind === 'auth' || f.kind === 'fatal') throw toError(f);
        last = f;
        continue; // 尚未产生任何 delta，安全重试
      }
      if (!res.body) {
        last = { kind: 'retry', message: 'empty response body' };
        continue;
      }

      // 已进入流：不再重试（避免回调重复投递），错误直接抛出
      return await readSseStream(res, handlers, o?.signal);
    }
    throw toError(last);
  }

  async function readSseStream(
    res: Response,
    handlers?: StreamHandlers,
    signal?: AbortSignal
  ): Promise<ChatResult> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning: string | undefined;
    let finishReason: string | undefined;

    const cancel = () => reader.cancel().catch(() => undefined);

    // 用户中止
    const onAbort = () => void cancel();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        // idle 超时：chunk 间超时即取消并抛错
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_, reject) => {
          idleTimer = setTimeout(
            () => reject(new LlmError(`流式响应超时（${idleTimeoutMs}ms 无新 chunk）`)),
            idleTimeoutMs
        );
        });
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await Promise.race([reader.read(), idle]);
        } finally {
          clearTimeout(idleTimer);
        }

        if (signal?.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new DOMException('Aborted', 'AbortError');
        }

        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });

        // 按行处理（跨 chunk 半行留在 buf）
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue; // 忽略空行/注释行
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            finishReason = finishReason ?? 'stop';
            return finish();
          }
          let obj: {
            choices?: {
              delta?: { content?: string; reasoning_content?: string };
              finish_reason?: string;
            }[];
          };
          try {
            obj = JSON.parse(payload);
          } catch {
            continue; // 防御：残缺帧跳过
          }
          const choice = obj.choices?.[0];
          if (!choice) continue;
          const d = choice.delta;
          if (d?.reasoning_content) {
            reasoning = (reasoning ?? '') + d.reasoning_content;
            handlers?.onReasoningDelta?.(d.reasoning_content);
          }
          if (d?.content) {
            content += d.content;
            handlers?.onContentDelta?.(d.content);
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
            return finish();
          }
        }
      }
      return finish();
    } finally {
      signal?.removeEventListener('abort', onAbort);
      void cancel();
    }

    function finish(): ChatResult {
      return { content, reasoning, finishReason };
    }
  }

  return { chatOnce, streamChat };
}
