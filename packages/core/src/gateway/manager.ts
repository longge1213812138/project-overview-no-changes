import {
  execFile,
  spawn,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams
} from 'node:child_process';
import type { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AccountStatus, GatewayAccountConfig } from '../ipc';
import { buildGatewayToml, pickFreePort } from './config';
import { parseGatewayLine } from './log-parser';

export type { GatewayAccountConfig };

export interface GatewayManagerOptions {
  /** ds-free-api 可执行文件路径 */
  binPath: string;
  /** config.toml 完整路径（由 manager 负责写入） */
  configPath: string;
  /** 作为 DS_DATA_DIR 传给子进程 */
  dataDir: string;
  apiKey: string;
  account?: GatewayAccountConfig | null;
  /** 省略则每次 start 取空闲端口 */
  port?: number;
  readyTimeoutMs?: number;
}

export interface GatewaySnapshot {
  status: 'stopped' | 'starting' | 'ready' | 'error';
  port: number | null;
  accountStatus: 'none' | 'logging_in' | 'logged_in' | 'login_failed' | 'unknown';
  accountDetail: string | null;
  lastError: string | null;
}

export interface GatewayManager {
  /** 总是 resolve（运行期失败 → status:'error'）；仅参数/文件系统异常 reject */
  start(): Promise<GatewaySnapshot>;
  stop(): Promise<void>;
  restart(): Promise<GatewaySnapshot>;
  reconfigure(patch: {
    account?: GatewayAccountConfig | null;
    apiKey?: string;
    binPath?: string;
  }): Promise<GatewaySnapshot>;
  getSnapshot(): GatewaySnapshot;
  /** 状态变化回调，返回退订函数 */
  onState(cb: (s: GatewaySnapshot) => void): () => void;
}

const READY_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 1_500;
const STOP_TIMEOUT_MS = 3_000;
const LOG_TAIL_LINES = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** stdio: ignore/piped/piped（不用 ChildProcessWithoutNullStreams，stdin 被 ignore） */
type Spawned = ChildProcessByStdio<null, Readable, Readable>;

