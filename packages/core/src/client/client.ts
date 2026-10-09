/**
 * `createFairyClient`：把 `FairyApi` 适配成 `FairyClient`（见 ADR-0001）。
 *
 * 三条规则（全部藏在 interface 之后，调用方不必知道）：
 * 1. 返回 Promise 的调用 = 一次 IPC 往返 → 归一为 `IpcResult`；
 *    同步返回值（`onChanged` / `onOpenTab` 这类订阅与退订）原样透传。
 * 2. main 侧两种失败约定都变成失败结果：resolve 出 `{ ok: false, error }`，或 reject。
 * 3. 成功且带 `{ ok: true, ... }` 外壳时剥掉外壳，只留领域字段（`IpcResult.ok` 是唯一成功信号）。
 *
 * 纯运行时、无 React / DOM / electron 依赖（node 环境可直接单测）。
 */
import type { FairyApi } from '../ipc';
import type { FairyClient, IpcPayload, IpcResult } from './types';

/** 错误转文案（throw 与 `{ ok:false, error }` 两种来源共用） */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** main 侧失败约定之二：resolve 出 `{ ok: false, error? }` */
function isFailure(value: unknown): value is { ok: false; error?: string } {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

/** 成功且带结果外壳（`{ ok: true, ... }`）：剥掉 ok 与 error，只留领域字段 */
function isSuccessShell(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true;
}

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/** 一次 IPC 调用 → 结果（绝不抛：reject 也变成 `{ ok:false }`） */
async function run<T>(call: () => Promise<T>): Promise<IpcResult<IpcPayload<T>>> {
  try {
    const value = await call();
    if (isFailure(value)) return { ok: false, error: value.error ?? '操作失败' };
    if (isSuccessShell(value)) {
      const { ok: _ok, error: _error, ...payload } = value;
      return { ok: true, value: payload as unknown as IpcPayload<T> };
    }
    return { ok: true, value: value as unknown as IpcPayload<T> };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/**
 * 建 client。传入的对象只被读取一次（方法在调用时才执行），因此可以在模块加载后
 * 才把 `window.fairy` 交给它，也可以在测试里塞替身。
 */
export function createFairyClient(api: FairyApi): FairyClient {
  const wrap = (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]): unknown => {
      const out = fn(...args);
      return isThenable(out) ? run(() => out) : out;
    };

  const wrapDomain = (domain: object): object => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(domain)) {
      out[key] = typeof value === 'function' ? wrap(value as (...args: unknown[]) => unknown) : value;
    }
    return out;
  };

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(api as unknown as Record<string, unknown>)) {
    if (typeof value === 'function') out[key] = wrap(value as (...args: unknown[]) => unknown);
    else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = wrapDomain(value);
    } else out[key] = value;
  }
  return out as unknown as FairyClient;
}
