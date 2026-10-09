/**
 * Fairy client 单测（node 环境，无 React / DOM / electron）。
 *
 * 钉死 interface 承诺的四件事：main 侧两种失败约定都变成失败结果、成功透传、
 * 成功结果外壳被剥掉、同步订阅原样透传。
 */
import { describe, expect, it, vi } from 'vitest';
import type { FairyApi } from '../ipc';
import { createFairyClient } from './client';

function fakeApi() {
  const onChanged = vi.fn((_cb: () => void) => () => undefined);
  const api = {
    events: {
      list: vi.fn(async () => [{ id: 1, title: '交周报' }]),
      complete: vi.fn(async () => undefined),
      remove: vi.fn(async () => {
        throw new Error('磁盘满');
      }),
      onChanged
    },
    chat: { send: vi.fn(async () => ({ ok: false, error: '正在生成回复…' })) },
    cron: { setEnabled: vi.fn(async () => ({ ok: true, task: { id: 't1' } })) }
  } as unknown as FairyApi;
  return { api, onChanged };
}

describe('createFairyClient：结果归一', () => {
  it('成功 → { ok:true, value }，入参原样透传', async () => {
    const { api } = fakeApi();
    const client = createFairyClient(api);

    const r = await client.events.list({ scope: 'today' });

    expect(r).toEqual({ ok: true, value: [{ id: 1, title: '交周报' }] });
    expect(api.events.list).toHaveBeenCalledWith({ scope: 'today' });
  });

  it('void 结果 → { ok:true, value: undefined }', async () => {
    const { api } = fakeApi();
    const client = createFairyClient(api);

    const r = await client.events.complete(7, true);

    expect(r).toEqual({ ok: true, value: undefined });
    expect(api.events.complete).toHaveBeenCalledWith(7, true);
  });

  it('resolve 出 { ok:false, error } → 失败结果（main 约定之一）', async () => {
    const { api } = fakeApi();
    const client = createFairyClient(api);

    const r = await client.chat.send('s1', '你好');

    expect(r).toEqual({ ok: false, error: '正在生成回复…' });
  });

  it('reject → 失败结果，绝不抛（main 约定之二）', async () => {
    const { api } = fakeApi();
    const client = createFairyClient(api);

    await expect(client.events.remove(3)).resolves.toEqual({ ok: false, error: '磁盘满' });
  });

  it('成功且带 { ok:true, ... } 外壳 → 剥掉外壳，只留领域字段', async () => {
    const { api } = fakeApi();
    const client = createFairyClient(api);

    const r = await client.cron.setEnabled('t1', false);

    expect(r).toEqual({ ok: true, value: { task: { id: 't1' } } });
    if (r.ok) expect('ok' in (r.value as object)).toBe(false);
  });

  it('同步订阅（onChanged）原样透传，不被包成 Promise', () => {
    const { api, onChanged } = fakeApi();
    const client = createFairyClient(api);
    const cb = () => undefined;

    const unsubscribe = client.events.onChanged(cb);

    expect(onChanged).toHaveBeenCalledWith(cb);
    expect(unsubscribe).toBeInstanceOf(Function);
  });
});
