/**
 * LLM 网关 sidecar 生命周期管理（DEV_PLAN §6 阶段 2 + §5.6 通道选择）。
 *
 * - **启动不自启（§5.6 硬规则）**：initSidecar() 只建目录——不创建 manager、不 spawn、不登录；
 *   网关仅在用户于设置页显式「启动网关」（channel:start → startGatewayAction → startGateway）时拉起，
 *   每次启动 Fairy 均需手动点一次（§5.6.2）。
 * - 用 @fairy/core 的 createGatewayManager 托管 ds-free-api 子进程；
 *   configPath = <userData>/gateway/config.toml，dataDir = <userData>/gateway-data。
 * - getGatewayState() 是唯一状态出口（snapshot → GatewayState 映射 + 派生规则），
 *   ipc.ts / channel.ts / 托盘都从这里取数。
 * - 状态变化通过 onGatewayStateChanged 注入的监听器广播（由 ipc.ts 注册，
 *   避免 ipc.ts ↔ sidecar.ts 循环 import）；manager 出现后经 onState 转发。
 * - 依赖单向：sidecar → config / core（不 import channel / chat，无环）。
 */
import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createGatewayManager } from '@fairy/core'
import type {
  ConfigureResult,
  GatewayAccountConfig,
  GatewayManager,
  GatewaySnapshot,
  GatewayState,
} from '@fairy/core'
import { loadConfig, saveConfig } from './config'

let manager: GatewayManager | null = null
/** manager.onState 退订函数（换 manager 时先退订，防双监听） */
let unsubscribeManager: (() => void) | null = null
let inited = false
/** channel.test / 聊天命中会话过期指纹（持续 429 overloaded）置 true；configure 成功 / 任一成功调用清 false */
let lastTestExpired = false

type StateListener = (state: GatewayState) => void
let stateListener: StateListener | null = null

/** catch 分支取错误文案（避免依赖并行导出的错误类收窄） */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** ipc.ts 在启动时注册（300ms 去抖广播 + setTrayState）；返回退订函数 */
export function onGatewayStateChanged(cb: StateListener): () => void {
  stateListener = cb
  return () => {
    if (stateListener === cb) stateListener = null
  }
}

function emitState(): void {
  stateListener?.(getGatewayState())
}

/**
 * 会话过期标记的两个公开入口（聊天流水与 channel.test 共用，语义一致）：
 * - reportSessionExpired：聊天命中 SessionExpiredError / channelTest 命中过期指纹 → 置 true 并 emit
 * - reportSessionOk：configure 成功 / 任一成功调用 → 清 false 并 emit
 * emit 后由 ipc.ts 注册的监听器去抖广播 gateway:state + setTrayState（托盘红联动）。
 * （派生规则仅网页通道有值——API 通道不经过网关，见 getGatewayState。）
 */
export function reportSessionExpired(): void {
  lastTestExpired = true
  emitState()
}

export function reportSessionOk(): void {
  lastTestExpired = false
  emitState()
}

/**
 * whenReady 调用。幂等。
 * §5.6.1：只做目录创建——**不创建 manager、不 spawn 网关、不发生任何 DeepSeek 登录**；
 * onStateChanged 监听注册机制保留（manager 由 startGateway 出现后绑定转发）。
 */
export function initSidecar(): void {
  if (inited) return
  inited = true
  const userData = app.getPath('userData')
  mkdirSync(join(userData, 'gateway'), { recursive: true })
  mkdirSync(join(userData, 'gateway-data'), { recursive: true })
}

/** 网关是否在运行（starting/ready = 子进程存活；stopped/error = 未运行） */
function isRunning(): boolean {
  const status = manager?.getSnapshot().status
  return status === 'starting' || status === 'ready'
}

/**
 * 显式启动网关（§5.6.2 网页通道：「启动网关」按钮 → spawn + 登录）。
 * - 前置：网关二进制存在（否则 '未找到网关二进制'）、账号已配置（否则 '请先完成 DeepSeek 账号配置'）；
 * - 旧 manager 若存在先 stop() 并退订（防双监听/双进程），再按当前配置构建全新 manager；
 * - await manager.start() → 按 snapshot 返回 ok（status ready）或 error（lastError/accountDetail 摘要）。
 */
