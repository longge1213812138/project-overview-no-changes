/**
 * OpenAI **Responses API**（POST …/v1/responses）协议适配——与 Chat Completions 并列的
 * 第二种 api 通道接口风格（设置页 `api.apiStyle = 'responses'`）。
 *
 * 本文件只做协议映射（纯函数，可单测）；重试/超时/错误分类/SSE 行读取共用 client.ts：
 * - 请求：ChatMessage[] → `input` 项数组（tool 消息 → function_call_output、
 *   assistant 带工具调用 → assistant 文本 + function_call 项，项 id 合成 `fc_<call_id>`）；
 *   ChatToolDefinition[] → 扁平 `{type:'function', name, …}`（Responses 无嵌套 function）；
 *   `maxTokens` → `max_output_tokens`；tool_choice 取值 auto/none/required 相同。
 * - 响应（非流式）：`output[]` → content/reasoning/toolCalls/finishReason；
 * - 响应（流式）：事件帧（`type` 字段）累计——output_text/reasoning delta 走回调，
 *   function_call 经 output_item.added / function_call_arguments.delta|.done /
 *   output_item.done 累计，`response.completed|failed|incomplete` 终止；
 * - 空 arguments 归一为 `'{}'`（runtime JSON.parse 需要合法 JSON）；
 * - `response.failed` / 帧内 error → 抛 LlmError（可见，不伪装成功）。
 */
import { LlmError } from './errors';
import type {
  ChatCallOptions,
  ChatMessage,
  ChatResult,
  ChatToolCall,
  ChatToolDefinition,
  StreamHandlers
} from './types';

// ===== 请求映射 =====

/**
 * function_call 项 id：`fc_` 前缀 + 服务端给的 call_id。
 * 严格端点（AgnesAI /v1/responses，2026-10 实测）要求 `input` 里 function_call 项带
 * **以 `fc_` 开头的 id**，否则报
 * 「input: data did not match any variant of untagged enum ResponseInput」400 —— 联网
 * 触发工具循环的第二轮就死在这里。id 只做项标识，不必等于服务端原本的项 id。
 */
export function toFunctionCallItemId(callId: string): string {
  return `fc_${callId}`;
}

/** ChatMessage[] → Responses `input` 数组（顺序保持；工具结果/调用转 item 形态） */
export function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      // Responses 无 role:tool 消息，工具结果必须是 function_call_output 项
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId ?? '',
        output: message.content
      });
      continue;
    }
    if (message.role === 'assistant') {
      // assistant 文本（空则不发）+ 紧随其后的 function_call 项（按调用顺序）
      if (message.content !== '') {
        input.push({ role: 'assistant', content: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          // 项 id：多数实现把它当可选，但严格要求 item_id 前缀的端点（如 AgnesAI，
          // 实测缺 id / 非 `fc_` 前缀 → 整个 input 反序列化失败 400）必须给。
          // 我方模型只持有服务端下发的 call_id，故按它合成一个确定性 `fc_` id：
          // 同一个 call 每次重发得到同一个项 id（无随机性、可回归）。
          id: toFunctionCallItemId(call.id),
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments
        });
      }
      continue;
    }
    // system / user：content 用纯字符串（Responses 接受 string 或 parts 数组，取兼容面最大的）
    input.push({ role: message.role, content: message.content });
  }
  return input;
}

/** ChatToolDefinition[] → Responses 扁平 function 工具定义 */
export function toResponsesTools(tools: ChatToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    parameters: tool.function.parameters
  }));
}

/** 构建 Responses 请求体（chat/completions 风格的构建仍在 client.ts） */
export function buildResponsesBody(args: {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  options?: ChatCallOptions;
}): string {
  const body: Record<string, unknown> = {
    model: args.model,
    stream: args.stream,
    input: toResponsesInput(args.messages)
  };
  if (args.options?.maxTokens !== undefined) body.max_output_tokens = args.options.maxTokens;
  if (args.options?.tools?.length) body.tools = toResponsesTools(args.options.tools);
  if (args.options?.toolChoice !== undefined) body.tool_choice = args.options.toolChoice;
  return JSON.stringify(body);
}

// ===== 响应映射（共用的小工具） =====

interface ResponsesFunctionCall {
  call_id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

function fnCallToChat(call: ResponsesFunctionCall, where: string): ChatToolCall {
  const id = call.call_id;
  const name = call.name;
  const args = call.arguments;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '') {
    throw new LlmError(`Responses 返回的 function_call 字段无效（${where}）`);
  }
  return {
    id,
    type: 'function',
    function: {
      name,
      // 空参数归一为合法 JSON '{}'（runtime 会 JSON.parse arguments）
      arguments: typeof args === 'string' && args !== '' ? args : '{}'
    }
  };
}

