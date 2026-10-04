/**
 * 阶段 8：MCP stdio 客户端（连接生命周期 + 工具调用，DEV_PLAN §5.8）。
 *
 * 生命周期（状态可见，失败即 error + lastError，绝不静默半开）：
 *   stopped → connect() → connecting → initialize → notifications/initialized
 *           → tools/list → ready；任一步失败/超时/进程崩溃 → error（子进程已清理）。
 *   disconnect(reason) → stopped（或意外退出 → error），全部挂起请求立即拒绝。
 *
 * 进程边界（如实声明）：
 * - spawn(command, args) 无 shell；cwd 默认由调用方给（工作区）；
 * - env = 最小 env + 宿主 PATH（外部服务的命令发现需要，与内置 shell 工具不同，
 *   此处刻意保留 PATH 并在实施备注声明）+ 用户配置的 env（凭据只经 DPAPI 注入，不落日志）；
 * - 超时：initialize/tools 10s、tools/call 60s（可覆盖）；取消信号 → 本地拒绝；
 * - 断连/退出 → taskkill 树杀（Windows）/SIGTERM，防孤儿进程；
 * - 协议错误可见：非法行计数 + 首个错误文本（protocolIssues），
 *   收到服务端反向请求 → 回 -32601 Method not found（不让服务端干等）。
 *
 * **无 OS 沙箱**：MCP 服务是用户显式配置的外部进程，其能力不可验证——
 * 安全边界 = 工具注册恒 approval:'ask'（每次调用审批，展示来源）+ 默认不连接。
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { buildMinimalEnv } from '../tools/shell';
import { encodeJsonRpc, formatJsonRpcError, parseJsonRpcLine } from './protocol';
import type { JsonRpcRequest } from './protocol';

/** 连接（initialize + tools/list）超时 */
export const MCP_CONNECT_TIMEOUT_MS = 10_000;
/** tools/list 单独超时（连接阶段内） */
export const MCP_TOOLS_TIMEOUT_MS = 10_000;
/** tools/call 默认超时 */
export const MCP_CALL_TIMEOUT_MS = 60_000;
/** 发送的协议版本（服务端可回自己的版本；v1 不做版本拒绝，只记录） */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
/** stdout/stderr 累计缓冲上限（字符），超出停止缓冲并断连（协议已不可信） */
export const MCP_MAX_BUFFER_CHARS = 500_000;

export type McpClientState = 'stopped' | 'connecting' | 'ready' | 'error';

/** 启动参数（凭据 env 由 main 从 DPAPI 解出后并入，core 不碰存储） */
export interface McpLaunchConfig {
  name: string;
  command: string;
  args: string[];
  /** 工作目录（缺省由调用方传工作区根） */
  cwd?: string;
  /** 追加环境变量（KEY→VALUE；含凭据，禁止写日志） */
  env?: Record<string, string>;
}

/** tools/list 条目（归一化后） */
export interface McpToolInfo {
  name: string;
  description: string;
  /** 输入 JSON Schema（宽松：缺失/非对象时回退为开放对象） */
  inputSchema: Record<string, unknown>;
}

/** tools/call 结果（结构已校验） */
export interface McpCallResult {
  content: Record<string, unknown>[];
  isError?: boolean;
}

export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpError';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * MCP 子进程环境：最小 env + 宿主 PATH（命令发现）+ USERPROFILE/HOME（多数运行时需要）
 * + 显式配置 env。应用内任何凭据不会自动进入——只有调用方在 launch.env 里给的才注入。
 */
export function buildMcpEnv(launch: McpLaunchConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...buildMinimalEnv(process.env) };
  if (process.env.PATH !== undefined && process.env.PATH !== '') env.PATH = process.env.PATH;
  if (process.env.USERPROFILE !== undefined) env.USERPROFILE = process.env.USERPROFILE;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  for (const [key, value] of Object.entries(launch.env ?? {})) {
    if (key.trim() !== '' && typeof value === 'string') env[key] = value;
  }
  return env;
}

/** Windows 上 kill 整棵进程树（防 MCP 服务的子进程变孤儿），非 win32 退化 SIGTERM */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.on('error', () => child.kill()); // taskkill 不可用时退化
    } catch {
      child.kill();
    }
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* 已退出 */
  }
}

export class McpClient {
  /** 服务名（配置键，日志/展示用；非工具名前缀） */
  readonly serverName: string;
  state: McpClientState = 'stopped';
  lastError: string | null = null;
  /** 服务端自述（initialize 返回） */
  serverInfo: { name?: string; version?: string; protocolVersion?: string } = {};
  tools: McpToolInfo[] = [];
  /** 归一化过程中的可见警告（坏条目/坏 schema 回退） */
  schemaWarnings: string[] = [];
  /** 协议层问题（非法行/超大缓冲）——设置页可见 */
  protocolIssues: string[] = [];
  /** 意外退出/断连时由 main 订阅（广播 mcp:changed 用） */
  onExit: ((reason: string) => void) | null = null;