export function createGatewayManager(opts: GatewayManagerOptions): GatewayManager {
  let binPath = opts.binPath;
  let apiKey = opts.apiKey;
  let account: GatewayAccountConfig | null = opts.account ?? null;
  const explicitPort = opts.port ?? null;
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;

  let port: number | null = null;
  let status: GatewaySnapshot['status'] = 'stopped';
  let accountStatus: GatewaySnapshot['accountStatus'] = account ? 'unknown' : 'none';
  let accountDetail: string | null = null;
  let lastError: string | null = null;

  let child: Spawned | null = null;
  let stopping = false;
  const logTail: string[] = [];

  const listeners = new Set<(s: GatewaySnapshot) => void>();
  let lastEmitted: string | null = null;

  function snap(): GatewaySnapshot {
    return { status, port, accountStatus, accountDetail, lastError };
  }

  function emit(force = false): void {
    const s = snap();
    const key = JSON.stringify(s);
    if (!force && key === lastEmitted) return;
    lastEmitted = key;
    for (const cb of listeners) {
      try {
        cb(s);
      } catch {
        // 监听器异常不影响管理器
      }
    }
  }

  function setStatus(next: GatewaySnapshot['status'], error: string | null = null): void {
    status = next;
    lastError = error;
    emit();
  }

  function handleLogLine(line: string): void {
    const r = parseGatewayLine(line);
    if (!r) return;
    // 初始化期间的"池无可用账号"是暂态，不覆盖 logging_in（最终由初始化结果定音）
    if (r.accountDetail === '账号池无可用账号' && accountStatus === 'logging_in') return;
    if (accountStatus !== r.accountStatus || accountDetail !== r.accountDetail) {
      accountStatus = r.accountStatus;
      accountDetail = r.accountDetail;
      emit();
    }
  }

  function attachLineReader(stream: Readable): void {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          logTail.push(line);
          if (logTail.length > LOG_TAIL_LINES) logTail.shift();
          handleLogLine(line);
        }
      }
    });
  }

  async function healthOk(): Promise<boolean> {
    if (port === null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { status?: string };
      return body.status === 'ok';
    } catch {
      return false;
    }
  }

  async function killTree(c: Spawned): Promise<void> {
    if (c.exitCode !== null || c.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => c.once('exit', () => resolve()));
    if (process.platform === 'win32' && c.pid) {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/pid', String(c.pid), '/T', '/F'], () => resolve());
      });
    } else {
      c.kill('SIGTERM');
      const t = setTimeout(() => c.kill('SIGKILL'), STOP_TIMEOUT_MS);
      t.unref?.();
    }
    await Promise.race([exited, sleep(STOP_TIMEOUT_MS)]);
  }

  async function start(): Promise<GatewaySnapshot> {
    if (status === 'starting' || status === 'ready') return snap();

    // 参数/文件系统异常 → reject
    await fs.mkdir(path.dirname(opts.configPath), { recursive: true });
    await fs.mkdir(opts.dataDir, { recursive: true });
    port = explicitPort ?? (await pickFreePort());
    await fs.writeFile(
      opts.configPath,
      buildGatewayToml({ port, apiKey, account }),
      'utf8'
    );

    logTail.length = 0;
    stopping = false;
    accountStatus = account ? 'logging_in' : 'none';
    accountDetail = null;
    setStatus('starting');

    let c: Spawned;
    try {
      c = spawn(binPath, ['-c', opts.configPath], {
        cwd: path.dirname(opts.configPath),
        env: { ...process.env, DS_DATA_DIR: opts.dataDir },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      setStatus('error', `spawn 失败：${errMsg(e)}`);
      return snap();
    }
    child = c;

    c.once('error', (err) => {
      if (child === c) {
        child = null;
        setStatus('error', `spawn 失败：${err.message}`);
      }
    });
    c.once('exit', (code, sig) => {
      if (child !== c) return;
      child = null;
      if (stopping || status === 'stopped') return;
      const tail = logTail.slice(-3).join(' | ');
      setStatus('error', `进程退出 code=${code} signal=${sig}${tail ? `；末尾日志：${tail}` : ''}`);
    });
    attachLineReader(c.stdout);
    attachLineReader(c.stderr);

    // health 轮询
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (status === 'error') return snap(); // spawn 已失败
      if (await healthOk()) {
        setStatus('ready');
        return snap();
      }
      await sleep(HEALTH_INTERVAL_MS);
    }
    // 超时：回收进程
    stopping = true;
    if (child) await killTree(child);
    child = null;
    stopping = false;
    setStatus('error', `网关启动超时（${readyTimeoutMs}ms 内 /health 未就绪）`);
    return snap();
  }

  async function stop(): Promise<void> {
    const c = child;
    stopping = true;
    try {
      if (c) await killTree(c);
    } finally {
      if (child === c) child = null;
      stopping = false;
      port = null;
      setStatus('stopped');
    }
  }

  async function restart(): Promise<GatewaySnapshot> {
    await stop();
    return start();
  }

  async function reconfigure(patch: {
    account?: GatewayAccountConfig | null;
    apiKey?: string;
    binPath?: string;
  }): Promise<GatewaySnapshot> {
    if (patch.binPath !== undefined) binPath = patch.binPath;
    if (patch.apiKey !== undefined) apiKey = patch.apiKey;
    if (patch.account !== undefined) account = patch.account;

    if (!account) {
      // 清空账号：停掉且不再自动启动
      await stop();
      accountStatus = 'none';
      accountDetail = null;
      emit();
      return snap();
    }
    if (child || status === 'starting' || status === 'ready' || status === 'error') {
      return restart();
    }
    return start();
  }

  function getSnapshot(): GatewaySnapshot {
    return snap();
  }

  function onState(cb: (s: GatewaySnapshot) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  return { start, stop, restart, reconfigure, getSnapshot, onState };
}