export async function startGateway(): Promise<{ ok: boolean; error?: string }> {
  const cfg = loadConfig()
  const binPath = cfg.gatewayBin ?? ''
  if (binPath === '' || !existsSync(binPath)) {
    return { ok: false, error: '未找到网关二进制' }
  }
  if (!cfg.account) {
    return { ok: false, error: '请先完成 DeepSeek 账号配置' }
  }

  // 旧 manager 先退订 + 停止（防双监听/双进程）
  unsubscribeManager?.()
  unsubscribeManager = null
  const old = manager
  manager = null
  if (old) {
    try {
      await old.stop()
    } catch (err) {
      console.warn('[sidecar] 旧网关停止异常，继续启动：', errMsg(err))
    }
  }

  const userData = app.getPath('userData')
  const next = createGatewayManager({
    binPath,
    configPath: join(userData, 'gateway', 'config.toml'),
    dataDir: join(userData, 'gateway-data'),
    apiKey: cfg.apiKey,
    account: cfg.account ?? null,
  })
  manager = next
  unsubscribeManager = next.onState(() => emitState())

  try {
    const snap = await next.start()
    emitState()
    if (snap.status === 'ready') return { ok: true }
    return { ok: false, error: snap.lastError ?? snap.accountDetail ?? '网关启动失败' }
  } catch (err) {
    emitState()
    return { ok: false, error: `网关启动失败：${errMsg(err)}` }
  }
}

/** 显式停止网关（幂等；manager 未建/未跑也安全）。停止后不删 manager（configure 热重启判活用 isRunning） */
export async function stopGateway(): Promise<void> {
  try {
    await manager?.stop()
  } finally {
    emitState()
  }
}

/**
 * snapshot → GatewayState（ipc / channel / 托盘的唯一取数口）。
 * `configured` 来自 config.json 是否有 account；
 * manager 未建/未跑时返回 {status:'stopped', port:null, accountStatus:'none'|沿用 snapshot, ...}；
 * 派生规则集中在本函数（注释）：lastTestExpired 且网关仍认为 logged_in
 * （会话过期只在请求时暴露）→ 降级 login_failed，驱动托盘红 + 引导卡（仅网页通道会有值）。
 */
export function getGatewayState(): GatewayState {
  const snap: GatewaySnapshot = manager?.getSnapshot() ?? {
    status: 'stopped',
    port: null,
    accountStatus: 'none',
    accountDetail: null,
    lastError: null,
  }
  const configured = loadConfig().account !== undefined

  const state: GatewayState = {
    status: snap.status,
    port: snap.port,
    configured,
    accountStatus: snap.accountStatus,
    accountDetail: snap.accountDetail,
    lastError: snap.lastError,
  }

  if (lastTestExpired && snap.accountStatus === 'logged_in') {
    state.accountStatus = 'login_failed'
    state.accountDetail = '会话过期（持续 429 overloaded），请重新保存账号配置'
  }
  return state
}

/**
 * gateway:configure 的实现：校验 + 保存 config.json →
 * **网关运行中（isRunning）→ manager.reconfigure({ account }) 热重启应用新配置；
 * 未运行则仅保存，绝不启动**（§5.6.3：登录只发生在用户显式「启动网关」）。
 * 返回的 ConfigureResult.state 照旧 getGatewayState()。
 * deviceId 为空不阻断，但提示 RISK_DEVICE_DETECTED 风险。
 */
export async function configureGateway(input: GatewayAccountConfig): Promise<ConfigureResult> {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.account !== 'string' ||
    input.account.trim() === '' ||
    typeof input.password !== 'string' ||
    input.password === ''
  ) {
    return { ok: false, error: '账号和密码必填' }
  }

  const cfg = loadConfig()
  const account: GatewayAccountConfig = {
    account: input.account.trim(),
    password: input.password,
  }
  if (typeof input.deviceId === 'string' && input.deviceId.trim() !== '') {
    account.deviceId = input.deviceId.trim()
  }

  try {
    saveConfig({ ...cfg, account })
  } catch (err) {
    return {
      ok: false,
      error: `配置写入失败：${errMsg(err)}`,
    }
  }

  reportSessionOk() // configure 成功 → 清过期标记并刷新状态

  try {
    if (manager && isRunning()) {
      // 运行中改账号 → 热重启应用（§5.6.3）；未运行仅上面的保存，不启动
      await manager.reconfigure({ account })
    }
    const state = getGatewayState()
    if (!account.deviceId) {
      // 风险提示（不阻断）：缺 device_id 可能触发 RISK_DEVICE_DETECTED 风控
      state.accountDetail = '未提供 device_id：登录可能被风控拦截（RISK_DEVICE_DETECTED），建议补充'
    }
    return { ok: true, state }
  } catch (err) {
    const state = getGatewayState()
    return {
      ok: false,
      error: state.lastError ?? state.accountDetail ?? String(err),
      state,
    }
  }
}

let stopping = false

/** 退出时调用：manager.stop() 幂等 + 3s 兜底超时（卡死的网关不阻塞 app.exit） */
export async function shutdownSidecar(): Promise<void> {
  if (!manager || stopping) return
  stopping = true
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      console.warn('[sidecar] 网关停止超时（3s），强制退出')
      resolve()
    }, 3000)
    t.unref?.()
  })
  try {
    await Promise.race([manager.stop(), timeout])
  } catch (err) {
    console.warn('[sidecar] stop 异常，继续退出:', errMsg(err))
  }
}
