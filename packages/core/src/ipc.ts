/**
 * 阶段 2 IPC 契约 — main ↔ preload ↔ renderer 共享类型。
 * preload 按 FairyApi 暴露 window.fairy；renderer 不直接 import electron。
 */

import type { AgentApprovalRequest, AgentToolNotice, ToolRisk } from './agent/registry';
import type { PermissionsConfig, PermissionsSaveResult, ToolPolicy } from './agent/permissions';
import type { ApiStyle } from './llm/types';
import type { WebAccessConfig, WebSearchEngine } from './web/types';

/**
 * 阶段 10：联网检索配置（renderer 契约面 = core/web 的 WebAccessConfig）。
 * 该类型只有数据、不含任何执行逻辑，因此可以安全地经 index.web 暴露给 renderer。
 */
export type { WebAccessConfig };

/** 单条来源（用于气泡下方的引用列表；id 与正文 [n] 编号一致） */
export interface WebSourceRef {
  id: number;
  title: string;
  url: string;
  snippet?: string;
}

/**
 * 阶段 10：本轮联网检索的用户可见结论（气泡下方提示条 + 重试入口）。
 *
 * 四种非正常收场必须能被用户一眼看见（而不是只在模型正文里被转述）：
 * - 'timeout'：超时（单请求超时或总预算耗尽）——可能已用部分资料作答；
 * - 'partial'：非超时原因导致资料不全（部分页面 404/解析失败/预算不足被跳过）；
 * - 'failed' ：没有任何可用资料（源不可达/被拒/解析不出条目）；
 * - 'degraded'：资料完整，但**来源换了**——主检索源不可达，本轮由备用引擎作答
 *   （只在「本轮亲自观察到主源失败」时提示一次；之后走短期记忆不再打扰）。
 * 正常拿到资料时不产生 notice（只列来源列表）。
 */
export interface WebNotice {
  kind: 'timeout' | 'partial' | 'failed' | 'degraded';
  /** 一句话结论：含具体原因与「本轮是否用了资料作答」（用户可读，不含编造内容） */
  message: string;
}

/** 联网配置保存/试跑的结果 */
export interface WebActionResult {
  ok: boolean;
  error?: string;
  config?: WebAccessConfig;
}

/** 设置页「试跑一次检索」的结果（不落会话，仅供链路自检） */
export interface WebSearchTestResult {
  ok: boolean;
  /** ok=false 时的可见原因（超时/引擎返回/解析失败） */
  error?: string;
  /** **实际**使用的引擎（主源不可达时会显示降级后的备用源） */
  engine?: WebSearchEngine;
  items?: WebSourceRef[];
}

export interface TestChatResult {
  ok: boolean;
  content?: string;
  error?: string;
}

/** preload 按此暴露 window.fairy（额外附加 name/version，见 env.d.ts） */
export interface FairyApi {
  /** 接入配置（目前仅 OpenAI 兼容 API） */
  channel: {
    get(): Promise<ChannelState>;
    /** 保存 OpenAI 兼容 API 配置并启用（apiKey 留空=保持已存） */
    saveApi(cfg: ApiChannelConfig): Promise<ChannelActionResult>;
    /** 按当前配置做一轮非流式测试对话 */
    test(message: string): Promise<TestChatResult>;
  };
  /**
   * 阶段 10：联网检索（DEV_PLAN §5.10）。
   * 仅 API 通道生效；开关与来源范围由用户显式配置（默认开启、每次联网在聊天气泡下留痕）。
   */
  web: {
    /** 当前联网配置（已归一，含默认值） */
    get(): Promise<WebAccessConfig>;
    /** 保存联网配置（局部更新；越界值按硬边界夹取） */
    save(cfg: Partial<WebAccessConfig>): Promise<WebActionResult>;
    /** 试跑一次检索（验证链路与来源过滤，不落会话） */
    search(query: string): Promise<WebSearchTestResult>;
  };
  /**
   * 工具权限档位（ADR-0002）：决定哪些工具调用仍需用户确认。
   * 档位只改变「是否询问」，越界与策略拒绝照旧；保存后**下一轮对话**生效。
   */
  permissions: {
    get(): Promise<PermissionsConfig>;
    /** 保存档位（非法值被 main 拒绝）；返回归一后的完整配置 */
    save(policy: ToolPolicy): Promise<PermissionsSaveResult>;
  };
  /** 日程（面板手动操作；意图路径在 main 内部直接写库） */
  events: {
    list(filter?: EventListFilter): Promise<EventRecord[]>;
    add(input: { title: string; remindAt: number; notes?: string }): Promise<EventRecord>;
    /** 勾选/取消完成 */
    complete(id: number, done: boolean): Promise<void>;
    remove(id: number): Promise<void>;
    /** 意图/通知轮询变更时广播 */
    onChanged(cb: () => void): () => void;
  };
  /** 点系统通知 → 主窗口切到指定 tab */
  onOpenTab(cb: (tab: TabKey) => void): () => void;

