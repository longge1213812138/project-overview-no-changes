/**
 * 阶段 8：MCP 客户端端到端单测（真实 spawn 假服务器，覆盖握手/调用/错误/崩溃/断连）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient, McpError } from './client';

const cleanups: string[] = [];

/**
 * 假 MCP 服务（stdio）：
 * - initialize 成功后先发一行垃圾（协议错误可见性）+ 一条反向请求 roots/list，
 *   **必须收到 -32601 应答后才处理后续消息**（验证客户端反向请求应答不挂服务端）；
 * - mode=crash：应答 tools/list 后 150ms 带 stderr 退出（意外退出可见）；
 * - tools：echo / fail_tool(isError) / badshape(结构非法) / hang(不回应) / 无 name 条目（警告）。
 */
const SERVER_SCRIPT = `
const readline = require('node:readline');
const mode = process.argv[2] || 'normal';
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\\n');
// 闸门：发出反向请求后才开始排队（initialize 必须先被正常处理，不能自锁）
let gating = false;
const queue = [];

function handle(msg) {
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: {
      protocolVersion: '2024-11-05', capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '9.9.9' }
    }});
    if (mode === 'normal') {
      process.stdout.write('GARBAGE-NOT-JSON\\n');
      send({ id: 'rev-1', method: 'roots/list', params: {} });
      gating = true;
    }
    if (mode === 'crash') setTimeout(() => { process.stderr.write('boom-crash'); process.exit(7); }, 400);
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.id === 'rev-1') { gating = false; while (queue.length) handle(queue.shift()); return; }
  if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools: [
      { name: 'echo', description: 'Echo 输入',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
      { name: 'fail_tool', description: '返回 isError', inputSchema: { type: 'object' } },
      { name: 'badshape', description: '坏返回', inputSchema: { type: 'object' } },
      { name: 'hang', description: '不回应', inputSchema: { type: 'object' } },
      { description: '缺 name 的坏条目' },
      { name: 'noschema', description: '缺 inputSchema' }
    ] }});
    return;
  }
  if (msg.method === 'tools/call') {
    const n = msg.params && msg.params.name;
    if (n === 'echo') { send({ id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(msg.params.arguments) }] } }); return; }
    if (n === 'fail_tool') { send({ id: msg.id, result: { content: [{ type: 'text', text: 'nope' }], isError: true } }); return; }
    if (n === 'badshape') { send({ id: msg.id, result: { nope: true } }); return; }
    if (n === 'hang') return;
    send({ id: msg.id, error: { code: -32602, message: 'unknown tool' } });
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
}

rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch (e) { return; }
  if (gating && msg.id !== 'rev-1') { queue.push(msg); return; }
  handle(msg);
});
`;

function writeServer(mode = 'normal'): { command: string; args: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-mcp-'));
  cleanups.push(dir);
  const script = join(dir, 'fake-mcp.js');
  writeFileSync(script, SERVER_SCRIPT, 'utf8');
  return { command: process.execPath, args: [script, mode], dir };
}

async function connectReady(mode = 'normal'): Promise<{ client: McpClient; dir: string }> {
  const server = writeServer(mode);
  const client = new McpClient('fake');
  await client.connect({ name: 'fake', command: server.command, args: server.args, cwd: server.dir });
  return { client, dir: server.dir };
}

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
});

