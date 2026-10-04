/**
 * 阶段 8：JSON-RPC 行协议单测。
 */
import { describe, expect, it } from 'vitest';
import { encodeJsonRpc, formatJsonRpcError, parseJsonRpcLine } from './protocol';

describe('parseJsonRpcLine', () => {
  it('解析请求/通知/成功响应/错误响应（含 \\r\\n）', () => {
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"method":"x","params":{}}')).toEqual({
      jsonrpc: '2.0', id: 1, method: 'x', params: {}
    });
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","method":"notifications/initialized"}\r')).toEqual({
      jsonrpc: '2.0', method: 'notifications/initialized'
    });
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}')).toEqual({
      jsonrpc: '2.0', id: 7, result: { ok: true }
    });
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":"a","error":{"code":-1,"message":"m"}}')).toEqual({
      jsonrpc: '2.0', id: 'a', error: { code: -1, message: 'm' }
    });
  });

  it('非法输入一律 null（绝不静默当合法）', () => {
    expect(parseJsonRpcLine('')).toBeNull();
    expect(parseJsonRpcLine('   ')).toBeNull();
    expect(parseJsonRpcLine('not-json')).toBeNull();
    expect(parseJsonRpcLine('[1,2]')).toBeNull();
    expect(parseJsonRpcLine('{"jsonrpc":"1.0","id":1,"method":"x"}')).toBeNull(); // 版本不符
    expect(parseJsonRpcLine('{"id":1,"method":"x"}')).toBeNull(); // 缺 jsonrpc
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":1}')).toBeNull(); // 请求缺 method、响应缺 result/error
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"error":"not-object"}')).toBeNull();
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":1,"error":{"code":"x","message":"m"}}')).toBeNull();
    expect(parseJsonRpcLine('{"jsonrpc":"2.0","id":null,"result":{}}')).toBeNull(); // 响应 id 非法
  });

  it('encodeJsonRpc 以换行结尾且可回环解析', () => {
    const line = encodeJsonRpc({ jsonrpc: '2.0', id: 3, method: 'ping' });
    expect(line.endsWith('\n')).toBe(true);
    expect(parseJsonRpcLine(line)).toEqual({ jsonrpc: '2.0', id: 3, method: 'ping' });
  });

  it('formatJsonRpcError 可读', () => {
    expect(formatJsonRpcError({ code: -32601, message: 'no' })).toContain('-32601');
  });
});
