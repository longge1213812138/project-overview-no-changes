/**
 * 阶段 7：只读文件工具（workspace_files，DEV_PLAN §5.7/§6）。
 *
 * - 职责：给模型一个受限的只读文件视野——list 列目录、read 读文本文件。
 * - LLM 输出不可信，防御纵深四层：
 *   1. validateInput：schema 严格结构校验（op 必须命中枚举、未知键拒绝）；
 *   2. assess：resolveWorkspacePath 策略判定——不安全直接 deny（不进审批），
 *      工作区外标记 ask+outside（审批 UI 必须展示越界警告）；
 *   3. approval:'auto'：策略判定通过即执行（路径边界已由 assess 把关）；
 *   4. execute：重新解析路径二次校验，未获越界确认（ctx.allowOutside）即抛错。
 * - 读取上限 128KB（超出 truncated:true）、目录上限 500 项（超出截断并标记）、
 *   前 8KB 含空字节按二进制处理（不回传正文，只给提示）；
 *   开始前及关键步骤检查 ctx.signal（抛 AbortError）。
 * 全中文注释；返回值均可 JSON 序列化。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatToolDefinition } from '../../llm/types';
import type { ToolAssessment, ToolRegistration } from '../registry';
import type { AgentToolContext } from '../runtime';
import { resolveWorkspacePath } from './pathguard';

/** 目录单次最多返回的条目数（超出截断并标记 truncated） */
const MAX_ENTRIES = 500;
/** 文件单次最多读取的字节数（128KB） */
const MAX_READ_BYTES = 128 * 1024;
/** 二进制探测窗口（前 8KB 含空字节即判定为二进制） */
const BINARY_PROBE_BYTES = 8 * 1024;

const DEFINITION: ChatToolDefinition = {
  type: 'function',
  function: {
    name: 'workspace_files',
    description: '列出或读取工作区内的文件（只读）',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'read'], description: 'list=列目录，read=读文件' },
        path: { type: 'string', description: '工作区内相对路径，默认当前目录' }
      },
      required: ['op'],
      additionalProperties: false
    }
  }
};

export interface WorkspaceFilesInput {
  op: 'list' | 'read';
  /** 工作区内相对路径，缺省为当前目录 */
  path?: string;
}

export interface WorkspaceFileEntry {
  name: string;
  type: 'dir' | 'file' | 'other';
  size?: number;
  mtimeMs?: number;
}

export interface WorkspaceFilesListResult {
  /** 解析后的目标目录绝对路径 */
  path: string;
  entries: WorkspaceFileEntry[];
  /** 条目数超过上限被截断 */
  truncated: boolean;
}

export interface WorkspaceFilesReadResult {
  path: string;
  size: number;
  /** 内容超过 128KB 被截断 */
  truncated: boolean;
  /** true = 判定为二进制（此时不回传 content，只给 note） */
  binary: boolean;
  /** utf8 文本内容（binary=false 时给出） */
  content?: string;
  /** 二进制时的可读说明 */
  note?: string;
}

/** schema 严格校验：对象、op 命中枚举、path 缺省或字符串、未知键拒绝 */
function isInput(value: unknown): value is WorkspaceFilesInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!('op' in record)) return false;
  if (record.op !== 'list' && record.op !== 'read') return false;
  if ('path' in record && record.path !== undefined && typeof record.path !== 'string') {
    return false;
  }
  for (const key of Object.keys(record)) {
    if (key !== 'op' && key !== 'path') return false;
  }
  return true;
}

/** 策略钩子：路径不安全 → deny；工作区外 → ask+outside；否则 allow */
function assessInput(workspaceRoot: string, value: unknown): ToolAssessment {
  if (!isInput(value)) {
    return { decision: 'deny', reason: '参数结构不合法' };
  }
  const check = resolveWorkspacePath(workspaceRoot, value.path ?? '.');
  if (!check.ok) {
    return { decision: 'deny', reason: check.reason ?? '路径不安全' };
  }
  if (check.outside === true) {
    return { decision: 'ask', outside: true, reason: `将访问工作区外路径：${check.resolved}` };
  }
  return { decision: 'allow' };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

/** list：列目录，每项带类型与（可取到时的）大小/修改时间，最多 500 条 */
async function listDirectory(
  target: string,
  signal?: AbortSignal
): Promise<WorkspaceFilesListResult> {
  const dirents = await fs.promises.readdir(target, { withFileTypes: true });
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const truncated = dirents.length > MAX_ENTRIES;
  const entries: WorkspaceFileEntry[] = [];
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    throwIfAborted(signal);
    const type: WorkspaceFileEntry['type'] = dirent.isDirectory()
      ? 'dir'
      : dirent.isFile()
        ? 'file'
        : 'other';
    const entry: WorkspaceFileEntry = { name: dirent.name, type };
    if (type !== 'other') {
      try {
        const stat = await fs.promises.stat(path.join(target, dirent.name));
        entry.size = stat.size;
        entry.mtimeMs = stat.mtimeMs;
      } catch {
        // 条目在列举后被删除等竞争：仅缺 size/mtime，不影响结果
      }
    }
    entries.push(entry);
  }
  return { path: target, entries, truncated };
}

/** read：校验是普通文件，只读前 128KB，前 8KB 含空字节按二进制处理 */
async function readFile(
  target: string,
  signal?: AbortSignal
): Promise<WorkspaceFilesReadResult> {
  const stat = await fs.promises.stat(target);
  if (!stat.isFile()) {
    throw new Error(`目标不是普通文件：${target}`);
  }
  const handle = await fs.promises.open(target, 'r');
  try {
    throwIfAborted(signal);
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    throwIfAborted(signal);
    const truncated = bytesRead > MAX_READ_BYTES;
    const used = truncated ? MAX_READ_BYTES : bytesRead;
    const probeLength = Math.min(BINARY_PROBE_BYTES, used);
    if (buffer.subarray(0, probeLength).includes(0)) {
      return {
        path: target,
        size: stat.size,
        truncated,
        binary: true,
        note: '文件前 8KB 含空字节，判定为二进制，未返回正文'
      };
    }
    return {
      path: target,
      size: stat.size,
      truncated,
      binary: false,
      content: buffer.subarray(0, used).toString('utf8')
    };
  } finally {
    await handle.close();
  }
}

/** 构造 workspace_files 注册项（approval:'auto'，risk:'read'） */
export function createWorkspaceFilesTool(workspaceRoot: string): ToolRegistration {
  return {
    risk: 'read',
    approval: 'auto',
    source: 'builtin',
    assess: (value: unknown) => assessInput(workspaceRoot, value),
    tool: {
      definition: DEFINITION,
      validateInput: isInput,
      async execute(raw: unknown, ctx: AgentToolContext): Promise<unknown> {
        if (!isInput(raw)) {
          throw new Error('参数结构不合法');
        }
        throwIfAborted(ctx.signal);
        // 防御纵深：执行前重新解析（assess 已判过一次，此处不信任缓存）
        const check = resolveWorkspacePath(workspaceRoot, raw.path ?? '.');
        if (!check.ok) {
          throw new Error(check.reason ?? '路径不安全');
        }
        if (check.outside === true && ctx.allowOutside !== true) {
          throw new Error('越界访问未获用户确认');
        }
        const target = check.resolved;
        if (target === undefined) {
          throw new Error('路径解析失败');
        }
        if (raw.op === 'list') {
          return listDirectory(target, ctx.signal);
        }
        return readFile(target, ctx.signal);
      }
    }
  };
}
