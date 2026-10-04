/**
 * 阶段 8：MCP JSON-RPC 2.0 线协议（stdio 传输，DEV_PLAN §5.8）。
 *
 * 传输约定（MCP stdio）：每条消息 = 一行 UTF-8 JSON（换行分隔；容忍 \r\n）。
 * - 请求：{jsonrpc:'2.0', id, method, params?}；响应：{jsonrpc:'2.0', id, result} 或
 *   {jsonrpc:'2.0', id, error:{code,message,data?}}；通知：无 id 的消息。
 * - 解析失败/结构非法一律返回 null（调用方按协议错误可见处理，绝不静默吞）。
 *
 * 只做协议编解码，不涉及进程管理（见 client.ts）。
 */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 编码一行请求/通知（含换行符） */
export function encodeJsonRpc(message: JsonRpcRequest | JsonRpcNotification): string {
  return JSON.stringify(message) + '\n'
}

/**
 * 解析一行消息；非法 → null。
 * 判定：jsonrpc 必须 '2.0'；有 id + method = 请求；无 id + method = 通知；
 * 有 id + (result 或 error) = 响应。
 */
export function parseJsonRpcLine(line: string): JsonRpcMessage | null {
  const text = line.replace(/\r$/, '')
  if (text.trim() === '') return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isPlainObject(value)) return null
  if (value.jsonrpc !== '2.0') return null
  const hasId = 'id' in value && value.id !== undefined && value.id !== null
  const idOk = hasId && (typeof value.id === 'number' || typeof value.id === 'string')
  const method = value.method

  if (typeof method === 'string') {
    if (hasId && !idOk) return null
    return hasId
      ? { jsonrpc: '2.0', id: value.id as number | string, method, ...( 'params' in value ? { params: value.params } : {}) }
      : { jsonrpc: '2.0', method, ...('params' in value ? { params: value.params } : {}) }
  }
  // 响应：必须有合法 id 且带 result 或 error 之一
  if (hasId && idOk && ('result' in value || isPlainObject(value.error))) {
    const response: JsonRpcResponse = { jsonrpc: '2.0', id: value.id as number | string }
    if ('result' in value) response.result = value.result
    if (isPlainObject(value.error)) {
      const err = value.error
      if (typeof err.code !== 'number' || typeof err.message !== 'string') return null
      response.error = { code: err.code, message: err.message, ...('data' in err ? { data: err.data } : {}) }
    }
    return response
  }
  return null
}

/** 服务器响应里的错误（MCP result.error / JSON-RPC error 归一） */
export function formatJsonRpcError(error: JsonRpcError): string {
  return `MCP 协议错误 code=${error.code}：${error.message}`
}
