/**
 * 通道选择与动作（DEV_PLAN §5.6，main 进程侧）。
 *
 * - 双通道：OpenAI 兼容 API（直连供应商端点，可接官方 DeepSeek API 或任意 OpenAI 兼容端点）/
 *   DeepSeek 网页（经本地 ds-free-api 网关）。
 * - **启动不自动登录（§5.6.1）**：网页通道每次启动 Fairy 后需用户显式「启动网关」才 spawn+登录；
 *   切 api 自动停掉运行中的网关（§5.6.3）。
 * - getChannelState() 是通道状态唯一出口：channel / api 概况（不含 apiKey 明文）/ web 网关状态。
 * - resolveActiveChannel()：聊天 / 意图 / 抽取共用的「当前可用通道 → LlmClient」解析。
 *
 * 依赖单向：channel → sidecar / config / core（sidecar 不回 import channel，无环）。
 */
import { createLlmClient, LlmAuthError, SessionExpiredError } from '@fairy/core'
import type {
  ApiChannelConfig,
  ChannelActionResult,
  ChannelKind,
  ChannelState,
  LlmClient,
  TestChatResult
} from '@fairy/core'
import { loadConfig, saveConfig } from './config'
import {
  getGatewayState,
  reportSessionExpired,
  reportSessionOk,
  startGateway,
  stopGateway
} from './sidecar'

/** catch 分支取错误文案 */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 通道状态（channel/api/web 三段；api 不含 apiKey 明文，web 不回显账号明文） */
export function getChannelState(): ChannelState {
  const cfg = loadConfig()
  return {
    channel: cfg.channel ?? null,
    api: cfg.api
      ? { configured: true, baseUrl: cfg.api.baseUrl, model: cfg.api.model }
      : { configured: false, baseUrl: '', model: '' },
    web: {
      accountConfigured: cfg.account !== undefined,
      gateway: getGatewayState()
    }
  }
}

/**
 * 保存 OpenAI 兼容 API 配置并切到 api 通道（channel:saveApi）。
 * - baseUrl 必须可 new URL() 且协议 http/https；model 非空；
 * - apiKey 为空且从未存过 → error；为空且已存过 → 保留原 key；
 * - 保存 config {channel:'api', api:{...}} → 网关在运行则 stopGateway()（切 api 必停网关，§5.6.3）。
 */
export async function saveApi(cfg: ApiChannelConfig): Promise<ChannelActionResult> {
  const input = (cfg ?? {}) as unknown as Record<string, unknown>
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : ''
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  const model = typeof input.model === 'string' ? input.model.trim() : ''

  if (baseUrl === '') return { ok: false, error: 'baseUrl 不能为空' }
  let protocol = ''
  try {
    protocol = new URL(baseUrl).protocol
  } catch {
    return { ok: false, error: `baseUrl 无法解析：${baseUrl}` }
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, error: `baseUrl 仅支持 http/https：${baseUrl}` }
  }
  if (model === '') return { ok: false, error: 'model 不能为空' }

  const current = loadConfig()
  let key = apiKey
  if (key === '') {
    // 留空 = 保持已存 key；从未存过 → 必填
    if (current.api?.apiKey) {
      key = current.api.apiKey
    } else {
      return { ok: false, error: '请填写 API Key（首次配置必填；已保存过可留空保持原 Key）' }
    }
  }

  try {
    saveConfig({ ...current, channel: 'api', api: { baseUrl, apiKey: key, model } })
  } catch (err) {
    return { ok: false, error: `配置写入失败：${errMsg(err)}` }
  }

  await stopGateway() // 切 api 必停网关（避免后台登录）；stopGateway 幂等
  return { ok: true, state: getChannelState() }
}

/**
 * 选择通道（channel:select）。
 * - 'api'：要求 api 已 configured（否则 '请先填写 OpenAI API 配置'）；置 channel 并停运行中的网关；
 * - 'web'：置 channel='web'，**不启动**网关（每次启动 Fairy 需手动点「启动网关」）。
 */
