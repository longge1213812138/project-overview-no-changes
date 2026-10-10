import { LlmError } from '../llm/errors';
import type {
  ChatMessage,
  ChatResult,
  ChatToolCall,
  ChatToolDefinition,
  LlmClient,
  StreamHandlers
} from '../llm/types';

export interface AgentTool {
  definition: ChatToolDefinition;
  validateInput(value: unknown): boolean;
  /** Must stop outstanding work and side effects when the signal is aborted. */
  execute(input: unknown, ctx: AgentToolContext): Promise<unknown>;
}

/** execute 上下文：超时/取消信号 + 授权决策（越界确认等）穿透 */
export interface AgentToolContext {
  signal?: AbortSignal;
  /** 用户已明确确认越界操作（仅授权链路能授予；工具执行器仍须自行校验） */
  allowOutside?: boolean;
}

/** 授权结果：布尔 = 简单批准/拒绝；对象可附带越界确认等决策 */
export interface AgentAuthDecision {
  approved: boolean;
  allowOutside?: boolean;
  /** 拒绝原因：回传给模型与工具事件（可观测） */
  reason?: string;
}

export type AgentAuthorize = (
  tool: AgentTool,
  input: unknown
) => Promise<boolean | AgentAuthDecision>;

export type AgentToolEvent =
  | { status: 'requested'; id: string; name: string }
  | { status: 'denied'; id: string; name: string; reason: string }
  | { status: 'started'; id: string; name: string }
  | { status: 'completed'; id: string; name: string }
  | { status: 'failed'; id: string; name: string; error: string };

export interface AgentRunOptions {
  signal?: AbortSignal;
  maxRounds?: number;
  maxToolCalls?: number;
  maxDurationMs?: number;
  maxToolExecutionMs?: number;
  maxAssistantChars?: number;
  maxToolResultChars?: number;
  authorize?: AgentAuthorize;
  onToolEvent?: (event: AgentToolEvent) => void;
}

export class AgentRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunError';
  }
}

export class AgentLimitError extends AgentRunError {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLimitError';
  }
}

const DEFAULT_MAX_ROUNDS = 6;
const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_MAX_DURATION_MS = 120_000;
const DEFAULT_MAX_TOOL_EXECUTION_MS = 15_000;
const DEFAULT_MAX_ASSISTANT_CHARS = 100_000;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 32_000;

function assertLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} 必须是正安全整数`);
  }
  return value;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
}

function parseInput(call: ChatToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments) as unknown;
  } catch {
    throw new AgentRunError(`工具 ${call.function.name} 的 arguments 不是有效 JSON`);
  }
}

function serializeResult(result: unknown): string {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    throw new AgentRunError('工具结果必须可序列化为 JSON');
  }
  return serialized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolErrorResult(message: string, maxChars: number): string {
  let truncated = message;
  let serialized = JSON.stringify({ error: truncated });
  while (serialized.length > maxChars && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
    serialized = JSON.stringify({ error: truncated });
  }
  return serialized;
}

function timedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  message: string
): { signal: AbortSignal; pause: () => void; resume: () => void; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });

  // 可暂停的时长预算：等待用户审批期间不计时（那是人的思考时间，不是 Agent 的耗时）。
  // 实测（2026-10 日志）：普通对话里一次生成等审批 4 次 × 数秒，足以把 maxDurationMs
  // 耗尽并报「Agent 执行超过最大时长」——用户看到的是一次失败，而不是「审批慢了」。
  // parent 的 abort（用户停止）仍立即生效，不受暂停影响。
  let remaining = timeoutMs;
  let armedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    controller.abort(new AgentLimitError(message));
  }, timeoutMs);

  const pause = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining = Math.max(0, remaining - (Date.now() - armedAt));
  };
  const resume = (): void => {
    if (timer !== undefined || controller.signal.aborted) return; // 已中止（用户停止/超时）不再续表
    if (remaining <= 0) {
      controller.abort(new AgentLimitError(message));
      return;
    }
    armedAt = Date.now();
    timer = setTimeout(() => controller.abort(new AgentLimitError(message)), remaining);
  };

  return {
    signal: controller.signal,
    pause,
    resume,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    }
  };
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('Aborted', 'AbortError')
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

export async function runAgent(
  client: LlmClient,
  messages: ChatMessage[],
  tools: AgentTool[],
  handlers?: StreamHandlers,
  options: AgentRunOptions = {}
): Promise<ChatResult> {
  const maxRounds = assertLimit(options.maxRounds ?? DEFAULT_MAX_ROUNDS, 'maxRounds');
  const maxToolCalls = assertLimit(
    options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    'maxToolCalls'
  );
  const maxDurationMs = assertLimit(
    options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
    'maxDurationMs'
  );
  const maxToolExecutionMs = assertLimit(
    options.maxToolExecutionMs ?? DEFAULT_MAX_TOOL_EXECUTION_MS,
    'maxToolExecutionMs'
  );
  const maxAssistantChars = assertLimit(
    options.maxAssistantChars ?? DEFAULT_MAX_ASSISTANT_CHARS,
    'maxAssistantChars'
  );
  const maxToolResultChars = assertLimit(
    options.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS,
    'maxToolResultChars'
  );
  if (maxToolResultChars < '{"error":""}'.length) {
    throw new RangeError(`maxToolResultChars 至少为 ${'{"error":""}'.length}`);
  }
  const toolByName = new Map<string, AgentTool>();
  for (const tool of tools) {
    const name = tool.definition.function.name;
    if (name.trim() === '' || toolByName.has(name)) {
      throw new AgentRunError(`工具名称为空或重复：${name}`);
    }
    toolByName.set(name, tool);
  }

  const conversation = [...messages];
  const definitions = tools.map((tool) => tool.definition);
  let rounds = 0;
  let toolCallCount = 0;
  let content = '';
  let assistantChars = 0;
  const run = timedSignal(options.signal, maxDurationMs, 'Agent 执行超过最大时长');

  try {
    for (;;) {
      abortIfNeeded(run.signal);
      let turnContent = '';
      let turnReasoning = '';
      const result = await client.streamChat(
        conversation,
        {
          onContentDelta: (text) => {
            if (assistantChars + text.length > maxAssistantChars) {
              throw new AgentLimitError(`Agent 回复超过最大长度（${maxAssistantChars} 字符）`);
            }
            assistantChars += text.length;
            content += text;
            turnContent += text;
            handlers?.onContentDelta?.(text);
          },
          onReasoningDelta: (text) => {
            if (assistantChars + text.length > maxAssistantChars) {
              throw new AgentLimitError(`Agent 回复超过最大长度（${maxAssistantChars} 字符）`);
            }
            assistantChars += text.length;
            turnReasoning += text;
            handlers?.onReasoningDelta?.(text);
          }
        },
        {
          signal: run.signal,
          ...(definitions.length > 0 ? { tools: definitions, toolChoice: 'auto' as const } : {})
        }
      );
      if (turnContent === '' && result.content !== '') {
        if (assistantChars + result.content.length > maxAssistantChars) {
          throw new AgentLimitError(`Agent 回复超过最大长度（${maxAssistantChars} 字符）`);
        }
        assistantChars += result.content.length;
        content += result.content;
        handlers?.onContentDelta?.(result.content);
      }
      if (turnReasoning === '' && result.reasoning !== undefined) {
        if (assistantChars + result.reasoning.length > maxAssistantChars) {
          throw new AgentLimitError(`Agent 回复超过最大长度（${maxAssistantChars} 字符）`);
        }
        assistantChars += result.reasoning.length;
        handlers?.onReasoningDelta?.(result.reasoning);
      }

      const calls = result.toolCalls ?? [];
      if (calls.length === 0) return { ...result, content };
      if (definitions.length === 0) {
        throw new LlmError('LLM 返回了工具调用，但当前没有注册可用工具');
      }
      if (rounds >= maxRounds) {
        throw new AgentLimitError(`Agent 工具循环超过最大轮数（${maxRounds}）`);
      }
      if (toolCallCount + calls.length > maxToolCalls) {
        throw new AgentLimitError(`Agent 工具调用超过最大次数（${maxToolCalls}）`);
      }

      const callIds = new Set<string>();
      for (const call of calls) {
        if (call.id === '' || callIds.has(call.id)) {
          throw new AgentRunError('LLM 返回了空或重复的 tool_call id');
        }
        callIds.add(call.id);
      }

      rounds += 1;
      toolCallCount += calls.length;
      conversation.push({
        role: 'assistant',
        content: result.content,
        toolCalls: calls
      });

      for (const call of calls) {
        abortIfNeeded(run.signal);
        const tool = toolByName.get(call.function.name);
        options.onToolEvent?.({ status: 'requested', id: call.id, name: call.function.name });
        if (!tool) {
          const reason = '工具未注册';
          options.onToolEvent?.({
            status: 'failed',
            id: call.id,
            name: call.function.name,
            error: reason
          });
          conversation.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.function.name,
            content: toolErrorResult(reason, maxToolResultChars)
          });
          continue;
        }

        const input = parseInput(call);
        if (!tool.validateInput(input)) {
          const reason = '工具参数未通过 schema 校验';
          options.onToolEvent?.({
            status: 'failed',
            id: call.id,
            name: call.function.name,
            error: reason
          });
          conversation.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.function.name,
            content: toolErrorResult(reason, maxToolResultChars)
          });
          continue;
        }

        const authorize = options.authorize;
        let rawDecision: boolean | AgentAuthDecision = false;
        if (authorize) {
          // 审批等待是人的时间：暂停时长预算，避免「等审批」把 Agent 判成超时
          run.pause();
          try {
            rawDecision = await raceWithAbort(
              Promise.resolve().then(() => authorize(tool, input)),
              run.signal
            );
          } finally {
            run.resume();
          }
        }
        const decision: AgentAuthDecision =
          typeof rawDecision === 'boolean' ? { approved: rawDecision } : rawDecision;
        if (!decision.approved) {
          const reason = decision.reason ?? '工具调用未获授权';
          options.onToolEvent?.({
            status: 'denied',
            id: call.id,
            name: call.function.name,
            reason
          });
          conversation.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.function.name,
            content: toolErrorResult(reason, maxToolResultChars)
          });
          continue;
        }

        abortIfNeeded(run.signal);
        options.onToolEvent?.({ status: 'started', id: call.id, name: call.function.name });
        const toolExecution = timedSignal(
          run.signal,
          maxToolExecutionMs,
          `工具 ${call.function.name} 执行超过最大时长`
        );
        try {
          const output = await raceWithAbort(
            tool.execute(input, {
              signal: toolExecution.signal,
              allowOutside: decision.allowOutside === true
            }),
            toolExecution.signal
          );
          const serialized = serializeResult(output);
          if (serialized.length > maxToolResultChars) {
            throw new AgentRunError(
              `工具 ${call.function.name} 结果超过最大长度（${maxToolResultChars} 字符）`
            );
          }
          conversation.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.function.name,
            content: serialized
          });
          options.onToolEvent?.({ status: 'completed', id: call.id, name: call.function.name });
        } catch (error) {
          if (toolExecution.signal.aborted) abortIfNeeded(toolExecution.signal);
          const reason = errorMessage(error);
          options.onToolEvent?.({
            status: 'failed',
            id: call.id,
            name: call.function.name,
            error: reason
          });
          conversation.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.function.name,
            content: toolErrorResult(reason, maxToolResultChars)
          });
        } finally {
          toolExecution.dispose();
        }
      }
    }
  } finally {
    run.dispose();
  }
}
