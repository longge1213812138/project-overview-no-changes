import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ApiChannelConfig,
  ApiStyle,
  ChannelState,
  McpServerListItem,
  SkillListItem,
  TestChatResult,
  WebAccessConfig,
  WebSourceRef
} from '@fairy/core'

type Feedback = { kind: 'ok' | 'err'; text: string }

/**
 * 设置页 = 接入配置入口（docs/DEV_PLAN.md §5.6）。
 *
 * 界面结构：
 * - 顶部固定「当前接入方式」状态条（null 黄 / api 绿）；
 * - A. OpenAI 兼容 API 配置表单（channel===null 与 'api' 下都显示）；
 * - B. 测试对话（配置就绪后显示）。
 *
 * 状态来源（契约见 packages/core/src/ipc.ts，测试对话走 channel.test）：
 * - 挂载时 channel.get()；每个 action 返回的 state 直接采用。
 */
export default function SettingsTab() {
  const [state, setState] = useState<ChannelState | null>(null)

  // ===== A. API 配置表单 =====
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  /** 接口风格：chat = /v1/chat/completions（默认），responses = /v1/responses */
  const [apiStyle, setApiStyle] = useState<ApiStyle>('chat')
  const [savingApi, setSavingApi] = useState(false)
  const [apiMsg, setApiMsg] = useState<Feedback | null>(null)
  const apiPrefilled = useRef(false)

  // ===== B. 测试对话 =====
  const [testMsg, setTestMsg] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestChatResult | null>(null)

  const refresh = useCallback(async () => {
    try {
      setState(await window.fairy.channel.get())
    } catch {
      // main 侧未就绪时忽略，下次操作或重挂载时再拉取
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 已配置 API → 预填 baseUrl/model/style（apiKey 恒空输入，留空 = 不修改）
  useEffect(() => {
    if (!state || apiPrefilled.current) return
    apiPrefilled.current = true
    setBaseUrl(state.api.baseUrl ?? '')
    setModel(state.api.model ?? '')
    setApiStyle(state.api.style ?? 'chat')
  }, [state])

  /** action 返回的 ChannelState 直接采用；缺 state 时回退重新拉取 */
  const applyState = useCallback(
    (next: ChannelState | undefined, fallback: () => Promise<void>) => {
      if (next) setState(next)
      else void fallback()
    },
    []
  )

  /** A：保存并启用接入配置（apiKey 空则传 ''，main 侧保持已存） */
  const handleSaveApi = async () => {
    if (savingApi) return
    setSavingApi(true)
    setApiMsg(null)
    try {
      const cfg: ApiChannelConfig = {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        apiStyle
      }
      const res = await window.fairy.channel.saveApi(cfg)
      applyState(res.state, refresh)
      if (res.ok) {
        setApiMsg({ kind: 'ok', text: '已启用 OpenAI 兼容 API' })
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

  /** B：按当前配置做一轮测试对话 */
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

  const channel = state?.channel ?? null

  return (
    <div className="settings">
      <h2>设置 · 接入方式</h2>

      {/* ===== 顶部「当前通道」状态条 ===== */}
      {state ? <ChannelStatusBar state={state} /> : (
        <div className="status-card card-neutral">
          <p className="card-title">正在读取 Fairy 的思维来源状态…</p>
        </div>
      )}

      {/* ===== A. OpenAI 兼容 API 配置（唯一接入方式） ===== */}
      <section className="api-config">
        <h3>OpenAI 兼容 API 配置</h3>
        <p className="section-hint">
          Fairy 的思维接在这里：可接官方 DeepSeek API（Base URL 默认 https://api.deepseek.com/v1，
          模型默认 deepseek-chat）或任意 OpenAI 兼容端点；接口风格支持 Chat Completions
          （/v1/chat/completions）与 Responses（/v1/responses）两种；保存即启用。
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
                state?.api.configured ? '已保存 API Key；留空 = 不修改' : '输入 API Key（sk-…）'
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
            <label title="同一 Base URL 的两种 OpenAI 兼容接口：Chat Completions 或 Responses">
              接口风格
            </label>
            <select value={apiStyle} onChange={(e) => setApiStyle(e.target.value as ApiStyle)}>
              <option value="chat">Chat Completions（…/v1/chat/completions）</option>
              <option value="responses">Responses（…/v1/responses）</option>
            </select>
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
      </section>

      {/* ===== B. 测试对话 ===== */}
      {channel !== null && (
        <section className="test-block">
          <h3>测试对话</h3>
          <p className="section-hint">发一条非流式测试消息验证链路（探针调用，不带人设——回答的语气就是这个模型的底色）。</p>
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
              <p className="card-title">✓ 链路正常——Fairy 的思维回路已接通</p>
              <p className="card-detail">{testResult.content}</p>
            </div>
          )}
          {testResult && !testResult.ok && (
            <p className="banner banner-err">测试失败：{testResult.error ?? '未知错误'}</p>
          )}
        </section>
      )}

      {/* ===== E. 应用设置（阶段 6 打包硬化）：开机自启 / 日志 / 诊断导出 ===== */}
      <AppSettingsSection />

      {/* ===== H. 联网检索（阶段 10 / DEV_PLAN §5.10）：开关 / 来源范围 / 用量上限 / 试跑 ===== */}
      <WebSection />

      {/* ===== F. 技能 Skill（阶段 8 / DEV_PLAN §5.8）：列表 + 启用/禁用 + 重扫 ===== */}
      <SkillsSection />

      {/* ===== G. MCP 服务器（阶段 8 / DEV_PLAN §5.8）：配置 + 连接管理 ===== */}
      <McpSection />
    </div>
  )
}

/** E. 应用设置（阶段 6 打包硬化 / DEV_PLAN §6.6）：开机自启开关 + 日志目录 + 一键诊断导出 */
function AppSettingsSection() {
  const [autoStart, setAutoStart] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Feedback | null>(null)

  useEffect(() => {
    void window.fairy.system
      .autoStart()
      .then(setAutoStart)
      .catch((e: unknown) => setMsg({ kind: 'err', text: `读取开机自启状态失败：${String(e)}` }))
  }, [])

  const handleToggle = async (next: boolean): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const actual = await window.fairy.system.setAutoStart(next)
      setAutoStart(actual)
      setMsg({
        kind: actual === next ? 'ok' : 'err',
        text:
          actual === next
            ? next
              ? '已开启开机自启：重启电脑后托盘自动出现，日程提醒不丢失'
              : '已关闭开机自启'
            : '设置未生效（写自启注册表项失败）'
      })
    } catch (e) {
      setMsg({ kind: 'err', text: `设置开机自启失败：${String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const handleExport = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.fairy.system.exportDiagnostics()
      setMsg(
        res.ok
          ? { kind: 'ok', text: `诊断报告已导出：${res.path}` }
          : res.error === '已取消'
            ? { kind: 'ok', text: '已取消导出' }
            : { kind: 'err', text: `导出失败：${res.error ?? '未知错误'}` }
      )
    } catch (e) {
      setMsg({ kind: 'err', text: `导出失败：${String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="app-settings">
      <h3>应用</h3>
      <p className="section-hint">
        Fairy 的作息与体检报告：开机自启随安装默认开启（安装选项页可改）；日志按天滚动、保留 7 天。
        诊断报告只含版本/系统/通道状态与日志尾部，不含账号凭据。
      </p>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={autoStart === true}
          disabled={busy || autoStart === null}
          onChange={(e) => void handleToggle(e.target.checked)}
        />
        <span>
          开机自启（{autoStart === null ? '读取中…' : autoStart ? '已开启' : '已关闭'}）
        </span>
      </label>
      <div className="app-actions">
        <button className="btn" onClick={() => void handleExport()} disabled={busy}>
          {busy ? '处理中…' : '导出诊断信息'}
        </button>
        <button className="btn btn-link" onClick={() => void window.fairy.system.openLogs()} disabled={busy}>
          打开日志目录
        </button>
      </div>
      {msg && <p className={`inline-msg ${msg.kind === 'ok' ? 'msg-ok' : 'msg-err'}`}>{msg.text}</p>}
    </section>
  )
}

/**
 * H. 联网检索（阶段 10 / DEV_PLAN §5.10）。
 *
 * 界面口径（与真实的触发/审批口径一一对应，避免「我以为是全自动」的误会）：
 * - **触发**：默认只在「用户明确要求（联网/搜一下/帮我查…）」「涉及时效信息（最新/今天/新闻/天气…）」
 *   「直接给了链接」三类情况下联网，普通闲聊不联网；
 * - **工具**：`web_search` / `web_fetch` 两个工具随开关装配（模型主动调用时**每次都要确认**）；
 * - **可见**：每次检索都会在回答气泡下方列出实际用到的来源；关闭开关即卸载工具且不再外发请求。
 */
function WebSection() {
  const [cfg, setCfg] = useState<WebAccessConfig | null>(null)
  const [maxResults, setMaxResults] = useState('5')
  const [fetchTopN, setFetchTopN] = useState('2')
  const [allowedText, setAllowedText] = useState('')
  const [blockedText, setBlockedText] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<Feedback | null>(null)

  const [testQuery, setTestQuery] = useState('')
  const [testing, setTesting] = useState(false)
  const [items, setItems] = useState<WebSourceRef[] | null>(null)

  useEffect(() => {
    void window.fairy.web
      .get()
      .then((next: WebAccessConfig) => {
        setCfg(next)
        setMaxResults(String(next.maxResults))
        setFetchTopN(String(next.fetchTopN))
        setAllowedText(next.allowedDomains.join('\n'))
        setBlockedText(next.blockedDomains.join('\n'))
      })
      .catch((e: unknown) => setMsg({ kind: 'err', text: `读取联网配置失败：${String(e)}` }))
  }, [])

  /** 域名文本 → 数组（支持换行/逗号/中文顿号分隔；空结构 = 不限制） */
  const parseDomains = (text: string): string[] =>
    text
      .split(/[\n,，、;；]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== '')

  const readInt = (text: string, fallback: number, min: number, max: number): number => {
    const n = Number.parseInt(text, 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }

  const handleSave = async (patch: Partial<WebAccessConfig>, okText: string): Promise<void> => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await window.fairy.web.save(patch)
      if (res.ok && res.config) {
        setCfg(res.config)
        setMaxResults(String(res.config.maxResults))
        setFetchTopN(String(res.config.fetchTopN))
        setAllowedText(res.config.allowedDomains.join('\n'))
        setBlockedText(res.config.blockedDomains.join('\n'))
        setMsg({ kind: 'ok', text: okText })
      } else {
        setMsg({ kind: 'err', text: `保存失败：${res.error ?? '未知错误'}` })
      }
    } catch (e) {
      setMsg({ kind: 'err', text: `保存失败：${String(e)}` })
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = (next: boolean): void => {
    void handleSave({ enabled: next }, next ? '已开启联网（web_search / web_fetch 已装配）' : '已关闭联网（工具已卸载，不再外发请求）')
  }

  const handleTest = async (): Promise<void> => {
    const q = testQuery.trim()
    if (q === '' || testing) return
    setTesting(true)
    setMsg(null)
    setItems(null)
    try {
      const res = await window.fairy.web.search(q)
      if (res.ok) {
        setItems(res.items ?? [])
        setMsg({ kind: 'ok', text: `检索完成：${(res.items ?? []).length} 条来源` })
      } else {
        setItems([])
        setMsg({ kind: 'err', text: `试跑失败：${res.error ?? '未知错误'}` })
      }
    } catch (e) {
      setMsg({ kind: 'err', text: `试跑失败：${String(e)}` })
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="web-settings">
      <h3>联网检索</h3>
      <p className="section-hint">
        Fairy 的外感官（仅 API 通道可用）。触发条件：① 你明确要求（联网/搜一下/帮我查…）；
        ② 问题涉及最新信息（最新/今天/新闻/天气/股价…）；③ 直接给出了链接。普通闲聊不联网。
        每次检索都会在回答气泡下方列出实际用到的来源；模型主动调用 web_search / web_fetch 时每次都要你确认。
        检索词会发送给检索引擎（主源 DuckDuckGo；本机不可达时自动降级到 Bing 备用源），关闭开关即完全不外发请求。
      </p>
      {cfg === null ? (
        <p className="section-hint">读取中…</p>
      ) : (
        <>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={cfg.enabled}
              disabled={saving}
              onChange={(e) => handleToggle(e.target.checked)}
            />
            <span>开启联网（{cfg.enabled ? '已开启' : '已关闭'}）</span>
          </label>

          <div className="web-form">
            <label className="setting-form">
              <span>结果条数上限（1-10）</span>
              <input value={maxResults} onChange={(e) => setMaxResults(e.target.value)} placeholder="5" />
            </label>
            <label className="setting-form">
              <span>自动抓取正文的条数（0-3；0 = 只用摘要）</span>
              <input value={fetchTopN} onChange={(e) => setFetchTopN(e.target.value)} placeholder="2" />
            </label>
            <label className="setting-form">
              <span>来源白名单（域名，留空 = 不限；如 example.com 含其子域名）</span>
              <textarea
                rows={2}
                value={allowedText}
                onChange={(e) => setAllowedText(e.target.value)}
                placeholder={'example.com\ndocs.python.org'}
              />
            </label>
            <label className="setting-form">
              <span>来源黑名单（命中即丢弃，优先于白名单）</span>
              <textarea
                rows={2}
                value={blockedText}
                onChange={(e) => setBlockedText(e.target.value)}
                placeholder={'低质站点.example'}
              />
            </label>
            <div className="app-actions">
              <button
                className="btn btn-primary"
                disabled={saving}
                onClick={() =>
                  void handleSave(
                    {
                      maxResults: readInt(maxResults, 5, 1, 10),
                      fetchTopN: readInt(fetchTopN, 2, 0, 3),
                      allowedDomains: parseDomains(allowedText),
                      blockedDomains: parseDomains(blockedText)
                    },
                    '联网配置已保存'
                  )
                }
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </>
      )}

      <div className="web-test">
        <p className="section-hint">试跑一次检索——验证链路与来源过滤，不写入任何会话（顺带看看这次用的是哪个源）。</p>
        <div className="test-row">
          <input
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            placeholder="如：2026 年主流 LLM 推理框架现状"
          />
          <button className="btn" disabled={testing || testQuery.trim() === ''} onClick={() => void handleTest()}>
            {testing ? '检索中…' : '检索'}
          </button>
        </div>
        {items !== null && items.length > 0 && (
          <ul className="web-test-list">
            {items.map((s) => (
              <li key={`${s.id}-${s.url}`}>
                <span className="web-source-id">[{s.id}]</span>
                <span className="web-source-title">{s.title}</span>
                <span className="web-source-url">{s.url}</span>
                {s.snippet !== undefined && s.snippet !== '' && (
                  <span className="web-source-snippet">{s.snippet}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {msg && <p className={`inline-msg ${msg.kind === 'ok' ? 'msg-ok' : 'msg-err'}`}>{msg.text}</p>}
    </section>
  )
}

/** risk → 中文徽标文案（与审批对话框一致） */
const SKILL_RISK_LABEL: Record<string, string> = { read: '只读', write: '写入', exec: '执行' }

/**
 * F. 技能 Skill（阶段 8 / DEV_PLAN §5.8）：
 * 列表（名称/版本/来源/声明权限/工具/错误可见）+ 启用/禁用 + 重新扫描。
 * 安全提示直出：新发现默认禁用、内容变更自动停用、启用后每次调用仍逐一审批。
 */
function SkillsSection() {
  const [items, setItems] = useState<SkillListItem[] | null>(null)
  /** busy = 'reload' 或正在切换的技能名 */
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Feedback | null>(null)

  const refresh = useCallback(async () => {
    try {
      setItems(await window.fairy.skills.list())
    } catch (e) {
      setMsg({ kind: 'err', text: `读取技能列表失败：${String(e)}` })
    }
  }, [])

  useEffect(() => {
    void refresh()
    // main 广播（启用/禁用/重扫后）→ 全窗口同步刷新
    return window.fairy.skills.onChanged(() => void refresh())
  }, [refresh])

  const handleToggle = async (name: string, enabled: boolean): Promise<void> => {
    setBusy(name)
    setMsg(null)
    try {
      const res = await window.fairy.skills.setEnabled(name, enabled)
      if (res.ok) {
        setMsg({
          kind: 'ok',
          text: enabled
            ? `已启用 ${name}：其工具进入统一审批链（每次调用均需在弹窗中确认）`
            : `已禁用 ${name}`
        })
      } else {
        setMsg({ kind: 'err', text: `${enabled ? '启用' : '禁用'}失败：${res.error ?? '未知错误'}` })
      }
      await refresh()
    } catch (e) {
      setMsg({ kind: 'err', text: `操作失败：${String(e)}` })
    } finally {
      setBusy(null)
    }
  }

  const handleReload = async (): Promise<void> => {
    setBusy('reload')
    setMsg(null)
    try {
      setItems(await window.fairy.skills.reload())
      setMsg({ kind: 'ok', text: '已重新扫描技能目录' })
    } catch (e) {
      setMsg({ kind: 'err', text: `重新扫描失败：${String(e)}` })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="skills-settings">
      <h3>技能（Skill）</h3>
      <p className="section-hint">
        给 Fairy 装新本事：把技能包放入 <code>%APPDATA%\fairy\skills\&lt;目录&gt;\</code>（含 skill.json）。
        新发现的技能默认禁用；包内容一变会自动停用、需重新启用；启用后其工具仍
        <strong>每次调用逐一审批</strong>，审批框展示「扩展」徽标与来源/声明权限。
        应用不提供任何网络安装来源。
      </p>
      <div className="skills-head">
        <button className="btn" onClick={() => void handleReload()} disabled={busy !== null}>
          {busy === 'reload' ? '扫描中…' : '重新扫描'}
        </button>
      </div>
      {items !== null && items.length === 0 && (
        <p className="section-hint">Fairy 还没有新本事——目录已就绪，放入技能包后点「重新扫描」。</p>
      )}
      <ul className="skills-list">
        {items?.map((s) => (
          <li key={s.dir} className={`skill-row${s.error !== undefined ? ' skill-row-error' : ''}`}>
            <div className="skill-main">
              <span className="skill-name">{s.name}</span>
              <span className="skill-version">v{s.version}</span>
              {s.error === undefined && (
                <span className={`skill-flag${s.enabled ? ' flag-on' : ''}`}>
                  {s.enabled ? '已启用' : '已禁用'}
                </span>
              )}
              {s.changed && <span className="skill-flag flag-changed">内容已变更</span>}
            </div>
            {s.error !== undefined ? (
              <p className="skill-error-text">加载失败（整包拒绝）：{s.error}</p>
            ) : (
              <>
                <p className="skill-desc">{s.description}</p>
                <p className="skill-meta">
                  来源：{s.source}
                  {s.permissions.length > 0 ? ` · 声明权限：${s.permissions.join('、')}` : ' · 声明权限：无'}
                </p>
                <p className="skill-meta">
                  工具：
                  {s.tools.length === 0
                    ? '无'
                    : s.tools.map((t) => `${t.name}（${SKILL_RISK_LABEL[t.risk] ?? t.risk}）`).join('、')}
                </p>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={busy !== null}
                    onChange={(e) => void handleToggle(s.name, e.target.checked)}
                  />
                  <span>{s.changed ? '启用（内容已变更，需你确认）' : '启用此技能'}</span>
                </label>
              </>
            )}
          </li>
        ))}
      </ul>
      {msg && <p className={`inline-msg ${msg.kind === 'ok' ? 'msg-ok' : 'msg-err'}`}>{msg.text}</p>}
    </section>
  )
}

const MCP_STATUS_TEXT: Record<McpServerListItem['status'], string> = {
  stopped: '未连接',
  connecting: '连接中…',
  ready: '已连接',
  error: '错误'
}

/**
 * G. MCP 服务器（阶段 8 / DEV_PLAN §5.8）：
 * 配置列表（状态/工具/警告可见）+ 连接/断开 + 添加/移除。
 * 凭据安全：env 只在保存时写入（DPAPI），列表仅回显 KEY 名，值永不出 main。
 */
function McpSection() {
  const [items, setItems] = useState<McpServerListItem[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Feedback | null>(null)

  // 添加表单
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')

  const refresh = useCallback(async () => {
    try {
      setItems(await window.fairy.mcp.list())
    } catch (e) {
      setMsg({ kind: 'err', text: `读取 MCP 列表失败：${String(e)}` })
    }
  }, [])

  useEffect(() => {
    void refresh()
    return window.fairy.mcp.onChanged(() => void refresh())
  }, [refresh])

  const run = async (key: string, action: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setBusy(key)
    setMsg(null)
    try {
      const res = await action()
      setMsg(res.ok ? { kind: 'ok', text: okText } : { kind: 'err', text: res.error ?? '操作失败' })
      await refresh()
    } catch (e) {
      setMsg({ kind: 'err', text: `操作失败：${String(e)}` })
    } finally {
      setBusy(null)
    }
  }

  const handleSaveNew = async () => {
    const args = argsText.split('\n').map((a) => a.trim()).filter((a) => a !== '')
    const env: Record<string, string> = {}
    for (const line of envText.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) {
        setMsg({ kind: 'err', text: `环境变量格式应为 KEY=VALUE：${trimmed}` })
        return
      }
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1)
    }
    await run(
      'save-new',
      () =>
        window.fairy.mcp.save({
          name: name.trim(),
          command: command.trim(),
          args,
          ...(Object.keys(env).length > 0 ? { env } : {})
        }),
      `已保存 MCP 服务器「${name.trim()}」${Object.keys(env).length > 0 ? '（env 已加密存入 DPAPI）' : ''}`
    )
    if (items !== null) {
      // 成功才清表单
      const latest = await window.fairy.mcp.list().catch(() => null)
      if (latest?.some((s) => s.name === name.trim())) {
        setShowForm(false)
        setName('')
        setCommand('')
        setArgsText('')
        setEnvText('')
      }
    }
  }

  return (
    <section className="mcp-settings">
      <h3>MCP 服务器</h3>
      <p className="section-hint">
        给 Fairy 接外挂：外部工具服务（stdio 协议）。不自动连接——保存后在列表手动「连接」，
        其工具即进入统一审批链（「扩展」徽标 + 每次调用逐一确认）。环境变量（可能含 token）
        加密存入 DPAPI，此处只回显变量名；命令行不含 shell 解释，Windows 下需 node 脚本请直接填
        node.exe 绝对路径。
      </p>
      <div className="skills-head">
        <button
          className="btn"
          onClick={() => {
            setShowForm((v) => !v)
            setMsg(null)
          }}
        >
          {showForm ? '收起表单' : '添加服务器'}
        </button>
      </div>

      {showForm && (
        <div className="mcp-form">
          <label className="setting-form">
            <span>名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：filesystem" />
          </label>
          <label className="setting-form">
            <span>启动命令（可执行文件绝对路径或 PATH 内命令名）</span>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="如：C:\Program Files\nodejs\node.exe"
            />
          </label>
          <label className="setting-form">
            <span>参数（每行一个）</span>
            <textarea
              rows={3}
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              placeholder={'如：\nC:\\tools\\mcp-server\\index.js'}
            />
          </label>
          <label className="setting-form">
            <span>环境变量（每行 KEY=VALUE，加密保存；留空 = 不注入）</span>
            <textarea rows={2} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="API_TOKEN=..." />
          </label>
          <div className="app-actions">
            <button className="btn btn-primary" onClick={() => void handleSaveNew()} disabled={busy !== null}>
              {busy === 'save-new' ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      {items !== null && items.length === 0 && (
        <p className="section-hint">还没有外接服务——点「添加服务器」接一个。</p>
      )}
      <ul className="skills-list">
        {items?.map((s) => (
          <li key={s.name} className={`skill-row${s.status === 'error' ? ' skill-row-error' : ''}`}>
            <div className="skill-main">
              <span className="skill-name">{s.name}</span>
              <span className={`skill-flag${s.status === 'ready' ? ' flag-on' : s.status === 'error' ? ' skill-flag-err' : ''}`}>
                {MCP_STATUS_TEXT[s.status]}
              </span>
              {s.serverInfo?.version !== undefined && (
                <span className="skill-version">
                  {s.serverInfo.name ?? ''} v{s.serverInfo.version}
                </span>
              )}
            </div>
            <p className="skill-meta">
              {s.command} {s.args.join(' ')}
              {s.envKeys.length > 0 ? ` · env：${s.envKeys.join('、')}（DPAPI）` : ''}
              {s.cwd !== undefined ? ` · cwd：${s.cwd}` : ''}
            </p>
            {s.error !== undefined && <p className="skill-error-text">{s.error}</p>}
            <p className="skill-meta">
              工具：{s.tools.length === 0 ? (s.status === 'ready' ? '无' : '未连接') : s.tools.map((t) => t.name).join('、')}
            </p>
            {s.warnings.length > 0 && (
              <p className="skill-warn-text">警告：{s.warnings.join('；')}</p>
            )}
            <div className="app-actions">
              {s.status === 'ready' || s.status === 'connecting' ? (
                <button
                  className="btn"
                  disabled={busy !== null || s.status === 'connecting'}
                  onClick={() => void run(s.name, () => window.fairy.mcp.disconnect(s.name), `已断开 ${s.name}`)}
                >
                  断开
                </button>
              ) : (
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() => void run(s.name, () => window.fairy.mcp.connect(s.name), `已连接 ${s.name}`)}
                >
                  {busy === s.name ? '连接中…' : s.status === 'error' ? '重试连接' : '连接'}
                </button>
              )}
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() => void run(s.name, () => window.fairy.mcp.remove(s.name), `已移除 ${s.name}`)}
              >
                移除
              </button>
            </div>
          </li>
        ))}
      </ul>
      {msg && <p className={`inline-msg ${msg.kind === 'ok' ? 'msg-ok' : 'msg-err'}`}>{msg.text}</p>}
    </section>
  )
}

/** 顶部「当前接入方式」状态条：null 黄 / api 绿 */
function ChannelStatusBar({ state }: { state: ChannelState }) {
  const { channel } = state

  if (channel === null) {
    return (
      <div className="status-card card-yellow channel-status">
        <p className="card-title">尚未配置接入方式</p>
        <p className="card-hint">
          Fairy 现在没有思维来源。在下方填写 OpenAI 兼容 API 的 Base URL / API Key / 模型，
          点「保存并启用」——我就上线。
        </p>
      </div>
    )
  }

  return (
    <div className="status-card card-green channel-status">
      <p className="card-title">
        当前接入：OpenAI 兼容 API · {state.api.baseUrl || '（未填 Base URL）'} ·{' '}
        {state.api.model || '（未填模型）'} ·{' '}
        {state.api.style === 'responses' ? 'Responses（/v1/responses）' : 'Chat Completions'}
      </p>
    </div>
  )
}
