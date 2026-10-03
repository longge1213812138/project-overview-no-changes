/**
 * 阶段 7：审批 id 主权回归测试（H9 GUI 验收「第二次审批框不弹」根因钉死）。
 *
 * 缺陷回放：registry 的 confirm 负载自带 id（registry 内部 nextId 序列，每轮生成
 * 从 1 重计），requestApproval 曾用 `{ id, ...req }` 组装广播负载 → registry id 把
 * 本模块 seq id 覆盖掉：
 * - 第二条请求广播负载 id 仍是 1 → renderer 按「已处理 id」去重 → 审批框不弹；
 * - 重建窗经 getPending 拉回负载 id=1（pending 真 key 是 seq id）→ 点「允许」回传 1
 *   → respondApproval 判「忽略未知/重复」。
 * 断言核心：广播负载 id、getPending 返回 id、respond 受理 id 三者一致且单调递增，
 * 即便上游负载每次都携带 id:1。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '@fairy/core'
import type { AgentApprovalRequest } from '@fairy/core'

vi.mock('./logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('./windows', () => ({
  broadcast: vi.fn(),
  getFloatWindow: vi.fn(() => null),
  getMainWindow: vi.fn(() => null),
  releaseFloatIfBlurred: vi.fn(),
  setFloatApprovalGate: vi.fn(),
  summonForApproval: vi.fn()
}))

import {
  cancelAllPending,
  getPendingApprovals,
  requestApproval,
  respondApproval
} from './agent-approval'
import { broadcast } from './windows'

/** 模拟 registry confirm 负载：运行时真实携带 id:1（registry 每轮生成都从 1 重计） */
function registryPayload(): Omit<AgentApprovalRequest, 'id'> {
  return {
    id: 1,
    tool: {
      name: 'get_current_time',
      description: '获取当前时间',
      risk: 'read',
      source: 'builtin'
    },
    input: {},
    outside: false
  } as unknown as Omit<AgentApprovalRequest, 'id'>
}

/** 已广播的审批请求负载 id 序列 */
function sentApprovalIds(): number[] {
  return vi
    .mocked(broadcast)
    .mock.calls.filter(([channel]) => channel === IPC.agentApprovalRequest)
    .map(([, payload]) => (payload as AgentApprovalRequest).id)
}

beforeEach(() => {
  cancelAllPending('cancelled') // 清掉上一例残留的 pending（seq 无需重置，断言用相对值）
  vi.clearAllMocks()
})

describe('requestApproval 审批 id 主权（H9 根因回归）', () => {
  it('广播负载 id = 本模块 seq id，不被上游负载携带的 id 覆盖', async () => {
    const p1 = requestApproval(registryPayload(), {})
    const p2 = requestApproval(registryPayload(), {})

    const [first, second] = sentApprovalIds()
    expect(first).toBeDefined()
    // 根因下两条广播负载都是 1；seq 权威 = 单调递增、绝不重复
    expect(second).toBe(first + 1)

    // 重建窗对账（getPending）拿到与广播一致的 id——曾经返回负载 id=1 而真 key 是 2
    expect(getPendingApprovals().map((r) => r.id)).toEqual([first, second])

    // respond 按广播 id 受理（根因下 respond(second=2) 会被「忽略未知/重复」）
    expect(respondApproval(second, true)).toBe(true)
    expect(respondApproval(first, true)).toBe(true)
    await expect(p1).resolves.toBe(true)
    await expect(p2).resolves.toBe(true)
    expect(getPendingApprovals()).toEqual([])
  })

  it('重复 respond 幂等拒绝（陈旧点击不二次结算）', async () => {
    const p = requestApproval(registryPayload(), {})
    const [id] = sentApprovalIds()
    expect(respondApproval(id, true)).toBe(true)
    expect(respondApproval(id, true)).toBe(false)
    await expect(p).resolves.toBe(true)
  })

  it('60s 未决策收敛为拒绝（审批绝不悬挂）', async () => {
    vi.useFakeTimers()
    try {
      const p = requestApproval(registryPayload(), {})
      vi.advanceTimersByTime(60_000)
      await expect(p).resolves.toBe(false)
      expect(getPendingApprovals()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
