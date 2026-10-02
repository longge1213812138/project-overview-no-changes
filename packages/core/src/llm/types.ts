/** OpenAI 兼容 LLM 客户端类型（阶段 2，见 docs/llm-bridge-notes.md §3） */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  reasoning?: string;
  finishReason?: string;
}

/** 流式回调：content/reasoning 分别累进投递 */
export interface StreamHandlers {
  onContentDelta?(text: string): void;
  onReasoningDelta?(text: string): void;
}

export interface LlmClientOptions {
  /** 网关地址，如 http://127.0.0.1:22217（尾斜杠会被去掉） */
  baseUrl: string;
  apiKey: string;
  /** 默认 'default'（= deepseek-default，见 llm-bridge-notes §3） */
  model?: string;
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