describe('McpClient 连接与握手', () => {
  it('正常连接：ready + 服务端自述 + 工具归一（坏条目跳过、缺 schema 回退、警告可见）', async () => {
    const { client } = await connectReady();
    expect(client.state).toBe('ready');
    expect(client.serverInfo.name).toBe('fake-mcp');
    expect(client.serverInfo.version).toBe('9.9.9');
    expect(client.tools.map((t) => t.name)).toEqual([
      'echo', 'fail_tool', 'badshape', 'hang', 'noschema'
    ]);
    expect(client.tools.find((t) => t.name === 'noschema')?.inputSchema).toEqual({ type: 'object' });
    expect(client.schemaWarnings.some((w) => w.includes('缺 name'))).toBe(true);
    expect(client.schemaWarnings.some((w) => w.includes('inputSchema 缺失'))).toBe(true);
    // 垃圾行被记录为可见协议问题，但连接不受影响
    expect(client.protocolIssues.some((i) => i.includes('GARBAGE-NOT-JSON'))).toBe(true);
    client.disconnect();
    expect(client.state).toBe('stopped');
    // 不在此处 rmSync：taskkill 异步，子进程可能尚持有目录句柄（afterEach 统一容错清理）
  });

  it('反向请求必须被 -32601 应答（否则握手无法完成——假服务以此为闸）', async () => {
    // connectReady 成功本身即证明客户端应答了 roots/list（见 SERVER_SCRIPT 闸门）
    const { client } = await connectReady();
    expect(client.state).toBe('ready');
    client.disconnect();
  });

  it('命令不存在 → 连接抛错且状态 error 可见', async () => {
    const client = new McpClient('ghost');
    await expect(
      client.connect({ name: 'ghost', command: 'fairy-no-such-mcp.exe', args: [] })
    ).rejects.toThrow();
    expect(client.state).toBe('error');
    expect(client.lastError).toBeTruthy();
  });

  it('意外退出（crash mode）→ state=error + stderr/code 可见 + onExit 触发', async () => {
    const { client } = await connectReady('crash');
    expect(client.state).toBe('ready');
    const exited = new Promise<string>((resolve) => {
      client.onExit = (reason) => resolve(reason);
    });
    const reason = await Promise.race([
      exited,
      new Promise<string>((resolve) => setTimeout(() => resolve('TIMEOUT'), 5_000))
    ]);
    expect(reason).not.toBe('TIMEOUT');
    expect(reason).toContain('code=7');
    expect(reason).toContain('boom-crash');
    expect(client.state).toBe('error');
    client.disconnect();
  });
});

describe('McpClient 工具调用', () => {
  it('echo：入参透传，返回结构校验通过', async () => {
    const { client } = await connectReady();
    const result = await client.callTool('echo', { text: 'hi' });
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: '{"text":"hi"}' }]);
    client.disconnect();
  });

  it('isError 结果原样透出（不抛错，模型自行判断）', async () => {
    const { client } = await connectReady();
    const result = await client.callTool('fail_tool', {});
    expect(result.isError).toBe(true);
    client.disconnect();
  });

  it('未知工具 → JSON-RPC error 抛可见 McpError', async () => {
    const { client } = await connectReady();
    await expect(client.callTool('nope', {})).rejects.toThrow(McpError);
    await expect(client.callTool('nope', {})).rejects.toThrow(/-32602/);
    client.disconnect();
  });

  it('返回结构非法（缺 content）→ 抛可见错误', async () => {
    const { client } = await connectReady();
    await expect(client.callTool('badshape', {})).rejects.toThrow(/结构非法/);
    client.disconnect();
  });

  it('超时：hang 工具短超时 → 抛超时错误，连接仍可用', async () => {
    const { client } = await connectReady();
    await expect(client.callTool('hang', {}, { timeoutMs: 300 })).rejects.toThrow(/超时/);
    const echo = await client.callTool('echo', { text: 'still-alive' });
    expect(echo.content).toHaveLength(1);
    client.disconnect();
  });

  it('断连 → 挂起调用立即拒绝（已断开）+ 后续调用报未就绪', async () => {
    const { client } = await connectReady();
    const pendingCall = client.callTool('hang', {}, { timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 100));
    client.disconnect('测试断开');
    await expect(pendingCall).rejects.toThrow(/已断开/);
    expect(client.state).toBe('stopped');
    await expect(client.callTool('echo', {})).rejects.toThrow(/未就绪/);
  });
});
