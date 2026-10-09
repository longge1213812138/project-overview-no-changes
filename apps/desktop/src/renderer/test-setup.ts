/**
 * renderer 测试公共准备。
 *
 * 只做一件事：挂 RTL 的 DOM 清理。vitest 默认不开 globals，`@testing-library/react`
 * 的自动清理不会注册；不显式挂 afterEach 的话，上一个用例的 DOM 会留在 document.body，
 * 下一个用例的查询就会命中多份（"Found multiple elements"）。
 */
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