function isFunctionCallItem(item: unknown): item is ResponsesFunctionCall & { type: 'function_call' } {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'function_call'
  );
}

/** parts 数组（summary/content）里所有 `text` 字段拼接 */
function textsOf(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  let out = '';
  for (const part of parts) {
    if (typeof part === 'object' && part !== null) {
      const value = (part as Record<string, unknown>).text;
      if (typeof value === 'string') out += value;
    }
  }
  return out;
}

/** 从 output 数组提取文本 / reasoning / 工具调用（非流式与流式收尾共用） */
function collectFromOutput(output: unknown): {
  content: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
} {
  let content = '';
  let reasoning = '';
  const toolCalls: ChatToolCall[] = [];
  if (!Array.isArray(output)) return { content, reasoning, toolCalls };
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (o.type === 'message') {
      const parts = o.content;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part === 'object' && part !== null) {
            const p = part as Record<string, unknown>;
            if ((p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string') {
              content += p.text;
            }
          }
        }
      }
    } else if (o.type === 'reasoning') {
      reasoning += textsOf(o.summary);
      reasoning += textsOf(o.content);
    } else if (isFunctionCallItem(item)) {
      toolCalls.push(fnCallToChat(item, 'output'));
    }
  }
  return { content, reasoning, toolCalls };
}

function finishReasonFor(status: string | undefined, hasToolCalls: boolean): string | undefined {
  if (hasToolCalls) return 'tool_calls';
  if (status === 'completed' || status === undefined) return 'stop';
  if (status === 'incomplete') return 'length';
  return undefined;
}

/** 非流式响应（POST stream:false）→ ChatResult；failed → 抛错（可见） */
export function parseResponsesResult(json: unknown): ChatResult {
  if (typeof json !== 'object' || json === null) {
    throw new LlmError('Responses 响应不是 JSON 对象');
  }
  const resp = json as Record<string, unknown>;
  const status = typeof resp.status === 'string' ? resp.status : undefined;
  if (status === 'failed') {
    const err = resp.error as { message?: unknown } | undefined;
    const message =
      typeof err?.message === 'string' && err.message !== '' ? err.message : 'unknown error';
    throw new LlmError(`Responses 请求失败：${message}`);
  }
  const { content, reasoning, toolCalls } = collectFromOutput(resp.output);
  return {
    content,
    ...(reasoning !== '' ? { reasoning } : {}),
    finishReason: finishReasonFor(status, toolCalls.length > 0),
    ...(toolCalls.length > 0 ? { toolCalls } : {})
  };
}

// ===== 流式事件累计 =====

/** function_call 按 output item index 累计（delta 事件只有 item_index） */
interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFrameAccumulator {
  /**
   * 处理一条 SSE data 载荷（含 '[DONE]' 标记）；返回 true = 流已到终态帧，可停止读取。
   * 非 JSON / 未知事件类型一律忽略（防御：厂商私有帧不致命）。
   */
  push(payload: string): boolean;
  /** 读流结束（终态帧或连接关闭）后收尾；failed/error 抛 LlmError，半途关闭返回已收内容 */
  finish(): ChatResult;
}

