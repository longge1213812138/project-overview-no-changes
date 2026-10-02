import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ApiChannelConfig,
  ChannelKind,
  ChannelState,
  ConfigureResult,
  GatewayAccountConfig,
  GatewayState,
  TestChatResult
} from '@fairy/core'

/** 设备指纹取法（docs/llm-bridge-notes.md §1）：Chrome F12 Console 执行后自动复制输出 */
const FINGERPRINT_CMD = 'copy(SMSdk.getDeviceId())'
const DEEPSEEK_URL = 'https://chat.deepseek.com'

type Feedback = { kind: 'ok' | 'err'; text: string }
type ExpandPanel = 'api' | 'web' | null

/**
 * 设置页 = 双通道选择入口（docs/DEV_PLAN.md §5.6 通道选择 + §5.5 网页引导流）。
 *
 * 界面结构：
 * - 顶部固定「当前通道」状态条（null 黄 / api 绿 / web 按网关状态三色）；
 * - A. channel===null → 双通道选择卡（OpenAI 兼容 API / DeepSeek 网页）；
 * - B. API 配置表单（channel==='api' 或选择卡展开后）；
 * - C. 网页引导流（channel==='web'）：四步引导 + 网关控制区；
 * - D. 测试对话（两种通道下都显示）。
 *
 * 状态来源（契约见 packages/core/src/ipc.ts，注意 gateway.testChat 已移除，测试对话走 channel.test）：
 * - 挂载时 channel.get()；onGatewayState 事件 → 重新 channel.get()；每个 action 返回的 state 直接采用。
 * - 硬规则（§5.6.1）：启动不自动登录 —— DeepSeek 登录只发生在显式点击「启动网关」（channel.startGateway）。
 */
