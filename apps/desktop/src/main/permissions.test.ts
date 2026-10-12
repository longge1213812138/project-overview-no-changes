/**
 * 工具权限档位（ADR-0002）main 侧配置读写单测。
 *
 * mock 面：./config（内存配置，不落真实磁盘、不碰 electron）、./logger（vi.fn）——
 * 与 web.test.ts 同一套做法。关注点是「config.json 的 permissions 段怎么读怎么写」，
 * 档位语义本身在 @fairy/core 的 permissions.test.ts 里钉死。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOOL_POLICY } from '@fairy/core'
import type { FairyConfig } from './config'
import { getPermissionsConfig, getToolPolicy, saveToolPolicy } from './permissions'

const cfgState: { current: FairyConfig } = { current: {} }
/** 置为 true 时 saveConfig 抛错：覆盖「落盘失败」路径 */
const diskFail: { value: boolean } = { value: false }

vi.mock('./logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('./config', () => ({
  loadConfig: () => cfgState.current,
  saveConfig: (next: FairyConfig) => {
    if (diskFail.value) throw new Error('磁盘写入失败')
    cfgState.current = next
  }
}))

beforeEach(() => {
  cfgState.current = {}
  diskFail.value = false
})

describe('工具权限档位（main 侧读写）', () => {
  it('缺省配置 → 默认档（老配置升级后行为不变）', () => {
    expect(getToolPolicy()).toBe(DEFAULT_TOOL_POLICY)
    expect(getPermissionsConfig()).toEqual({ toolPolicy: 'default' })
  })

  it('脏配置 → 回落默认档，绝不因脏值放宽', () => {
    cfgState.current = { permissions: { toolPolicy: 'whatever' } } as unknown as FairyConfig
    expect(getToolPolicy()).toBe('default')

    cfgState.current = { permissions: 'nope' } as unknown as FairyConfig
    expect(getToolPolicy()).toBe('default')

    cfgState.current = { permissions: { toolPolicy: 'open', junk: true } } as unknown as FairyConfig
    expect(getPermissionsConfig()).toEqual({ toolPolicy: 'open' })
  })

  it('保存档位：写入 permissions.toolPolicy，其它字段原样保留', () => {
    cfgState.current = { channel: 'api', permissions: { toolPolicy: 'readonly' } }

    const res = saveToolPolicy('open')

    expect(res.ok).toBe(true)
    expect(res.config).toEqual({ toolPolicy: 'open' })
    expect(cfgState.current.permissions).toEqual({ toolPolicy: 'open' })
    expect(cfgState.current.channel).toBe('api')
    expect(getToolPolicy()).toBe('open')
  })

  it('保存非法值 → 落回默认档（第二道保险，方向是越坏越保守）', () => {
    cfgState.current = { permissions: { toolPolicy: 'open' } }

    const res = saveToolPolicy('rm -rf /')

    expect(res.ok).toBe(true)
    expect(res.config).toEqual({ toolPolicy: 'default' })
    expect(getToolPolicy()).toBe('default')
  })

  it('落盘失败 → ok:false 且错误文案可见，不抛', () => {
    cfgState.current = { permissions: { toolPolicy: 'readonly' } }
    diskFail.value = true

    const res = saveToolPolicy('open')

    expect(res.ok).toBe(false)
    expect(res.error).toContain('配置写入失败')
    expect(cfgState.current.permissions).toEqual({ toolPolicy: 'readonly' })
  })
})
