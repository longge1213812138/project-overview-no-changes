/**
 * 阶段 8：MCP → ToolRegistration 装配单测（安全不变量 + 宽松入参校验 + 调用委托）。
 */
import { describe, expect, it, vi } from 'vitest';
import { buildMcpRegistrations } from './builder';
import type { McpClient } from './client';

function fakeClient(over: Partial<McpClient> = {}): McpClient {
  return {
    serverName: 'demo-server',
    state: 'ready',
    tools: [
      {
        name: 'demo_fetch',
        description: '抓取内容',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
          // 外部服务可能带 anyOf 等子集外关键字：必须被忽略而不是空校验
          anyOf: [{ required: ['url'] }]
        }
      },
      { name: 'shell', description: '与内置工具重名', inputSchema: { type: 'object' } }
    ],
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    ...over
  } as unknown as McpClient;
}

describe('buildMcpRegistrations', () => {
  it('安全不变量：approval 恒 ask、risk 恒 exec、source=mcp、描述带服务名', () => {
    const client = fakeClient();
    const result = buildMcpRegistrations(client, { existingNames: ['shell'] });
    expect(result.registrations).toHaveLength(1);
    const reg = result.registrations[0];
    expect(reg.approval).toBe('ask');
    expect(reg.risk).toBe('exec');
    expect(reg.source).toBe('mcp');
    expect(reg.tool.definition.function.description).toContain('MCP 服务「demo-server」');
    // 冲突工具跳过且错误可见（连接不断）
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('shell');
  });

  it('入参宽松校验：子集生效、子集外关键字忽略（不空校验）', () => {
    const client = fakeClient();
    const reg = buildMcpRegistrations(client, { existingNames: [] }).registrations[0];
    expect(reg.assess?.({ url: 'https://x' })).toEqual({ decision: 'allow' });
    expect(reg.assess?.({})?.decision).toBe('deny'); // required 生效
    expect(reg.assess?.({ url: 1 })?.decision).toBe('deny'); // type 生效
    expect(reg.tool.validateInput({ url: 'x' })).toBe(true);
  });

  it('execute：二次校验后委托 client.callTool（取消信号透传）', async () => {
    const client = fakeClient();
    const reg = buildMcpRegistrations(client, { existingNames: [] }).registrations[0];
    const out = await reg.tool.execute({ url: 'https://x' }, {});
    expect(out).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(client.callTool).toHaveBeenCalledWith('demo_fetch', { url: 'https://x' }, expect.any(Object));
    await expect(reg.tool.execute({ bad: 1 }, {})).rejects.toThrow(/url/);
  });
});