export async function selectChannel(ch: ChannelKind): Promise<ChannelActionResult> {
  const cfg = loadConfig()
  if (ch === 'api') {
    if (!cfg.api) return { ok: false, error: '请先填写 OpenAI API 配置' }
    try {
      saveConfig({ ...cfg, channel: 'api' })
    } catch (err) {
      return { ok: false, error: `配置写入失败：${errMsg(err)}` }
    }
    await stopGateway() // 切 api 必停运行中的网关；幂等
    return { ok: true, state: getChannelState() }
  }
  if (ch === 'web') {
    try {
      saveConfig({ ...cfg, channel: 'web' })
    } catch (err) {
      return { ok: false, error: `配置写入失败：${errMsg(err)}` }
    }
    return { ok: true, state: getChannelState() } // 不自动启动网关
  }
  return { ok: false, error: '通道参数非法（仅支持 api / web）' }
}

/** channel:start —— 显式启动网页网关（DeepSeek 登录只发生在这一步） */
export async function startGatewayAction(): Promise<ChannelActionResult> {
  const result = await startGateway()
  return result.ok
    ? { ok: true, state: getChannelState() }
    : { ok: false, error: result.error, state: getChannelState() }
}

/** channel:stop —— 停止网页网关（不影响 api 通道） */
export async function stopGatewayAction(): Promise<ChannelState> {
  await stopGateway()
  return getChannelState()
}

/** 聊天/意图/抽取共用：解析当前可用通道 */
export type ActiveChannel =
  | { ok: true; channel: ChannelKind; client: LlmClient }
  | { ok: false; error: string }

/**
 * 解析当前可用通道并构建 LlmClient：
 * - channel=null → 引导去设置页选择；
 * - 'api' 且配置齐 → 直连供应商端点（baseUrl/apiKey/model）；
 * - 'web' 且网关 ready + port → 本地网关（model 走默认 'default'，见 llm-bridge-notes §3）。
 */
export function resolveActiveChannel(): ActiveChannel {
  const cfg = loadConfig()
  const channel = cfg.channel ?? null

  if (channel === null) {
    return { ok: false, error: '请先在设置页选择接入方式（OpenAI API 或 DeepSeek 网页）' }
  }

  if (channel === 'api') {
    const api = cfg.api
    if (!api) {
      return { ok: false, error: 'OpenAI API 配置不完整，请在设置页补充' }
    }
    return {
      ok: true,
      channel: 'api',
      client: createLlmClient({ baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model })
    }
  }

  // web：网关 ready 才可用
  const gw = getGatewayState()
  if (gw.status === 'ready' && gw.port !== null) {
    return {
      ok: true,
      channel: 'web',
      client: createLlmClient({ baseUrl: `http://127.0.0.1:${gw.port}`, apiKey: cfg.apiKey })
    }
  }
  return { ok: false, error: 'DeepSeek 网页网关未启动，请在设置页启动' }
}

/**
 * channel:test —— 按当前通道做一轮非流式测试对话（替代旧 gateway:testChat）。
 * 错误映射沿用旧 testChat：SessionExpiredError → expired + reportSessionExpired；
 * LlmAuthError → 'API Key 无效：…'；成功 → reportSessionOk。
 */
export async function channelTest(message: string): Promise<TestChatResult> {
  if (typeof message !== 'string' || message.trim() === '') {
    return { ok: false, error: '消息为空' }
  }
  const active = resolveActiveChannel()
  if (!active.ok) return { ok: false, error: active.error }

  try {
    const res = await active.client.chatOnce([{ role: 'user', content: message }])
    reportSessionOk() // 测试成功 → 清过期标记
    return { ok: true, content: res.content }
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      // 过期指纹仅网页通道生效（§5.6.4）；API 通道的 429 走常规退避，不触发托盘红
      if (active.channel === 'web') reportSessionExpired()
      return {
        ok: false,
        expired: active.channel === 'web',
        error:
          active.channel === 'web'
            ? '会话已过期（持续 429 overloaded），请重新保存账号配置'
            : errMsg(err)
      }
    }
    if (err instanceof LlmAuthError) {
      return { ok: false, error: `API Key 无效：${errMsg(err)}` }
    }
    return { ok: false, error: errMsg(err) }
  }
}