/** 创建 Responses 流式累计器（handlers 直接透传 content/reasoning delta） */
export function createResponsesAccumulator(handlers?: StreamHandlers): ResponsesFrameAccumulator {
  let content = '';
  let reasoning: string | undefined;
  let status: string | undefined;
  let failure: string | undefined;
  let finalOutput: unknown;
  let sawTerminal = false;
  const callsByIndex = new Map<number, PartialCall>();
  let fallbackIndex = 0;

  function callAt(index: unknown): PartialCall {
    const key = typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : fallbackIndex;
    const existing = callsByIndex.get(key);
    if (existing) return existing;
    const created: PartialCall = { id: '', name: '', arguments: '' };
    callsByIndex.set(key, created);
    fallbackIndex = Math.max(fallbackIndex, key + 1);
    return created;
  }

  return {
    push(payload: string): boolean {
      if (payload === '[DONE]') {
        status = status ?? 'completed';
        sawTerminal = true;
        return true;
      }
      let obj: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (typeof parsed !== 'object' || parsed === null) return false;
        obj = parsed as Record<string, unknown>;
      } catch {
        return false; // 防御：残缺帧跳过（与 chat 风格一致）
      }

      switch (obj.type) {
        case 'response.output_text.delta': {
          if (typeof obj.delta === 'string' && obj.delta !== '') {
            content += obj.delta;
            handlers?.onContentDelta?.(obj.delta);
          }
          return false;
        }
        case 'response.reasoning_text.delta':
        case 'response.reasoning_summary_text.delta': {
          if (typeof obj.delta === 'string' && obj.delta !== '') {
            reasoning = (reasoning ?? '') + obj.delta;
            handlers?.onReasoningDelta?.(obj.delta);
          }
          return false;
        }
        case 'response.output_item.added': {
          const item = obj.item as Record<string, unknown> | undefined;
          if (item && item.type === 'function_call') {
            const target = callAt(item.index ?? obj.index);
            target.id = typeof item.call_id === 'string' ? item.call_id : target.id;
            target.name = typeof item.name === 'string' ? item.name : target.name;
            if (typeof item.arguments === 'string') target.arguments = item.arguments;
          }
          return false;
        }
        case 'response.function_call_arguments.delta': {
          if (typeof obj.delta === 'string' && obj.delta !== '') {
            callAt(obj.item_index).arguments += obj.delta;
          }
          return false;
        }
        case 'response.function_call_arguments.done': {
          if (typeof obj.arguments === 'string') {
            callAt(obj.item_index).arguments = obj.arguments;
          }
          return false;
        }
        case 'response.output_item.done': {
          const item = obj.item as Record<string, unknown> | undefined;
          if (item && item.type === 'function_call') {
            const target = callAt(item.index ?? obj.index);
            if (typeof item.call_id === 'string' && item.call_id !== '') target.id = item.call_id;
            if (typeof item.name === 'string' && item.name !== '') target.name = item.name;
            if (typeof item.arguments === 'string') target.arguments = item.arguments;
          }
          return false;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const resp = obj.response as Record<string, unknown> | undefined;
          status =
            typeof resp?.status === 'string'
              ? resp.status
              : obj.type === 'response.completed'
                ? 'completed'
                : 'incomplete';
          finalOutput = resp?.output;
          sawTerminal = true;
          return true;
        }
        case 'response.failed': {
          const resp = obj.response as Record<string, unknown> | undefined;
          const err = resp?.error as { message?: unknown } | undefined;
          failure =
            typeof err?.message === 'string' && err.message !== ''
              ? err.message
              : 'response failed';
          status = 'failed';
          sawTerminal = true;
          return true;
        }
        case 'error': {
          const err = obj.error as { message?: unknown } | undefined;
          failure = typeof err?.message === 'string' && err.message !== '' ? err.message : 'stream error';
          status = 'failed';
          sawTerminal = true;
          return true;
        }
        default:
          return false; // response.created/in_progress、output_text.done、usage 等一律忽略
      }
    },

    finish(): ChatResult {
      if (failure !== undefined) {
        throw new LlmError(`Responses 流式请求失败：${failure}`);
      }

      // 工具调用：response.completed 携带的 output 权威优先；否则用事件累计（半途关闭场景）
      let toolCalls: ChatToolCall[] = [];
      let outputText = '';
      let outputReasoning = '';
      if (finalOutput !== undefined) {
        const collected = collectFromOutput(finalOutput);
        outputText = collected.content;
        outputReasoning = collected.reasoning;
        if (collected.toolCalls.length > 0) toolCalls = collected.toolCalls;
      }
      if (toolCalls.length === 0 && callsByIndex.size > 0) {
        const merged: ChatToolCall[] = [];
        for (const index of [...callsByIndex.keys()].sort((a, b) => a - b)) {
          const call = callsByIndex.get(index)!;
          if (call.id === '' && call.name === '') continue; // 空壳（只有 index 无内容）
          // 累计器内部用 id 字段名，function_call 形状是 call_id → 显式映射
          merged.push(
            fnCallToChat(
              { call_id: call.id, name: call.name, arguments: call.arguments },
              `stream#${index}`
            )
          );
        }
        toolCalls = merged;
      }

      const finalContent = content !== '' ? content : outputText;
      const finalReasoning = reasoning ?? (outputReasoning !== '' ? outputReasoning : undefined);
      // 终态帧缺失（连接提前关闭）→ finishReason 留空，已收内容照常返回（与 chat 风格一致）
      const finishReason = sawTerminal ? finishReasonFor(status, toolCalls.length > 0) : undefined;

      return {
        content: finalContent,
        ...(finalReasoning !== undefined && finalReasoning !== '' ? { reasoning: finalReasoning } : {}),
        ...(finishReason !== undefined ? { finishReason } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {})
      };
    }
  };
}
