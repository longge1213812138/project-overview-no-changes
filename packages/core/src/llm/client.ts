import { LlmAuthError, LlmError, SessionExpiredError } from './errors';
import type {
  ChatCallOptions,
  ChatMessage,
  ChatResult,
  ChatToolCall,
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
  /**
   * 端点归一（阶段 7 E2E 发现的真实配置形态）：用户可能按供应商示例把 baseUrl
   * 填成完整路径（…/v1/chat/completions），此时不得再二次拼接，否则 404。
   */
  const endpoint = /\/(v\d+\/)?chat\/completions$/.test(baseUrl)
    ? baseUrl
    : `${baseUrl}/v1/chat/completions`;
  const model = opts.model ?? 'default';
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
  const base = opts.retryBaseDelayMs ?? 1000;

  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json'
  };

  function parseToolCalls(value: unknown): ChatToolCall[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new LlmError('LLM 返回的 tool_calls 格式无效');
    return value.map((item, index) => {
      if (typeof item !== 'object' || item === null) {
        throw new LlmError(`LLM 返回的 tool_calls[${index}] 格式无效`);
      }
      const call = item as Record<string, unknown>;
      const fn = typeof call.function === 'object' && call.function !== null
        ? (call.function as Record<string, unknown>)
        : null;
      if (
        typeof call.id !== 'string' ||
        call.id === '' ||
        call.type !== 'function' ||
        !fn ||
        typeof fn.name !== 'string' ||
        fn.name === '' ||
        typeof fn.arguments !== 'string'
      ) {
        throw new LlmError(`LLM 返回的 tool_calls[${index}] 字段无效`);
      }
      return {
        id: call.id,
        type: 'function',
        function: { name: fn.name, arguments: fn.arguments }
      };
    });
  }

  function toWireMessage(message: ChatMessage): Record<string, unknown> {
    const { toolCallId, toolCalls, ...wire } = message;
    return {
      ...wire,
      ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
      ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {})
    };
  }

  function buildBody(messages: ChatMessage[], stream: boolean, options?: ChatCallOptions): string {
    const body: Record<string, unknown> = {
      model,
      stream,
      messages: messages.map(toWireMessage)
    };
    if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options?.tools?.length) body.tools = options.tools;
    if (options?.toolChoice !== undefined) body.tool_choice = options.toolChoice;
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
      return await fetch(endpoint, {
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
    const body = buildBody(messages, false, o);
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
        choices?: {
          message?: {
            content?: string | null;
            reasoning_content?: string;
            tool_calls?: unknown;
          };
          finish_reason?: string;
        }[];
      };
      const msg = json.choices?.[0]?.message;
      return {
        content: typeof msg?.content === 'string' ? msg.content : '',
        reasoning: msg?.reasoning_content,
        finishReason: json.choices?.[0]?.finish_reason,
        toolCalls: parseToolCalls(msg?.tool_calls)
      };
    }
    throw toError(last);
  }

  async function streamChat(
    messages: ChatMessage[],
    handlers?: StreamHandlers,
    o?: ChatCallOptions
  ): Promise<ChatResult> {
    const body = buildBody(messages, true, o);
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
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

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
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: {
                  index?: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }[];
              };
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
          for (const delta of d?.tool_calls ?? []) {
            const index = delta.index;
            if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
              throw new LlmError('LLM 返回的流式 tool_call index 无效');
            }
            const current = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
            if (delta.id !== undefined) current.id += delta.id;
            if (delta.function?.name !== undefined) current.name += delta.function.name;
            if (delta.function?.arguments !== undefined) {
              current.arguments += delta.function.arguments;
            }
            toolCalls.set(index, current);
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
      const calls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, call]) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments }
        }));
      return {
        content,
        reasoning,
        finishReason,
        ...(calls.length > 0 ? { toolCalls: parseToolCalls(calls) } : {})
      };
    }
  }

  return { chatOnce, streamChat };
}
