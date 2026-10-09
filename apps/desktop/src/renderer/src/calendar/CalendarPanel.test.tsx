/**
 * 日程面板单测（jsdom）：面板经 Fairy client 取数与写操作，因此这里用替身 `FairyApi`
 * 过一遍真的 `createFairyClient`，再把它传给面板——测的是面板与 client 的接缝，
 * 不 mock preload，也不 mock ipcRenderer。
 *
 * 覆盖：列表渲染、勾选完成、新增（成功/本地校验拦截）、删除（二次确认）、写失败可见。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFairyClient } from '@fairy/core'
import type { EventRecord, FairyApi } from '@fairy/core'
import CalendarPanel from './CalendarPanel'

function record(over: Partial<EventRecord> & { id: number; title: string }): EventRecord {
  return {
    notes: null,
    remindAt: Date.now() + 3_600_000,
    done: false,
    fired: false,
    createdAt: Date.now(),
    ...over
  }
}

/** 替身 API：内存列表 + 调用记录；`fail` 可让下一次写操作抛错 */
function fakeApi(initial: EventRecord[]) {
  const calls: string[] = []
  let list = [...initial]
  let failNext: string | null = null

  const api = {
    events: {
      list: async () => [...list],
      add: async (input: { title: string; remindAt: number; notes?: string }) => {
        if (failNext === 'add') throw new Error('写入失败')
        calls.push(`add:${input.title}`)
        const rec = record({ id: 100 + list.length, title: input.title })
        list = [...list, rec]
        return rec
      },
      complete: async (id: number, done: boolean) => {
        calls.push(`complete:${id}:${done}`)
        list = list.map((r) => (r.id === id ? { ...r, done } : r))
      },
      remove: async (id: number) => {
        if (failNext === 'remove') throw new Error('删除失败')
        calls.push(`remove:${id}`)
        list = list.filter((r) => r.id !== id)
      },
      onChanged: () => () => undefined
    }
  } as unknown as FairyApi

  return {
    client: createFairyClient(api),
    calls,
    failWith: (op: string) => {
      failNext = op
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CalendarPanel', () => {
  it('渲染列表：标题与相对时间可见', async () => {
    const { client } = fakeApi([record({ id: 1, title: '交周报' })])

    render(<CalendarPanel client={client} />)

    expect(await screen.findByText('交周报')).toBeTruthy()
    // 「今天」既是 scope 按钮文案，也是行内相对时间标签 → 按选择器取行内那个
    expect(screen.getByText('今天', { selector: '.cal-time-rel' })).toBeTruthy()
  })

  it('勾选 → complete(id, true)，列表随之刷新', async () => {
    const { client, calls } = fakeApi([record({ id: 7, title: '交周报' })])

    render(<CalendarPanel client={client} />)
    const box = (await screen.findByTitle('标记完成')) as HTMLInputElement
    fireEvent.click(box)

    await waitFor(() => expect(calls).toContain('complete:7:true'))
    await waitFor(() => expect(screen.getByText('已完成')).toBeTruthy())
  })

  it('新增：提交后调用 add、表单清空、列表出现新日程', async () => {
    const { client, calls } = fakeApi([])

    render(<CalendarPanel client={client} />)
    const input = (await screen.findByPlaceholderText('标题，如：交周报')) as HTMLInputElement
    fireEvent.change(input, { target: { value: '买牛奶' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    await waitFor(() => expect(calls).toContain('add:买牛奶'))
    await waitFor(() => expect(screen.getByText('买牛奶')).toBeTruthy())
    expect(input.value).toBe('')
  })

  it('本地校验拦截：标题为空 → 红条提示，且不调用 add', async () => {
    const { client, calls } = fakeApi([])

    render(<CalendarPanel client={client} />)
    await screen.findByPlaceholderText('标题，如：交周报')
    fireEvent.click(screen.getByRole('button', { name: '添加' }))

    expect(await screen.findByText('请填写标题')).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('删除：二次确认通过后调用 remove，行消失', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { client, calls } = fakeApi([record({ id: 9, title: '买牛奶' })])

    render(<CalendarPanel client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))

    await waitFor(() => expect(calls).toContain('remove:9'))
    await waitFor(() => expect(screen.queryByText('买牛奶')).toBeNull())
    expect(confirmSpy).toHaveBeenCalled()
  })

  it('二次确认取消 → 不调用 remove', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { client, calls } = fakeApi([record({ id: 9, title: '买牛奶' })])

    render(<CalendarPanel client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))

    expect(calls).toEqual([])
  })

  it('写失败 → client 归一为失败结果，面板显示红条', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { client, failWith } = fakeApi([record({ id: 9, title: '买牛奶' })])
    failWith('remove')

    render(<CalendarPanel client={client} />)
    fireEvent.click(await screen.findByRole('button', { name: '删除' }))

    expect(await screen.findByText('删除失败')).toBeTruthy()
    expect(confirmSpy).toHaveBeenCalled()
  })
})