export default function SettingsTab() {
  const [state, setState] = useState<ChannelState | null>(null)
  /** channel===null 时选择卡展开的面板（api 表单 / web 引导） */
  const [expanded, setExpanded] = useState<ExpandPanel>(null)
  /** 通道切换 / 网关启停等 action 的全局红/绿条 */
  const [banner, setBanner] = useState<Feedback | null>(null)

  // ===== B. API 配置表单 =====
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [savingApi, setSavingApi] = useState(false)
  const [apiMsg, setApiMsg] = useState<Feedback | null>(null)
  const apiPrefilled = useRef(false)

  // ===== 通道切换（select） =====
  const [switching, setSwitching] = useState<ChannelKind | null>(null)

  // ===== C. 网关控制 =====
  const [gwBusy, setGwBusy] = useState<'start' | 'stop' | null>(null)

  // ===== C. 账号表单（§5.5 步骤三） =====
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [savingAccount, setSavingAccount] = useState(false)
  const [cfgResult, setCfgResult] = useState<ConfigureResult | null>(null)

  // ===== D. 测试对话 =====
  const [testMsg, setTestMsg] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestChatResult | null>(null)

  const [copied, setCopied] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const accountRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      setState(await window.fairy.channel.get())
    } catch {
      // main 侧未就绪时忽略，由后续网关事件补齐
    }
  }, [])

  useEffect(() => {
    void refresh()
    // 网关启动/停止/登录态变化（含账号热重启）→ 重新拉整份通道状态
    const off = window.fairy.onGatewayState(() => void refresh())
    return off
  }, [refresh])

  // 已配置 API → 预填 baseUrl/model（apiKey 恒空输入，留空 = 不修改）
  useEffect(() => {
    if (!state || apiPrefilled.current) return
    apiPrefilled.current = true
    setBaseUrl(state.api.baseUrl ?? '')
    setModel(state.api.model ?? '')
  }, [state])

  /** action 返回的 ChannelState 直接采用；缺 state 时回退重新拉取 */
  const applyState = useCallback(
    (next: ChannelState | undefined, fallback: () => Promise<void>) => {
      if (next) setState(next)
      else void fallback()
    },
    []
  )

  /** B：保存并启用 API 通道（apiKey 空则传 ''，main 侧保持已存） */
  const handleSaveApi = async () => {
    if (savingApi) return
    setSavingApi(true)
    setApiMsg(null)
    setBanner(null)
    try {
      const cfg: ApiChannelConfig = {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim()
      }
      const res = await window.fairy.channel.saveApi(cfg)
      applyState(res.state, refresh)
      if (res.ok) {
        setApiMsg({ kind: 'ok', text: '已启用 OpenAI API 通道' })
        setApiKey('')
      } else {
        setApiMsg({ kind: 'err', text: `保存失败：${res.error ?? '未知错误'}` })
      }
    } catch (e) {
      setApiMsg({ kind: 'err', text: `保存失败：${String(e)}` })
    } finally {
      setSavingApi(false)
    }
  }

  /** 切换通道：web 不自动启动网关；切 api 要求 API 配置已就绪（否则 select 返回 error） */
  const handleSelect = async (kind: ChannelKind) => {
    if (switching) return
    setSwitching(kind)
    setBanner(null)
    try {
      const res = await window.fairy.channel.select(kind)
      applyState(res.state, refresh)
      if (res.ok) {
        setExpanded(kind)
        setBanner({
          kind: 'ok',
          text: kind === 'api' ? '已切换到 OpenAI 兼容 API 通道' : '已切换到 DeepSeek 网页通道'
        })
      } else {
        // 切 api 失败且 API 未配置 → 提示先填配置，并展开表单方便直接填写
        if (kind === 'api' && state?.api.configured !== true) {
          setExpanded('api')
          setBanner({
            kind: 'err',
            text: `${res.error ?? '切换通道失败'} —— 请先在下方 API 配置表单填写 Base URL / API Key / 模型并「保存并启用」。`
          })
        } else {
          setBanner({ kind: 'err', text: res.error ?? '切换通道失败' })
        }
      }
    } catch (e) {
      setBanner({ kind: 'err', text: `切换通道失败：${String(e)}` })
    } finally {
      setSwitching(null)
    }
  }

  /** C：启动网关 = 唯一触发 DeepSeek 登录的入口（每次启动 Fairy 需手动点一次） */
  const handleStartGateway = async () => {
    if (gwBusy) return
    setGwBusy('start')
    setBanner(null)
    try {
      const res = await window.fairy.channel.startGateway()
      applyState(res.state, refresh)
      if (!res.ok) {
        setBanner({ kind: 'err', text: `启动网关失败：${res.error ?? '未知错误'}` })
      }
    } catch (e) {
      setBanner({ kind: 'err', text: `启动网关失败：${String(e)}` })
    } finally {
      setGwBusy(null)
    }
  }

  const handleStopGateway = async () => {
    if (gwBusy) return
    setGwBusy('stop')
    setBanner(null)
    try {
      // 契约：stopGateway 直接返回 ChannelState
      setState(await window.fairy.channel.stopGateway())
    } catch (e) {
      setBanner({ kind: 'err', text: `停止网关失败：${String(e)}` })
    } finally {
      setGwBusy(null)
    }
  }

  /** C：保存账号配置（gateway.configure：运行中热重启、未运行仅保存） */
  const handleSaveAccount = async () => {
    if (!account.trim() || !password.trim() || savingAccount) return
    setSavingAccount(true)
    setCfgResult(null)
    setTestResult(null)
    try {
      const input: GatewayAccountConfig = {
        account: account.trim(),
        password: password.trim()
      }
      if (deviceId.trim()) input.deviceId = deviceId.trim()
      const res = await window.fairy.gateway.configure(input)
      setCfgResult(res)
      const nextGw = res.state
      if (nextGw) {
        setState((s) =>
          s
            ? {
                ...s,
                web: {
                  ...s.web,
                  accountConfigured: res.ok ? true : s.web.accountConfigured,
                  gateway: nextGw
                }
              }
            : s
        )
      } else {
        void refresh()
      }
    } catch (e) {
      setCfgResult({ ok: false, error: String(e) })
    } finally {
      setSavingAccount(false)
    }
  }

  /** 登录失败（login_failed / RISK_DEVICE_DETECTED 等）时：滚回表单重新保存 */
  const handleResave = () => {
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    accountRef.current?.focus()
  }

  /** D：按当前通道做一轮测试对话（channel.test 替代已移除的 gateway.testChat） */
  const handleTest = async () => {
    const msg = testMsg.trim()
    if (!msg || testing) return
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.fairy.channel.test(msg))
    } catch (e) {
      setTestResult({ ok: false, error: String(e) })
    } finally {
      setTesting(false)
    }
  }

  const handleCopyCmd = async () => {
    try {
      await navigator.clipboard.writeText(FINGERPRINT_CMD)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopied(false)
    }
  }

  const handleOpenPage = () => {
    void window.fairy.openExternal(DEEPSEEK_URL)
  }

  const channel = state?.channel ?? null
  const gw = state?.web.gateway ?? null

  // 表单/引导区跟随 ChannelState.channel 切换渲染；channel===null 时跟随选择卡展开。
  // 例外：channel==='web' 时点「改为使用 OpenAI API」失败（api 未配置）→ 展开 API 表单补填。
  const showApiForm = channel === 'api' || expanded === 'api'
  const showWebGuide = (channel === 'web' || (channel === null && expanded === 'web')) && expanded !== 'api'

  return (
    <div className="settings">
      <h2>设置 · 接入方式</h2>

      {/* ===== 顶部「当前通道」状态条 ===== */}
      {state ? <ChannelStatusBar state={state} /> : (
        <div className="status-card card-neutral">
          <p className="card-title">通道状态加载中…</p>
        </div>
      )}

      {banner && (
        <p className={banner.kind === 'ok' ? 'banner banner-ok' : 'banner banner-err'}>{banner.text}</p>
      )}

      {/* ===== A. 双通道选择卡（channel===null） ===== */}
      {channel === null && (
        <div className="channel-cards">
          <div className={expanded === 'api' ? 'channel-card active' : 'channel-card'}>
            <h3>接入 OpenAI 兼容 API</h3>
            <p>
              使用官方 DeepSeek API 或任意 OpenAI 兼容端点：填 Base URL + API Key + 模型即用，
              不启动本地网关。聊天、意图解析、记忆抽取全部直连该端点。
            </p>
            <button
              className="btn btn-primary"
              onClick={() => setExpanded(expanded === 'api' ? null : 'api')}
            >
              {expanded === 'api' ? '收起配置' : '填写配置'}
            </button>
          </div>
          <div className={expanded === 'web' ? 'channel-card active' : 'channel-card'}>
            <h3>登录 DeepSeek 网页</h3>
            <p>
              使用 DeepSeek 免费网页额度：本地网关账号池登录，不消耗 API 余额。
              每次启动 Fairy 均需手动点击「启动网关」才会登录 DeepSeek。
            </p>
            <button
              className="btn btn-primary"
              disabled={switching !== null}
              onClick={() => {
                setExpanded('web')
                void handleSelect('web')
              }}
            >
              {switching === 'web' ? '切换中…' : '开始配置'}
            </button>
          </div>
        </div>
      )}

      {/* ===== B. API 配置表单 ===== */}
      {showApiForm && (
        <section className="api-config">
          <h3>OpenAI 兼容 API 配置</h3>
          <p className="section-hint">
            可接官方 DeepSeek API（Base URL 默认 https://api.deepseek.com/v1，模型默认 deepseek-chat）
            或任意 OpenAI 兼容端点；保存即启用，不启动本地网关。
          </p>
          <form
            className="setting-form"
            onSubmit={(e) => {
              e.preventDefault()
              void handleSaveApi()
            }}
          >
            <div>
              <label>Base URL</label>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.deepseek.com/v1"
                autoComplete="off"
              />
            </div>
            <div>
              <label>API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  state?.api.configured
                    ? '已保存 API Key；留空 = 不修改'
                    : '输入 API Key（sk-…）'
                }
                autoComplete="off"
              />
            </div>
            <div>
              <label>模型</label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="deepseek-chat"
                autoComplete="off"
              />
            </div>
            <div>
              <button type="submit" className="btn btn-primary" disabled={savingApi}>
                {savingApi ? '保存中…' : '保存并启用'}
              </button>
            </div>
          </form>
          {apiMsg && (
            <p className={apiMsg.kind === 'ok' ? 'inline-msg msg-ok' : 'inline-msg msg-err'}>
              {apiMsg.kind === 'ok' ? '✓ ' : '✗ '}
              {apiMsg.text}
            </p>
          )}
          <button
            className="btn btn-link"
            disabled={switching !== null}
            onClick={() => void handleSelect('web')}
          >
            {switching === 'web' ? '切换中…' : '改为使用 DeepSeek 网页'}
          </button>
        </section>
      )}

      {/* ===== C. 网页引导流（§5.5 四步 + 网关控制区） ===== */}
      {showWebGuide && gw && (
        <section className="web-guide">
          <ol className="steps">
            <li>
              <strong>步骤一：打开 DeepSeek 网页</strong>
              <p>取设备指纹需要访问该页面（<strong>无需登录</strong>），等待页面完全加载即可。</p>
              <button className="btn" onClick={handleOpenPage}>
                打开 DeepSeek 网页
              </button>
            </li>

            <li>
              <strong>步骤二：获取并复制设备指纹（device_id）</strong>
              <p>
                在刚打开的页面按 F12 → 切到 Console → 粘贴下方命令并回车，输出会自动复制；回到这里粘贴到 device_id 框。
                device_id 是设备级指纹，同机器多账号可复用，一次获取长期有效。
              </p>
              <div className="cmd-row">
                <code className="cmd">{FINGERPRINT_CMD}</code>
                <button className="btn" onClick={() => void handleCopyCmd()}>
                  {copied ? '已复制 ✓' : '复制取指纹命令'}
                </button>
              </div>
            </li>

            <li>
              <strong>步骤三：填写账号并保存</strong>
              <p>
                保存账号配置：网关运行中会热重启应用新配置；未运行则仅保存（下次显式「启动网关」时生效）。
                状态里不含账号明文，表单需要每次手动填写。
              </p>
              <form
                className="setting-form"
                ref={formRef}
                onSubmit={(e) => {
                  e.preventDefault()
                  void handleSaveAccount()
                }}
              >
                <div>
                  <label>账号（邮箱或手机号；纯数字按手机号处理，默认 +86）</label>
                  <input
                    ref={accountRef}
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    placeholder="如 yourname@example.com 或 13800000000"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label>密码</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="DeepSeek 账号密码"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label>device_id（可选，强烈建议填写）</label>
                  <input
                    value={deviceId}
                    onChange={(e) => setDeviceId(e.target.value)}
                    placeholder="粘贴步骤二取到的指纹；不填可能触发 RISK_DEVICE_DETECTED 风控"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={savingAccount || !account.trim() || !password.trim()}
                  >
                    {savingAccount ? '保存中…' : '保存账号配置'}
                  </button>
                </div>
              </form>
              {cfgResult?.ok && (
                <p className="inline-msg msg-ok">
                  ✓ 已保存账号配置（网关状态：{cfgResult.state?.status ?? '未知'}）
                </p>
              )}
              {cfgResult && !cfgResult.ok && (
                <p className="inline-msg msg-err">✗ 保存失败：{cfgResult.error}</p>
              )}
            </li>

            <li>
              <strong>步骤四：保存 ≠ 启动（登录说明）</strong>
              <p>
                应用启动<strong>不会</strong>自动登录 DeepSeek；只有点击下方「启动网关」才会拉起本地网关并登录
                （这是唯一的 DeepSeek 登录入口）。每次启动 Fairy 均需手动点一次，启动后会话期间保持运行。
              </p>
            </li>
          </ol>

          {/* 网关控制区 */}
          <div className="gateway-control">
            <h3>网关控制</h3>
            <p className="section-hint">
              「启动网关」是唯一触发 DeepSeek 登录的操作；应用启动不会自动登录、也不会后台保活。
            </p>
            <GatewayControlCard
              gw={gw}
              busy={gwBusy}
              onStart={() => void handleStartGateway()}
              onStop={() => void handleStopGateway()}
              onResave={handleResave}
            />
            <div className="gateway-actions">
              <button
                className="btn btn-link"
                disabled={switching !== null}
                onClick={() => void handleSelect('api')}
              >
                {switching === 'api' ? '切换中…' : '改为使用 OpenAI API'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ===== D. 测试对话（两种通道下都显示） ===== */}
      {channel !== null && (
        <section className="test-block">
          <h3>测试对话</h3>
          <p className="section-hint">按当前通道发送一条非流式测试消息，验证链路可用。</p>
          <div className="test-row">
            <input
              className="test-input"
              value={testMsg}
              onChange={(e) => setTestMsg(e.target.value)}
              placeholder="一句话说说你是谁"
            />
            <button
              className="btn"
              onClick={() => void handleTest()}
              disabled={testing || !testMsg.trim()}
            >
              {testing ? '运行中…' : '测试对话'}
            </button>
          </div>
          {testResult?.ok && (
            <div className="status-card card-green">
              <p className="card-title">✓ 测试成功，当前通道链路正常</p>
              <p className="card-detail">{testResult.content}</p>
            </div>
          )}
          {testResult && !testResult.ok && testResult.expired && (
            <div className="status-card card-red">
              <p className="card-title">会话过期，请重新保存账号配置</p>
              <p className="card-hint">
                命中过期指纹（持续 429 overloaded，仅网页通道会出现）：重新填写账号/密码/device_id 并保存，
                或重新获取 device_id 后再测试。
              </p>
            </div>
          )}
          {testResult && !testResult.ok && !testResult.expired && (
            <p className="banner banner-err">测试失败：{testResult.error ?? '未知错误'}</p>
          )}
        </section>
      )}
    </div>
  )
}

