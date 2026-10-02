/** LLM 客户端错误类型（阶段 2）：指纹见 docs/llm-bridge-notes.md §4 */

/** 会话过期指纹：持续 429 overloaded（账号池无可用账号/凭据失效） */
export class SessionExpiredError extends Error {
  constructor(message = 'LLM 会话过期（持续 429 overloaded），请重新配置账号') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/** 401 invalid_api_token：API Key 配置问题，不重试 */
export class LlmAuthError extends Error {
  constructor(message = 'LLM API Key 无效（401 invalid_api_token）') {
    super(message);
    this.name = 'LlmAuthError';
  }
}

/** 其他不可恢复错误（4xx/重试耗尽的 5xx、网络、超时等） */
export class LlmError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}
