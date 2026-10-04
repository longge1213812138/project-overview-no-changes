/**
 * 阶段 8：Skill 工具执行器（DEV_PLAN §5.8；边界与阶段 7 shell 同一口径，如实声明）。
 *
 * 执行契约（与 skill 脚本作者的唯一接口，写进实施备注）：
 * - spawn(runtimeExec, [entryScript])，**不经 shell**，cwd=工作区；
 * - 请求：stdin 写入一行 JSON `{"tool": "<工具名>", "input": <模型入参>}` 后关闭；
 * - 响应：脚本把**单个 JSON 值**打印到 stdout（仅此一项；调试输出走 stderr），
 *   退出码 0；stdout 非合法 JSON / 退出码非 0 / 超时 → 抛错（错误可见）；
 * - 环境变量：最小 env（不继承宿主环境，密钥/代理不泄漏）+ 定向注入
 *   ELECTRON_RUN_AS_NODE（由调用方 runtimeEnv 决定）、FAIRY_SKILL_DIR /
 *   FAIRY_WORKSPACE_DIR / FAIRY_TOOL_NAME。
 *
 * 运行时约束：超时（manifest timeoutMs）→ kill；ctx.signal 取消 → kill + AbortError；
 * stdout+stderr 合计 100_000 字符截断即 kill；**无 OS 沙箱**——
 * 安全边界 = skill 默认禁用 + 内容指纹 + 每次调用审批（approval 恒 ask）+ 上述进程管控。
 */
import { spawn } from 'node:child_process';
import { buildMinimalEnv } from '../tools/shell';

/** stdout+stderr 合计输出上限（字符数），超出截断并结束子进程 */
export const SKILL_MAX_OUTPUT_CHARS = 100_000;

export interface SkillRunOptions {
  /** 运行时可执行文件（main 传 electron 的 process.execPath；测试传 node） */
  runtimeExec: string;
  /** 附加环境变量（如 { ELECTRON_RUN_AS_NODE: '1' }），叠加在最小 env 之上 */
  runtimeEnv?: Record<string, string>;
  /** entry 脚本绝对路径（discovery 已验证在技能包内） */
  entryPath: string;
  /** 技能包目录（注入 FAIRY_SKILL_DIR，脚本定位自身资源用） */
  skillDir: string;
  /** 工作区根（cwd + FAIRY_WORKSPACE_DIR） */
  workspaceRoot: string;
  /** 工具名（随请求传给脚本） */
  toolName: string;
  /** 模型给出的入参（已过 schema 校验） */
  input: unknown;
  /** 超时毫秒（manifest 声明，1000-60000） */
  timeoutMs: number;
  /** 取消信号（生成中止/停止） */
  signal?: AbortSignal;
}

function toAbortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === 'object' && reason !== null && 'message' in reason) return reason as Error;
  return new DOMException('Aborted', 'AbortError');
}

function stderrTail(text: string, max = 400): string {
  const clean = text.trim();
  if (clean === '') return '';
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

/**
 * 运行一个 skill 工具脚本，返回脚本打印的 JSON 值。
 * 失败一律抛错：超时 / 非零退出 / 输出非 JSON / spawn 失败 / 取消。
 */
export async function runSkillTool(options: SkillRunOptions): Promise<unknown> {
  const { runtimeExec, entryPath, skillDir, workspaceRoot, toolName, input, timeoutMs, signal } = options;

  const env: NodeJS.ProcessEnv = {
    ...buildMinimalEnv(process.env),
    ...(options.runtimeEnv ?? {}),
    FAIRY_SKILL_DIR: skillDir,
    FAIRY_WORKSPACE_DIR: workspaceRoot,
    FAIRY_TOOL_NAME: toolName
  };

  const child = spawn(runtimeExec, [entryPath], {
    cwd: workspaceRoot,
    shell: false,
    windowsHide: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal
  });

  return await new Promise<unknown>((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
      return true;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // 子进程可能已退出
      }
    }, timeoutMs);

    const handleAbort = (): void => {
      if (!settle()) return;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
      rejectPromise(toAbortError(signal));
    };
    signal?.addEventListener('abort', handleAbort, { once: true });

    const appendChunk = (chunk: string, isStdout: boolean): void => {
      if (settled || truncated) return;
      const room = SKILL_MAX_OUTPUT_CHARS - (stdout.length + stderr.length);
      if (chunk.length <= room) {
        if (isStdout) stdout += chunk;
        else stderr += chunk;
        return;
      }
      if (isStdout) stdout += chunk.slice(0, room);
      else stderr += chunk.slice(0, room);
      truncated = true;
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => appendChunk(chunk, true));
    child.stderr?.on('data', (chunk: string) => appendChunk(chunk, false));

    // 请求经 stdin 传递（避免 Windows 命令行长度上限）
    child.stdin?.on('error', () => {
      /* 子进程提前退出时 stdin 断开：交给 close/error 主路径处理 */
    });
    try {
      child.stdin?.end(JSON.stringify({ tool: toolName, input }) + '\n');
    } catch {
      /* 写入失败随 close 暴露 */
    }

    child.on('error', (error: Error) => {
      if (!settle()) return;
      rejectPromise(signal?.aborted ? toAbortError(signal) : error);
    });

    child.on('close', (code: number | null) => {
      if (!settle()) return;
      if (timedOut) {
        rejectPromise(new Error(`Skill 工具执行超时（${timeoutMs}ms），已结束进程`));
        return;
      }
      if (truncated) {
        rejectPromise(new Error(`Skill 工具输出超出 ${SKILL_MAX_OUTPUT_CHARS} 字符上限，已截断并结束进程`));
        return;
      }
      if (code !== 0 && code !== null) {
        const tail = stderrTail(stderr);
        rejectPromise(new Error(`Skill 脚本退出码 ${code}${tail ? `：${tail}` : ''}`));
        return;
      }
      let text = stdout;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 剥 BOM
      text = text.trim();
      if (text === '') {
        const tail = stderrTail(stderr);
        rejectPromise(new Error(`Skill 脚本无输出（stdout 应为单个 JSON 值）${tail ? `；stderr：${tail}` : ''}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        const tail = stderrTail(stderr);
        rejectPromise(
          new Error(`Skill 脚本 stdout 不是合法 JSON：${stderrTail(text, 120)}${tail ? `；stderr：${tail}` : ''}`)
        );
      }
    });
  });
}