/** 顶部「当前通道」状态条：null 黄 / api 绿 / web 按网关与登录状态着色 */
function ChannelStatusBar({ state }: { state: ChannelState }) {
  const { channel } = state

  if (channel === null) {
    return (
      <div className="status-card card-yellow channel-status">
        <p className="card-title">尚未选择接入方式</p>
        <p className="card-hint">请在下方两张卡片中选择：OpenAI 兼容 API，或登录 DeepSeek 网页。</p>
      </div>
    )
  }

  if (channel === 'api') {
    return (
      <div className="status-card card-green channel-status">
        <p className="card-title">
          当前通道：OpenAI 兼容 API · {state.api.baseUrl || '（未填 Base URL）'} ·{' '}
          {state.api.model || '（未填模型）'}
        </p>
      </div>
    )
  }

  // channel === 'web'
  const gw = state.web.gateway

  if (gw.status === 'ready' && gw.accountStatus === 'logged_in') {
    return (
      <div className="status-card card-green channel-status">
        <p className="card-title">DeepSeek 网页 · 网关运行中 · 端口 {gw.port}</p>
      </div>
    )
  }

  if (gw.accountStatus === 'login_failed') {
    return (
      <div className="status-card card-red channel-status">
        <p className="card-title">
          DeepSeek 网页 · 账号登录失败：{gw.accountDetail ?? '未知原因'}
        </p>
      </div>
    )
  }

  if (gw.status === 'error') {
    return (
      <div className="status-card card-red channel-status">
        <p className="card-title">DeepSeek 网页 · 网关错误</p>
        {gw.lastError && <p className="card-detail">{gw.lastError}</p>}
      </div>
    )
  }

  if (gw.status === 'starting') {
    return (
      <div className="status-card card-neutral channel-status">
        <p className="card-title">DeepSeek 网页 · 网关启动/登录中…</p>
      </div>
    )
  }

  return (
    <div className="status-card card-neutral channel-status">
      <p className="card-title">DeepSeek 网页 · 网关未启动</p>
    </div>
  )
}

