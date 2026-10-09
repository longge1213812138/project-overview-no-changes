/**
 * 接入配置与动作（DEV_PLAN §5.6，main 进程侧）。
 *
 * - 唯一接入方式：OpenAI 兼容 API（直连供应商端点，可接官方 DeepSeek API 或任意 OpenAI 兼容端点）。
 * - getChannelState() 是接入状态唯一出口：channel / api 概况（不含 apiKey 明文）。
 * - resolveActiveChannel()：聊天 / 意图 / 抽取共用的「当前可用配置 → LlmClient」解析。
 *
 * 依赖单向：channel → config / core（无环）。
 */
import { createLlmClient, LlmAuthError } from '@fairy/core'
import type {
  ApiChannelConfig,
  ApiStyle,
  ChannelActionResult,
  ChannelKind,
  ChannelState,
  LlmClient,
  TestChatResult
} from '@fairy/core'
import { loadConfig, saveConfig } from './config'

/** catch 分支取错误文案 */
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** 接入状态（channel/api 两段；api 不含 apiKey 明文） */
export function getChannelState(): ChannelState {
  const cfg = loadConfig()
  return {
    channel: cfg.channel ?? null,
    api: cfg.api
      ? {
          configured: true,
          baseUrl: cfg.api.baseUrl,
          model: cfg.api.model,
          style: cfg.api.apiStyle ?? 'chat'
        }
      : { configured: false, baseUrl: '', model: '', style: 'chat' }
  }
}

/** 接口风格归一：缺省 'chat'，非法值报错（fail-visible，不静默改写用户选择） */
function normalizeApiStyle(value: unknown): ApiStyle | { error: string } {
  if (value === undefined || value === null || value === '') return 'chat'
  if (value === 'chat' || value === 'responses') return value
  return { error: `接口风格仅支持 chat / responses：${String(value)}` }
}

/**
 * 保存 OpenAI 兼容 API 配置并启用（channel:saveApi）。
 * - baseUrl 必须可 new URL() 且协议 http/https；model 非空；
 * - apiKey 为空且从未存过 → error；为空且已存过 → 保留原 key；
 * - 保存 config {channel:'api', api:{...}}。
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
  const apiStyle = normalizeApiStyle(input.apiStyle)
  if (typeof apiStyle === 'object') return { ok: false, error: apiStyle.error }

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
    saveConfig({ ...current, channel: 'api', api: { baseUrl, apiKey: key, model, apiStyle } })
  } catch (err) {
    return { ok: false, error: `配置写入失败：${errMsg(err)}` }
  }

  return { ok: true, state: getChannelState() }
}

/** 聊天/意图/抽取共用：解析当前可用配置；capabilityKey 供阶段 7 能力探测按端点+模型缓存 */
export type ActiveChannel =
  | { ok: true; channel: ChannelKind; client: LlmClient; capabilityKey: string }
  | { ok: false; error: string }

/**
 * 解析当前可用配置并构建 LlmClient：
 * - channel=null → 引导去设置页配置；
 * - 'api' 且配置齐 → 直连供应商端点（baseUrl/apiKey/model）。
 */
export function resolveActiveChannel(): ActiveChannel {
  const cfg = loadConfig()

  if (cfg.channel !== 'api') {
    return { ok: false, error: '请先在设置页配置并启用 OpenAI 兼容 API（Base URL / API Key / 模型）' }
  }

  const api = cfg.api
  if (!api) {
    return { ok: false, error: 'OpenAI API 配置不完整，请在设置页补充' }
  }
  const apiStyle: ApiStyle = api.apiStyle ?? 'chat'
  return {
    ok: true,
    channel: 'api',
    client: createLlmClient({
      baseUrl: api.baseUrl,
      apiKey: api.apiKey,
      model: api.model,
      apiStyle
    }),
    // 探测缓存键含接口风格：同一端点两种风格的 tools 能力互不串扰
    capabilityKey: `api:${apiStyle}:${api.baseUrl}|${api.model}`
  }
}

/**
 * channel:test —— 按当前配置做一轮非流式测试对话。
 * LlmAuthError → 'API Key 无效：…'；其余错误原样回传。
 */
export async function channelTest(message: string): Promise<TestChatResult> {
  if (typeof message !== 'string' || message.trim() === '') {
    return { ok: false, error: '消息为空' }
  }
  const active = resolveActiveChannel()
  if (!active.ok) return { ok: false, error: active.error }

  try {
    const res = await active.client.chatOnce([{ role: 'user', content: message }])
    return { ok: true, content: res.content }
  } catch (err) {
    if (err instanceof LlmAuthError) {
      return { ok: false, error: `API Key 无效：${errMsg(err)}` }
    }
    return { ok: false, error: errMsg(err) }
  }
}