  private child: ChildProcess | null = null;
  private seq = 0;
  private pending = new Map<number | string, Pending>();
  private lineBuffer = '';
  private bufferChars = 0;
  private closedByUs = false;

  constructor(serverName: string) {
    this.serverName = serverName;
  }

  /** 就绪才可调用（manager 在注册工具时已检查；这里是防御纵深） */
  private requireReady(): void {
    if (this.state !== 'ready' || this.child === null) {
      throw new McpError(`MCP 服务「${this.serverName}」未就绪（${this.state}${this.lastError ? `：${this.lastError}` : ''}）`);
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of [...this.pending.values()]) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  /** 行分发：响应→挂起请求；服务端请求→-32601；通知→忽略；非法行→记录可见 */
  private handleLine(line: string): void {
    const message = parseJsonRpcLine(line);
    if (message === null) {
      if (line.trim() !== '') {
        const issue = `非法消息行：${line.slice(0, 120)}`;
        this.protocolIssues.push(issue);
        if (this.protocolIssues.length > 5) this.protocolIssues.shift();
      }
      return;
    }
    if ('method' in message) {
      if ('id' in message) {
        // 服务端反向请求（roots/list、sampling 等）：v1 一律方法不支持，不让服务端干等
        const reply = JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Fairy 客户端不支持服务端请求（v1）' }
        });
        this.child?.stdin?.write(reply + '\n');
      }
      return; // 服务端通知：忽略（logging/progress 等 v1 不消费）
    }
    const pending = this.pending.get(message.id as number | string);
    if (pending === undefined) return; // 迟到/未知响应：忽略（本地已拒绝或超时）
    this.pending.delete(message.id as number | string);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(new McpError(formatJsonRpcError(message.error)));
      return;
    }
    pending.resolve(message.result);
  }

  private sendRequest(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const child = this.child;
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      return Promise.reject(new McpError(`MCP 服务「${this.serverName}」连接不可写`));
    }
    const id = ++this.seq;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new McpError(`MCP 请求超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        child.stdin?.write(encodeJsonRpc(request));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(new McpError(`MCP 写入失败：${(err as Error).message}`));
      }
    });
  }

  /**
   * 连接并完成握手：spawn → initialize → initialized → tools/list → ready。
   * 任一步失败 → error + 子进程清理 + 可读错误。
   */
  async connect(launch: McpLaunchConfig, options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.state === 'connecting' || this.state === 'ready') {
      throw new McpError(`MCP 服务「${this.serverName}」已处于连接流程中`);
    }
    const timeoutMs = options.timeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
    this.state = 'connecting';
    this.lastError = null;
    this.serverInfo = {};
    this.tools = [];
    this.schemaWarnings = [];
    this.protocolIssues = [];
    this.closedByUs = false;
    this.lineBuffer = '';
    this.bufferChars = 0;

    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildMcpEnv(launch)
    });
    this.child = child;

    // 断连/对端关闭后的异步流错误（EPIPE 等）必须有监听：
    // 未监听的 'error' 事件会成为未捕获异常（挂起请求已由 failAllPending 统一拒绝）
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.bufferChars += chunk.length;
      if (this.bufferChars > MCP_MAX_BUFFER_CHARS) {
        this.protocolIssues.push('输出缓冲超限，连接不可信，已断开');
        this.teardown('输出缓冲超限');
        return;
      }
      this.lineBuffer += chunk;
      let index = this.lineBuffer.indexOf('\n');
      while (index >= 0) {
        const line = this.lineBuffer.slice(0, index);
        this.lineBuffer = this.lineBuffer.slice(index + 1);
        this.handleLine(line);
        index = this.lineBuffer.indexOf('\n');
      }
    });
    let stderrText = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderrText.length < 4_000) stderrText += chunk;
    });

    child.on('error', (err) => {
      if (this.state === 'stopped') return;
      const message = `启动失败（${launch.command}）：${err.message}`;
      this.enterError(message);
    });
    child.on('close', (code, signal) => {
      if (this.closedByUs) return;
      const tail = stderrText.trim();
      this.enterError(
        `服务退出（code=${code}${signal ? ` signal=${signal}` : ''}）${tail ? `；stderr：${tail.slice(-300)}` : ''}`
      );
    });

    try {
      const init = await this.sendRequest(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'Fairy', version: '0.0.1' }
        },
        timeoutMs
      );
      if (!isPlainObject(init)) throw new McpError('initialize 返回结构非法（应为对象）');
      const info = init.serverInfo;
      if (isPlainObject(info)) {
        if (typeof info.name === 'string') this.serverInfo.name = info.name;
        if (typeof info.version === 'string') this.serverInfo.version = info.version;
      }
      if (typeof init.protocolVersion === 'string') this.serverInfo.protocolVersion = init.protocolVersion;

      // 已初始化通知（协议要求；服务端可忽略）
      child.stdin?.write(encodeJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));

      const listed = await this.sendRequest('tools/list', {}, MCP_TOOLS_TIMEOUT_MS);
      this.tools = this.normalizeTools(listed);

      this.state = 'ready';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.teardown(message);
      throw err instanceof McpError ? err : new McpError(`MCP 连接失败：${message}`);
    }
  }

  /** tools/list 结果结构校验 + 条目归一（坏条目跳过并记可见警告） */
  private normalizeTools(listed: unknown): McpToolInfo[] {
    if (!isPlainObject(listed) || !Array.isArray(listed.tools)) {
      throw new McpError('tools/list 返回结构非法（缺少 tools 数组）');
    }
    const tools: McpToolInfo[] = [];
    const seen = new Set<string>();
    for (const entry of listed.tools) {
      if (!isPlainObject(entry) || typeof entry.name !== 'string' || entry.name.trim() === '') {
        this.schemaWarnings.push('跳过结构非法的工具条目（缺 name）');
        continue;
      }
      if (seen.has(entry.name)) {
        this.schemaWarnings.push(`跳过重复工具名：${entry.name}`);
        continue;
      }
      const description = typeof entry.description === 'string' ? entry.description : '';
      let inputSchema: Record<string, unknown>;
      if (isPlainObject(entry.inputSchema)) {
        inputSchema = entry.inputSchema;
      } else {
        inputSchema = { type: 'object' };
        this.schemaWarnings.push(`工具 ${entry.name} 的 inputSchema 缺失/非法，已回退为开放对象`);
      }
      if (inputSchema.type !== undefined && inputSchema.type !== 'object') {
        inputSchema = { type: 'object' };
        this.schemaWarnings.push(`工具 ${entry.name} 的 inputSchema.type 非 object，已回退为开放对象`);
      }
      seen.add(entry.name);
      tools.push({ name: entry.name, description, inputSchema });
    }
    return tools;
  }

  /** 调用工具：结构校验结果（content 块 + isError），错误/超时/断连一律抛可见错误 */
  async callTool(
    name: string,
    args: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<McpCallResult> {
    this.requireReady();
    const timeoutMs = options.timeoutMs ?? MCP_CALL_TIMEOUT_MS;
    const signal = options.signal;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // 取消语义：本地立即拒绝（迟到响应按未知 id 忽略）；外部进程无法被我们中断，
    // 其自身副作用不受控——这正是每次调用必须审批的原因（实施备注如实声明）。
    let result: unknown;
    let onAbort: (() => void) | null = null;
    try {
      result = await new Promise<unknown>((resolvePromise, rejectPromise) => {
        onAbort = () => rejectPromise(new DOMException('Aborted', 'AbortError'));
        signal?.addEventListener('abort', onAbort, { once: true });
        this.sendRequest('tools/call', { name, arguments: args }, timeoutMs).then(resolvePromise, rejectPromise);
      });
    } finally {
      if (onAbort !== null) signal?.removeEventListener('abort', onAbort);
    }
    if (!isPlainObject(result) || !Array.isArray(result.content)) {
      throw new McpError(`MCP tools/call 返回结构非法（工具 ${name} 缺少 content 数组）`);
    }
    const content: Record<string, unknown>[] = [];
    for (const block of result.content) {
      if (!isPlainObject(block) || typeof block.type !== 'string') {
        throw new McpError(`MCP tools/call 返回内容块结构非法（工具 ${name}）`);
      }
      if (block.type === 'text' && typeof block.text !== 'string') {
        throw new McpError(`MCP tools/call 文本块缺 text 字段（工具 ${name}）`);
      }
      content.push(block);
    }
    const out: McpCallResult = { content };
    if (result.isError !== undefined) {
      if (typeof result.isError !== 'boolean') {
        throw new McpError(`MCP tools/call isError 非布尔（工具 ${name}）`);
      }
      if (result.isError) out.isError = true;
    }
    return out;
  }

  /** 主动断连（stopped）；挂起请求立即拒绝 */
  disconnect(reason = '用户断开'): void {
    if (this.child === null) {
      this.state = 'stopped';
      this.lastError = null;
      return;
    }
    this.closedByUs = true;
    this.failAllPending(new McpError(`MCP 服务「${this.serverName}」已断开：${reason}`));
    killTree(this.child);
    this.child = null;
    this.state = 'stopped';
    this.lastError = null;
    this.tools = [];
  }

  /** 连接期失败：清理子进程 → error */
  private teardown(reason: string): void {
    this.closedByUs = true;
    this.failAllPending(new McpError(`MCP 连接失败：${reason}`));
    if (this.child !== null) {
      killTree(this.child);
      this.child = null;
    }
    this.enterError(reason);
  }

  /** 进入 error 态（意外退出路径）：挂起请求拒绝 + 通知订阅者（幂等，防 close/error 双触发） */
  private enterError(reason: string): void {
    this.closedByUs = true;
    this.state = 'error';
    this.lastError = reason;
    this.tools = [];
    this.child = null;
    this.failAllPending(new McpError(`MCP 服务「${this.serverName}」错误：${reason}`));
    const onExit = this.onExit;
    onExit?.(reason);
  }
}