/**
 * 网关控制卡：stopped→启动 / starting→disabled / ready→停止 / error→重试；
 * login_failed（RISK_DEVICE_DETECTED 等）→ 红卡 + 「重新保存账号配置」滚回表单；
 * 未配置账号优先于 error（首启 fallback 是 status:'error'+lastError:'未配置账号'，避免误显红卡）。
 */
function GatewayControlCard({
  gw,
  busy,
  onStart,
  onStop,
  onResave
}: {
  gw: GatewayState
  busy: 'start' | 'stop' | null
  onStart: () => void
  onStop: () => void
  onResave: () => void
}) {
  if (gw.accountStatus === 'login_failed') {
    return (
      <div className="status-card card-red">
        <p className="card-title">账号登录失败：{gw.accountDetail ?? '未知原因'}</p>
        <p className="card-hint">
          可能原因：device_id 缺失或风控拦截（RISK_DEVICE_DETECTED）、账号封禁（USER_IS_BANNED）、
          临时禁言（muted）。请核对上方表单各字段后重新保存。
        </p>
        <button className="btn" onClick={onResave}>
          重新保存账号配置
        </button>
      </div>
    )
  }

  if (gw.status === 'starting') {
    return (
      <div className="status-card card-neutral">
        <p className="card-title">启动/登录中…</p>
        <p className="card-hint">正在拉起本地网关并登录 DeepSeek，请稍候。</p>
        <div className="gateway-actions">
          <button className="btn" disabled>
            启动/登录中…
          </button>
        </div>
      </div>
    )
  }

  if (gw.status === 'ready') {
    return (
      <div className="status-card card-green">
        <p className="card-title">网关运行中 · 端口 {gw.port ?? '未知'} · 账号已登录</p>
        <p className="card-hint">会话期间保持运行；停止后需再次手动启动才会重新登录。</p>
        <div className="gateway-actions">
          <button className="btn" onClick={onStop} disabled={busy !== null}>
            {busy === 'stop' ? '停止中…' : '停止网关'}
          </button>
        </div>
      </div>
    )
  }

  if (!gw.configured) {
    return (
      <div className="status-card card-yellow">
        <p className="card-title">尚未保存 DeepSeek 账号配置</p>
        <p className="card-hint">
          请先完成上方步骤一~三保存账号（含 device_id）；保存后点击「启动网关」才会登录 DeepSeek。
        </p>
        <div className="gateway-actions">
          <button className="btn btn-primary" onClick={onStart} disabled={busy !== null}>
            {busy === 'start' ? '启动中…' : '启动网关'}
          </button>
        </div>
      </div>
    )
  }

  if (gw.status === 'error') {
    return (
      <div className="status-card card-red">
        <p className="card-title">网关错误</p>
        {gw.lastError && <p className="card-detail">{gw.lastError}</p>}
        <div className="gateway-actions">
          <button className="btn btn-primary" onClick={onStart} disabled={busy !== null}>
            {busy === 'start' ? '启动中…' : '重试启动'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="status-card card-neutral">
      <p className="card-title">网关未启动</p>
      <p className="card-hint">点击「启动网关」才会登录 DeepSeek；每次启动 Fairy 均需手动点一次。</p>
      <div className="gateway-actions">
        <button className="btn btn-primary" onClick={onStart} disabled={busy !== null}>
          {busy === 'start' ? '启动中…' : '启动网关'}
        </button>
      </div>
    </div>
  )
}
