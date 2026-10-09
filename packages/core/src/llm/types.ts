/** OpenAI 兼容 LLM 客户端类型（阶段 2） */

/**
 * API 接口风格（设置页「接口风格」选择，config.json `api.apiStyle`）：
 * - 'chat'：Chat Completions（POST …/v1/chat/completions，默认）；
 * - 'responses'：Responses API（POST …/v1/responses）。
 */
export type ApiStyle = 'chat' | 'responses';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  finishReason?: string;
  toolCalls?: ChatToolCall[];
}

/** 流式回调：content/reasoning 分别累进投递 */
export interface StreamHandlers {
  onContentDelta?(text: string): void;
  onReasoningDelta?(text: string): void;
}

export interface LlmClientOptions {
  /** OpenAI 兼容 base，如 https://api.deepseek.com/v1（尾斜杠会被去掉） */
  baseUrl: string;
  apiKey: string;
  /** 模型名；缺省 'default' */
  model?: string;
  /** 接口风格：'chat'（默认，/v1/chat/completions）或 'responses'（/v1/responses） */
  apiStyle?: ApiStyle;
  /** chatOnce 总超时 ms，默认 60000 */
  requestTimeoutMs?: number;
  /** 流式两个 chunk 间最大间隔 ms，默认 30000 */
  idleTimeoutMs?: number;
  /** 退避基准 ms（默认 1000；测试注入小值） */
  retryBaseDelayMs?: number;
}

export interface ChatCallOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  tools?: ChatToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
}

export interface LlmClient {
  /** 非流式（意图解析等小调用拿完整 message+usage） */
  chatOnce(messages: ChatMessage[], opts?: ChatCallOptions): Promise<ChatResult>;
  /** 流式（聊天 UI）；忽略 obfuscation 字段，无 [DONE] 结尾，以 finish_reason/连接关闭为终点 */
  streamChat(
    messages: ChatMessage[],
    handlers?: StreamHandlers,
    opts?: ChatCallOptions
  ): Promise<ChatResult>;
}