  // ===== 阶段 7：工具审批（renderer 只展示与回传决定，不执行任何工具） =====
  agent: {
    /** 订阅审批请求（第一个响应生效；超时/停止/已受理会发 settled 关闭对话框） */
    onApproval(cb: (request: AgentApprovalRequest) => void): () => void;
    /**
     * 提交审批决定。返回 true = main 已受理；false = id 陈旧/未知（已被超时/
     * 另一窗口结算），调用方应以 getPendingApprovals 对账而非信任本地队列。
     * snapshot 为诊断快照（可选，随 respond 落 main 日志）。
     */
    respondApproval(
      id: number,
      approved: boolean,
      snapshot?: AgentApprovalSnapshot
    ): Promise<boolean>;
    /** 订阅审批已结算（本窗口对话框应关闭） */
    onApprovalSettled(cb: (event: AgentApprovalSettledEvent) => void): () => void;
    /** 订阅对账指令（main summon 后补发；收到立即 getPending 校准） */
    onSyncRequest(cb: () => void): () => void;
    /** 权威对账：当前真正 pending 的审批列表（挂载/新请求/提交被忽略时拉取） */
    getPendingApprovals(): Promise<AgentApprovalRequest[]>;
    /** 工具执行状态（可观测；日志真源在 main） */
    onToolNotice(cb: (notice: AgentToolNotice) => void): () => void;
  };
  /** 阶段 8：Skill 扩展（设置页列表/启用/重扫；工具本身仍走 agent 审批链） */
  skills: {
    /** 技能列表（含加载错误：error 非空 = 整包拒绝、原因可见） */
    list(): Promise<SkillListItem[]>;
    /** 启用/禁用：启用需 manifest 完整可加载（校验失败返回 {ok:false,error}） */
    setEnabled(name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
    /** 重新扫描 skills 目录并重新装配 */
    reload(): Promise<SkillListItem[]>;
    /** 技能状态变化（启用/禁用/重扫）后刷新 */
    onChanged(cb: () => void): () => void;
  };
  /** 阶段 8：MCP 服务器（连接管理；env 值只在 main/DPAPI，renderer 仅见 KEY 名） */
  mcp: {
    list(): Promise<McpServerListItem[]>;
    /** 新增/更新（env 传 undefined = 保留已存；传对象 = 整体替换） */
    save(input: McpSaveInput): Promise<McpActionResult>;
    remove(name: string): Promise<McpActionResult>;
    /** 连接（initialize + tools/list）并注册其工具；失败错误可见 */
    connect(name: string): Promise<McpActionResult>;
    disconnect(name: string): Promise<McpActionResult>;
    /** 状态变化（连接/断开/保存/意外退出）后刷新 */
    onChanged(cb: () => void): () => void;
  };
  /** 阶段 9：cron 定时任务（与日程提醒分开建模；执行复用阶段 7 Agent/工具权限） */
  cron: {
    /** 任务列表 + 可预授权工具选项（来自 main 工具注册表） */
    list(): Promise<CronListResult>;
    /** 单任务运行历史（按触发时间倒序） */
    runs(taskId: string, limit?: number): Promise<CronRun[]>;
    create(input: CronCreateInput): Promise<CronActionResult>;
    /** 编辑（改表达式/时区会重新计算 nextRunAt） */
    update(id: string, patch: CronUpdateInput): Promise<CronActionResult>;
    /** 暂停/恢复（恢复时从当前时刻重算下次触发） */
    setEnabled(id: string, enabled: boolean): Promise<CronActionResult>;
    remove(id: string): Promise<void>;
    /** 立即运行一次（手动触发，同样走预授权与超范围暂停策略） */
    trigger(id: string): Promise<CronActionResult>;
    /** 任务/运行状态变化后刷新 */
    onChanged(cb: () => void): () => void;
  };
  /** 仅允许 http/https（main 侧校验） */
  openExternal(url: string): Promise<void>;

  // ===== 阶段 3：会话 + 聊天 =====
  sessions: {
    list(): Promise<SessionMeta[]>;
    create(): Promise<SessionMeta>;
    remove(id: string): Promise<void>;
    /** 会话列表需刷新（新建/删除/首条消息改标题等） */
    onChanged(cb: () => void): () => void;
  };
  chat: {
    history(sessionId: string): Promise<MessageDto[]>;
    /** 单飞：同一时刻只允许一条生成中，冲突返回 {ok:false,error} */
    send(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }>;
    /** 中止当前 sessionId 的生成（保留已生成部分） */
    stop(sessionId: string): Promise<void>;
    onDelta(cb: (e: ChatDeltaEvent) => void): () => void;
    onDone(cb: (e: ChatDoneEvent) => void): () => void;
    /** null = 空闲；广播给所有窗口 */
    onBusy(cb: (e: ChatBusyEvent) => void): () => void;
  };

  // ===== 阶段 4：记忆面板 =====
  memory: {
    list(filter?: MemoryListFilter): Promise<MemoryRecord[]>;
    add(input: { content: string; kind?: MemoryKind }): Promise<MemoryRecord>;
    update(id: number, patch: { content?: string; kind?: MemoryKind; weight?: number }): Promise<void>;
    remove(id: number): Promise<void>;
    exportAll(): Promise<MemoryRecord[]>;
    /** 入参为导入文件的 JSON 解析结果（任意值），内部校验/去重 */
    importMany(raw: unknown): Promise<MemoryImportResult>;
    /** 记忆经聊天管道变更（remember/forget/抽取）时广播 */
    onChanged(cb: () => void): () => void;
  };

  // ===== 阶段 6：打包硬化（开机自启 / 日志 / 诊断） =====
  system: {
    /** 开机自启当前状态（托盘菜单与设置页共用同一真源） */
    autoStart(): Promise<boolean>;
    /** 开关开机自启；返回设置后的实际状态 */
    setAutoStart(enabled: boolean): Promise<boolean>;
    /** 一键诊断导出（弹保存框，返回报告路径） */
    exportDiagnostics(): Promise<DiagnosticsExportResult>;
    /** 打开日志目录（%APPDATA%/fairy/logs） */
    openLogs(): Promise<void>;
  };
}

// ===== 阶段 3：会话 + 聊天类型 =====

/** 浮窗固定使用的快速会话 id（main 启动时 ensure 存在，kind='quick'） */
export const QUICK_SESSION_ID = 'fairy-quick-session';

export interface SessionMeta {
  id: string;
  /** 首条用户消息前 20 字符自动生成；空串 = 尚无消息 */
  title: string;
  kind: 'chat' | 'quick';
  /** epoch ms */
  createdAt: number;
  updatedAt: number;
}

/** system 提示词不落库（buildContext 时拼接） */
export interface MessageDto {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  /** JSON 对象：{elapsedMs?, finishReason?, aborted?, error?, ...} */
  meta: Record<string, unknown> | null;
  createdAt: number;
}

export interface ChatDeltaEvent {
  sessionId: string;
  /** assistant 占位行 id */
  messageId: number;
  kind: 'content' | 'reasoning';
  text: string;
}

export interface ChatDoneEvent {
  sessionId: string;
  messageId: number;
  ok: boolean;
  /** 用户主动停止（非错误） */
  aborted?: boolean;
  error?: string;
  elapsedMs?: number;
  /**
   * 阶段 7：通道不支持/未确认工具调用时的明确能力提示（不做静默降级）；
   * ok=true 时也可携带（聊天正常完成但工具未启用）。
   */
  capabilityHint?: string;
  /**
   * 阶段 10：本轮联网检索用到的来源（编号与正文里的 [n] 一致；同时落 message meta，
   * 气泡下方引用列表据此渲染）。
   * 无来源时省略。
   */
  sources?: WebSourceRef[];
  /**
   * 阶段 10：本轮联网检索的异常收场（超时/部分/失败）——气泡下方提示条据此渲染，
   * 用户不必从模型正文里猜「到底联没联上」。正常完成时省略。
   */
  webNotice?: WebNotice;
}

export interface ChatBusyEvent {
  /** null = 空闲 */
  sessionId: string | null;
  /**
   * 阶段 10：忙碌阶段的短文本提示（如「🌐 联网检索中…」，联网可能耗时数秒，须可见）。
   * 省略/null = 无附加提示（只显示「生成中…」）。
   */
  note?: string | null;
}

/** 审批已结算（main → renderer：对话框关闭原因） */
export interface AgentApprovalSettledEvent {
  id: number;
  approved: boolean;
  /** 'timeout' | 'cancelled'（生成中止/退出清理） */
  reason?: string;
}

/**
 * renderer 审批队列快照（诊断用）：respond 时随请求带给 main 落日志，
 * 用于排查「点击提交的 id 与队列不符/框未渲染」类 GUI 缺陷。
 */
export interface AgentApprovalSnapshot {
  /** 当前本地队列（展示顺序） */
  queueIds: number[];
  /** 已处理 id 集合 */
  handledIds: number[];
  /** 快照采集时的窗口标识（renderer 自报，如 'main'/'float'） */
  from?: string;
}

/** IPC 通道名（main 注册 / preload 转发，集中在此防拼写漂移） */
export const IPC = {
  sessionList: 'session:list',
  sessionCreate: 'session:create',
  sessionRemove: 'session:remove',
  sessionChanged: 'session:changed',
  chatHistory: 'chat:history',
  chatSend: 'chat:send',
  chatStop: 'chat:stop',
  chatDelta: 'chat:delta',
  chatDone: 'chat:done',
  chatBusy: 'chat:busy',
  memoryList: 'memory:list',
  memoryAdd: 'memory:add',
  memoryUpdate: 'memory:update',
  memoryRemove: 'memory:remove',
  memoryExport: 'memory:export',
  memoryImport: 'memory:import',
  memoryChanged: 'memory:changed',
  channelGet: 'channel:get',
  channelSaveApi: 'channel:saveApi',
  channelTest: 'channel:test',
  // ===== 阶段 10：API 通道联网检索（配置 + 设置页试跑） =====
  webGet: 'web:get',
  webSave: 'web:save',
  webSearch: 'web:search',
  // ===== 工具权限档位（ADR-0002）：决定哪些工具调用仍需用户确认 =====
  permissionsGet: 'permissions:get',
  permissionsSave: 'permissions:save',
  eventList: 'event:list',
  eventAdd: 'event:add',
  eventComplete: 'event:complete',
  eventRemove: 'event:remove',
  eventChanged: 'event:changed',
  appOpenTab: 'app:openTab',
  // ===== 阶段 6：打包硬化（自启 / 日志 / 诊断导出） =====
  appAutoStartGet: 'app:autoStartGet',
  appAutoStartSet: 'app:autoStartSet',
  appDiagnosticsExport: 'app:diagnosticsExport',
  appOpenLogs: 'app:openLogs',
  // ===== 阶段 7：工具审批与可观测事件 =====
  /** main → renderer：请求审批（广播，任一窗口响应第一个生效） */
  agentApprovalRequest: 'agent:approvalRequest',
  /** main → renderer：审批已被受理/超时/取消（关闭其他窗口的待审对话框） */
  agentApprovalSettled: 'agent:approvalSettled',
  /** main → renderer：提交审批决定（返回是否被受理；false = 陈旧 id） */
  agentApprovalRespond: 'agent:approvalRespond',
  /** renderer → main：拉取当前 pending 审批（权威对账） */
  agentApprovalGetPending: 'agent:approvalGetPending',
  /** main → renderer：对账指令（summon 后补发，renderer 收到立即 getPending 校准） */
  agentApprovalSyncReq: 'agent:approvalSyncReq',
  /** main → renderer：工具执行状态（requested/denied/started/completed/failed） */
  agentToolNotice: 'agent:toolNotice',
  // ===== 阶段 8：Skill 扩展（发现/启用/变更广播） =====
  /** renderer → main：拉取技能列表（含加载错误） */
  skillsList: 'skills:list',
  /** renderer → main：启用/禁用技能（启用记录内容指纹；成功后广播 skills:changed） */
  skillsSetEnabled: 'skills:setEnabled',
  /** renderer → main：重新扫描技能目录并装配 */
  skillsReload: 'skills:reload',
  /** main → renderer：技能列表/状态已变化 */
  skillsChanged: 'skills:changed',
  // ===== 阶段 8：MCP 服务器（配置/连接管理/变更广播） =====
  mcpList: 'mcp:list',
  mcpSave: 'mcp:save',
  mcpRemove: 'mcp:remove',
  mcpConnect: 'mcp:connect',
  mcpDisconnect: 'mcp:disconnect',
  /** main → renderer：服务器状态/工具/配置已变化（含意外退出） */
  mcpChanged: 'mcp:changed',
  // ===== 阶段 9：cron 定时任务（任务 CRUD + 运行历史 + 变更广播） =====
  cronList: 'cron:list',
  cronRuns: 'cron:runs',
  cronCreate: 'cron:create',
  cronUpdate: 'cron:update',
  cronSetEnabled: 'cron:setEnabled',
  cronRemove: 'cron:remove',
  cronTrigger: 'cron:trigger',
  /** main → renderer：任务/运行状态已变化（面板刷新） */
  cronChanged: 'cron:changed'
} as const;

// ===== 阶段 4：记忆类型 =====

export type MemoryKind = 'preference' | 'fact' | 'note' | 'decision' | 'topic';

export interface MemoryRecord {
  id: number;
  kind: MemoryKind;
  content: string;
  sourceSession: string | null;
  weight: number;
  /** epoch ms */
  createdAt: number;
  updatedAt: number;
}

export interface MemoryListFilter {
  kind?: MemoryKind | 'all';
  /** 内容子串过滤（面板搜索框） */
  query?: string;
  limit?: number;
}

export interface MemoryImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

// ===== 阶段 8：Skill 扩展 =====

/** 技能包内单个工具的展示摘要 */
export interface SkillToolSummary {
  name: string;
  description: string;
  risk: ToolRisk;
  /** 单次执行超时（毫秒） */
  timeoutMs: number;
}

/** 设置页技能列表项（main 扫描 + 配置状态合并后的视图） */
export interface SkillListItem {
  /** manifest.name（解析失败时为目录名） */
  name: string;
  /** 技能包目录绝对路径（设置页展示定位用） */
  dir: string;
  version: string;
  description: string;
  /** 来源自述（作者/主页/URL/local） */
  source: string;
  permissions: string[];
  tools: SkillToolSummary[];
  enabled: boolean;
  /**
   * 内容已变更（启用时记录的指纹与当前不符）：
   * 已被自动禁用，需用户确认后重新启用。
   */
  changed: boolean;
  /** 加载/校验错误（非空 = 整包拒绝，原因可见） */
  error?: string;
}

// ===== 阶段 8：MCP 服务器 =====

export type McpServerStatus = 'stopped' | 'connecting' | 'ready' | 'error';

/** 设置页 MCP 服务器条目（env 只回 KEY 名，值永不出 main） */
export interface McpServerListItem {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  /** 已配置的环境变量 KEY 名（值不回传） */
  envKeys: string[];
  status: McpServerStatus;
  /** 连接/退出错误（status==='error' 时可见） */
  error?: string;
  /** 服务端自述（连接成功后） */
  serverInfo?: { name?: string; version?: string };
  /** 已就绪的工具（连接成功后） */
  tools: { name: string; description: string }[];
  /** 归一化/协议/装配期的可见警告（坏条目、垃圾行、冲突跳过） */
  warnings: string[];
}

/** 保存/移除/连接结果（错误直接展示） */
export interface McpActionResult {
  ok: boolean;
  error?: string;
}

/** 保存输入（env 省略 = 保留已存；否则整体替换） */
export interface McpSaveInput {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

// ===== 阶段 9：cron 定时任务（DEV_PLAN §5.9；与日程提醒分开建模） =====

export type CronTaskStatus = 'active' | 'paused';

/**
 * 运行状态语义（DEV_PLAN 阶段 9 验收的「已确认语义」）：
 * - pending：已 claim（幂等键 task_id+scheduled_for 唯一），排队/等待重试，尚未执行；
 * - running：执行中；应用退出 → interrupted（不伪装成成功/失败）；
 * - success / failed：本轮执行结果（failed 含重试耗尽后的最终失败）；
 * - denied：无人值守运行中出现未预授权/越界（超范围）动作 → 该次运行被拒且任务被暂停；
 * - missed：错过触发且任务 catchup 关闭（记录可见，不补跑）；
 * - skipped：并发防护跳过（同一任务上一轮仍在运行）。
 */
export type CronRunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'denied'
  | 'missed'
  | 'skipped'
  | 'interrupted';

export interface CronTask {
  id: string;
  name: string;
  /** 交给 Agent 的任务指令（unattended 运行的用户消息） */
  prompt: string;
  /** 5 字段 cron 表达式，支持 @yearly/@monthly/@weekly/@daily/@hourly 宏 */
  schedule: string;
  /** IANA 时区；触发时刻按该时区墙上时钟计算（默认创建时系统时区，与系统时区后续变化解耦） */
  timezone: string;
  status: CronTaskStatus;
  /**
   * 预授权工具名集合（§5.2/§5.9）：无人值守运行只暴露这些工具，
   * 且永不授予「越界（outside）」；撤销 = 从集合移除或暂停任务。
   */
  preauthorized: string[];
  /** 停机期间错过的触发：true=补跑最近一次（更早的合并跳过），false=标记 missed 不补跑 */
  catchup: boolean;
  /** 失败重试次数（0=不重试；仅对 failed 重试，denied 不重试） */
  maxRetries: number;
  retryBackoffMs: number;
  /** 连续失败达到该上限 → 自动暂停任务并通知（不静默重试到天荒地老） */
  failureLimit: number;
  consecutiveFailures: number;
  /** 暂停原因（超范围/连续失败/通道不支持…面板与通知展示） */
  pauseReason: string | null;
  lastFiredAt: number | null;
  /** 持久化调度状态：下次触发时刻（epoch ms）；null = 未来无触发 */
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CronRun {
  id: number;
  taskId: string;
  /** 计划触发时刻（epoch ms）——幂等键，同任务同时刻只会有一行 */
  scheduledFor: number;
  attempt: number;
  /** 手动「立即运行」标记（不属于计划触发） */
  manual: boolean;
  status: CronRunStatus;
  nextRetryAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  output: string | null;
  error: string | null;
  createdAt: number;
}

/** 面板「预授权工具」选择器选项（来自 main 进程工具注册表） */
export interface CronToolOption {
  name: string;
  description: string;
  risk: ToolRisk;
  source: 'builtin' | 'skill' | 'mcp';
}

export interface CronListResult {
  tasks: CronTask[];
  tools: CronToolOption[];
}

export interface CronCreateInput {
  name: string;
  prompt: string;
  schedule: string;
  /** 缺省 = 创建时系统时区 */
  timezone?: string;
  preauthorized?: string[];
  catchup?: boolean;
  /** 0-3 */
  maxRetries?: number;
  /** 1-10，缺省 3 */
  failureLimit?: number;
}

export type CronUpdateInput = Partial<CronCreateInput>;

export interface CronActionResult {
  ok: boolean;
  error?: string;
  task?: CronTask;
}

// ===== 接入通道（OpenAI 兼容 API；DeepSeek 网页通道已移除）=====

export type ChannelKind = 'api';

export interface ApiChannelConfig {
  /** OpenAI 兼容 base，如 https://api.deepseek.com/v1 */
  baseUrl: string;
  /** 不回传给 renderer（仅保存/测试时使用）；saveApi 留空 = 保持已存 */
  apiKey: string;
  /** 如 deepseek-chat / gpt-4o-mini */
  model: string;
  /**
   * 接口风格：'chat'（默认，POST …/v1/chat/completions）或
   * 'responses'（POST …/v1/responses）。缺省按 'chat' 归一。
   */
  apiStyle?: ApiStyle;
}

export interface ChannelState {
  /** null = 尚未配置（首启/升级后，设置页引导填写 API 配置） */
  channel: ChannelKind | null;
  /** api 配置概况（不含 apiKey 明文；style = 接口风格） */
  api: { configured: boolean; baseUrl: string; model: string; style: ApiStyle };
}

export interface ChannelActionResult {
  ok: boolean;
  error?: string;
  state?: ChannelState;
}

// ===== 阶段 5：日程 =====

export type ScheduleScope = 'today' | 'tomorrow' | 'week' | 'all';

export interface EventRecord {
  id: number;
  title: string;
  notes: string | null;
  /** 触发时间 epoch ms */
  remindAt: number;
  done: boolean;
  /** 通知已触发（启动清扫也会置位，用于“已过期不补弹”） */
  fired: boolean;
  createdAt: number;
}

export interface EventListFilter {
  /** 缺省 'all'；today/tomorrow/week 按本地时区日历窗过滤 */
  scope?: ScheduleScope;
  /** 缺省 true（含已完成） */
  includeDone?: boolean;
  limit?: number;
}

/** 主窗口底部 tab（点系统通知后由 main 指定切换） */
export type TabKey = 'chat' | 'calendar' | 'memory' | 'cron' | 'settings';

// ===== 阶段 6：打包硬化 =====

/** 一键诊断导出结果（报告含版本/系统/通道状态/日志尾部，**不含账号凭据**） */
export interface DiagnosticsExportResult {
  ok: boolean;
  /** 报告 JSON 落盘路径（ok=true 时有值） */
  path?: string;
  error?: string;
}
