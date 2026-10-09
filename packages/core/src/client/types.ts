/**
 * Fairy client 的 contract（渲染层访问 main 的唯一通道，见 ADR-0001）。
 *
 * 接口不手写方法清单：由 `FairyApi` 的类型映射派生。契约新增方法时本文件无需改动。
 * 纯类型、无运行时代码、无 React / DOM / electron 依赖。
 */
import type { FairyApi } from '../ipc';

/** 一次 IPC 调用的结果：成功带领域载荷，失败带一句可见文案。client 不抛异常。 */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** 一次 Action 之后用户能看到的结论（GLOSSARY.md: Feedback） */
export interface Feedback {
  kind: 'ok' | 'err';
  text: string;
}

/** 成功载荷：把 main 侧 `{ ok: true, error? }` 的结果外壳剥掉，只留领域字段 */
export type IpcPayload<R> = R extends { ok: boolean } ? Omit<R, 'ok' | 'error'> : R;

/** 一个异步方法 → 返回 IpcResult 的方法；非异步方法（订阅/退订）保持原样 */
type WrapMethod<M> = M extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => Promise<IpcResult<IpcPayload<R>>>
  : M;

/** 契约里的一个域（channel / events / chat / cron …） */
type WrapDomain<D> = { [K in keyof D]: WrapMethod<D[K]> };

/** 渲染层看到的接口：与 `FairyApi` 同形，异步方法一律返回 `IpcResult` */
export type FairyClient = {
  [K in keyof FairyApi]: FairyApi[K] extends (...args: never[]) => unknown
    ? WrapMethod<FairyApi[K]>
    : WrapDomain<FairyApi[K]>;
};
