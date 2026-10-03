/**
 * 阶段 7：受控命令执行工具（shell，DEV_PLAN §5.7/§6 安全核心）。
 *
 * - 只执行「正向白名单」（ALLOWED_COMMANDS）内的单进程只读命令，
 *   白名单外一律拒绝（无法证明安全的命令拒绝执行）；
 *   另有 DENY_COMMANDS 明确拒绝名单先行拦截，
 *   防御未来扩充白名单时误放行 cmd/powershell 等解释器。
 * - LLM 输出不可信，层层设防：
 *   validateInput 严格 schema（命令非空、参数每项 ≤2048 字符、≤32 项、未知键拒绝）
 *   → assess 策略判定（命令名禁路径分隔符、先查拒绝名单再查白名单、
 *     逐个参数过工作区路径边界，越界合并为一次带警告的 ask）
 *   → approval:'ask' 每次用户确认
 *   → execute 二次校验（deny 抛错、越界必须 ctx.allowOutside 确认）后才 spawn。
 * - 执行期约束：spawn(shell:false) 切断 shell 解释链路、cwd 固定工作区、
 *   最小环境变量（buildMinimalEnv 纯函数，不继承调用方环境）、
 *   stdout+stderr 合计 100_000 字符截断并结束子进程、支持 ctx.signal 取消；
 *   退出码非 0 不抛异常（返回给模型自行判断），spawn 失败（ENOENT 等）才抛错。
 * 命令匹配大小写不敏感、允许带可执行后缀（匹配前先剥离）。
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { ChatToolDefinition } from '../../llm/types';
import type { ToolAssessment, ToolRegistration } from '../registry';
import type { AgentToolContext } from '../runtime';
import { resolveWorkspacePath } from './pathguard';

/** 正向白名单：全部为单进程只读工具（可在工作区内直接 spawn） */
export const ALLOWED_COMMANDS: readonly string[] = [
  'whoami',
  'hostname',
  'ipconfig',
  'systeminfo',
  'tasklist',
  'findstr',
  'fc',
  'where',
  'tree'
];

/** 明确拒绝名单：先于白名单判定，防止未来扩白名单时误放行解释器/下载器 */
export const DENY_COMMANDS: readonly string[] = [
  'cmd',
  'powershell',
  'pwsh',
  'wscript',
  'cscript',
  'mshta',
  'rundll32',
  'reg',
  'regsvr32',
  'schtasks',
  'certutil',
  'bitsadmin',
  'msiexec',
  'wmic',
  'net',
  'netsh',
  'rshell',
  'net1'
];

/** stdout+stderr 合计输出上限（字符数），超出截断并结束子进程 */
export const MAX_OUTPUT_CHARS = 100_000;
/** 单个参数长度上限 */
export const MAX_ARG_CHARS = 2048;
/** 参数个数上限 */
export const MAX_ARGS = 32;

const CODE_BACKSLASH = 92; // 反斜杠
const CODE_SLASH = 47; // 正斜杠
const CODE_COLON = 58; // 冒号

const DEFINITION: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'shell',
    description: '在工作区内执行白名单只读命令（白名单外一律拒绝）',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '可执行文件名，不含路径（如 findstr）' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '参数列表，不经 shell 解释'
        }
      },
      required: ['command'],
      additionalProperties: false
    }
  }
};

export interface ShellInput {
  /** 可执行文件名（不含路径，可带可执行后缀） */
  command: string;
  /** 参数列表（不经 shell 解释） */
  args?: string[];
}

export interface ShellResult {
  /** 模型给出的原始命令名 */
  command: string;
  args: string[];
  /** 进程退出码；被信号结束时为 null */
  code: number | null;
  /** 进程被信号终止时的信号名（未被信号终止时省略） */
  signalKilled?: string | null;
  stdout: string;
  stderr: string;
  /** 输出合计超限被截断（此时子进程已被结束） */
  truncated: boolean;
}

/**
 * 最小环境变量（纯函数）：只保留系统运行必需的少量变量，
 * PATH 只指向系统目录，杜绝调用方环境变量（密钥、代理等）泄漏给子进程。
 */
export function buildMinimalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const systemRoot = env.SystemRoot;
  const windir = env.windir;
  const minimal: NodeJS.ProcessEnv = {};
  if (systemRoot !== undefined && systemRoot !== '') {
    minimal.SystemRoot = systemRoot;
    // 等价于把系统根目录与 System32 目录拼接为 PATH
    minimal.PATH = path.win32.join(systemRoot, 'System32');
  }
  if (windir !== undefined) {
    minimal.windir = windir;
  }
  if (env.TEMP !== undefined) {
    minimal.TEMP = env.TEMP;
  }
  if (env.TMP !== undefined) {
    minimal.TMP = env.TMP;
  }
  return minimal;
}

/** 是否含路径分隔符或盘符冒号（命令名必须是纯可执行名） */
function hasPathSeparator(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CODE_BACKSLASH || c === CODE_SLASH || c === CODE_COLON) return true;
  }
  return false;
}

/**
 * 命令名归一：去首尾空白、剥离可执行后缀（仅 .exe）、转小写。
 * Windows 大小写不敏感，归一结果即最终 spawn 的命令名（命中白名单才执行）。
 */
function normalizeCommandName(command: string): string {
  let name = command.trim();
  if (name.length > 4 && name.slice(-4).toLowerCase() === '.exe') {
    name = name.slice(0, -4);
  }
  return name.toLowerCase();
}

