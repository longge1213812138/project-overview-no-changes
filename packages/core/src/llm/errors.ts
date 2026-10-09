/** LLM 客户端错误类型（阶段 2） */

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