/** schema 严格校验：对象、命令非空字符串、参数可选且每项受限、未知键拒绝 */
function isInput(value: unknown): value is ShellInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'command' && key !== 'args') return false;
  }
  if (typeof record.command !== 'string' || record.command.trim() === '') return false;
  if ('args' in record && record.args !== undefined) {
    if (!Array.isArray(record.args)) return false;
    if (record.args.length > MAX_ARGS) return false;
    for (const arg of record.args) {
      if (typeof arg !== 'string') return false;
      if (arg.length > MAX_ARG_CHARS) return false;
    }
  }
  return true;
}

/**
 * 策略钩子（assess，execute 也复用同一套实现以保证二次校验等价）：
 * 结构不合法 / 带路径 / 拒绝名单 / 不在白名单 → deny（附可读原因）；
 * 参数触及工作区外 → ask+outside（合并进一次审批）；否则 allow。
 */
function assessShell(workspaceRoot: string, value: unknown): ToolAssessment {
  if (!isInput(value)) {
    return { decision: 'deny', reason: '参数结构不合法' };
  }
  const command = value.command.trim();
  if (hasPathSeparator(command)) {
    return { decision: 'deny', reason: '命令必须是白名单内的可执行名，不含路径' };
  }
  const normalized = normalizeCommandName(command);
  if (DENY_COMMANDS.includes(normalized)) {
    return { decision: 'deny', reason: '该命令被安全策略禁止' };
  }
  if (!ALLOWED_COMMANDS.includes(normalized)) {
    return {
      decision: 'deny',
      reason: `命令不在白名单内：${command}（无法证明安全的命令拒绝执行）`
    };
  }
  const outsidePaths: string[] = [];
  for (const arg of value.args ?? []) {
    // 形如 /i 的旗标会被解析成工作区内路径，无害；真正的越界路径在此被记录
    const check = resolveWorkspacePath(workspaceRoot, arg);
    if (!check.ok) {
      return { decision: 'deny', reason: check.reason ?? '命令参数路径不安全' };
    }
    if (check.outside === true && check.resolved !== undefined) {
      outsidePaths.push(check.resolved);
    }
  }
  if (outsidePaths.length > 0) {
    return {
      decision: 'ask',
      outside: true,
      reason: `命令参数触及工作区外路径：${outsidePaths.join('、')}`
    };
  }
  return { decision: 'allow' };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/** 把取消信号的 reason 归一为可抛出的错误（AbortError 语义） */
function toAbortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    return reason as Error;
  }
  return new DOMException('Aborted', 'AbortError');
}

/** 构造 shell 注册项（approval:'ask'，risk:'exec'） */
export function createShellTool(workspaceRoot: string): ToolRegistration {
  return {
    risk: 'exec',
    approval: 'ask',
    source: 'builtin',
    assess: (value: unknown) => assessShell(workspaceRoot, value),
    tool: {
      definition: DEFINITION,
      validateInput: isInput,
      async execute(raw: unknown, ctx: AgentToolContext): Promise<ShellResult> {
        if (!isInput(raw)) {
          throw new Error('参数结构不合法');
        }
        // 防御纵深：执行前重新跑与 assess 等价的全部校验
        const assessment = assessShell(workspaceRoot, raw);
        if (assessment.decision === 'deny') {
          throw new Error(assessment.reason ?? '工具策略拒绝执行');
        }
        if (assessment.outside === true && ctx.allowOutside !== true) {
          throw new Error('越界操作未获用户确认');
        }
        throwIfAborted(ctx.signal);

        const args = raw.args ?? [];
        // spawn 名用归一结果：它已被证明命中白名单（大小写不敏感、后缀已剥离）
        const spawnName = normalizeCommandName(raw.command);
        const child = spawn(spawnName, args, {
          cwd: workspaceRoot,
          shell: false,
          windowsHide: true,
          env: buildMinimalEnv(process.env),
          signal: ctx.signal,
          // stdin 直接关闭：findstr/fc 等在缺文件参数时读 stdin，开着会挂住
          stdio: ['ignore', 'pipe', 'pipe']
        });

        return await new Promise<ShellResult>((resolvePromise, rejectPromise) => {
          let stdout = '';
          let stderr = '';
          let truncated = false;
          let settled = false;

          const settle = (): boolean => {
            if (settled) return false;
            settled = true;
            ctx.signal?.removeEventListener('abort', handleAbort);
            return true;
          };

          function handleAbort(): void {
            if (!settle()) return;
            rejectPromise(toAbortError(ctx.signal));
          }
          ctx.signal?.addEventListener('abort', handleAbort, { once: true });

          const appendChunk = (chunk: string, isStdout: boolean): void => {
            if (settled || truncated) return;
            const total = stdout.length + stderr.length;
            const room = MAX_OUTPUT_CHARS - total;
            if (chunk.length <= room) {
              if (isStdout) stdout += chunk;
              else stderr += chunk;
              return;
            }
            const kept = chunk.slice(0, room);
            if (isStdout) stdout += kept;
            else stderr += kept;
            truncated = true;
            try {
              child.kill();
            } catch {
              // 子进程可能已退出
            }
          };

          child.stdout?.setEncoding('utf8');
          child.stderr?.setEncoding('utf8');
          child.stdout?.on('data', (chunk: string) => appendChunk(chunk, true));
          child.stderr?.on('data', (chunk: string) => appendChunk(chunk, false));

          child.on('error', (error: Error) => {
            if (!settle()) return;
            // 取消导致的 kill 也走 error 事件：统一归一为 AbortError
            rejectPromise(ctx.signal?.aborted ? toAbortError(ctx.signal) : error);
          });

          child.on('close', (code: number | null, exitSignal: NodeJS.Signals | null) => {
            if (!settle()) return;
            resolvePromise({
              command: raw.command,
              args,
              code,
              signalKilled: exitSignal ?? undefined,
              stdout,
              stderr,
              truncated
            });
          });
        });
      }
    }
  };
}
