/**
 * 阶段 2 IPC 契约 — main ↔ preload ↔ renderer 共享类型。
 * preload 按 FairyApi 暴露 window.fairy；renderer 不直接 import electron。
 */

/** DeepSeek 账号配置（v0.2.11 账号池模式，明文存 %APPDATA%/fairy/config.json，阶段 6 上 DPAPI） */
export interface GatewayAccountConfig {
  /** 邮箱或手机号；纯数字视为手机号（area_code 默认 +86） */
  account: string;
  password: string;
  /** 数美设备指纹，风控必填；取法见 docs/llm-bridge-notes.md §1 */
  deviceId?: string;
}

export type GatewayStatus = 'stopped' | 'starting' | 'ready' | 'error';

/** 账号池登录态（来自网关 stdout 日志扫描） */
export type AccountStatus = 'none' | 'logging_in' | 'logged_in' | 'login_failed' | 'unknown';

export interface GatewayState {
  status: GatewayStatus;
  /** 实际监听端口（随机分配时每次不同） */
  port: number | null;
  /** config.json 是否已配置账号 */
  configured: boolean;
  accountStatus: AccountStatus;
  /** 登录失败原因（如 RISK_DEVICE_DETECTED / USER_IS_BANNED / muted） */
  accountDetail: string | null;
  lastError: string | null;
}

export interface ConfigureResult {
  ok: boolean;
  error?: string;
  state?: GatewayState;
}

export interface TestChatResult {
  ok: boolean;
  content?: string;
  /** 指纹命中持续 429 overloaded → 需要重新配置（托盘红 + 引导卡） */
  expired?: boolean;
  error?: string;
}

/** preload 按此暴露 window.fairy（额外附加 name/version，见 env.d.ts） */
export interface FairyApi {
  gateway: {
    getState(): Promise<GatewayState>;
    /** 保存 DeepSeek 账号：网关运行中则热重启应用，未运行则仅保存（下次显式启动生效） */
    configure(input: GatewayAccountConfig): Promise<ConfigureResult>;
  };
  /** LLM 通道选择（阶段：启动不自动登录，用户显式选择接入方式） */
  channel: {
    get(): Promise<ChannelState>;
    /** 保存 OpenAI 兼容 API 配置并切到 api 通道（apiKey 留空=保持已存；会自动停掉运行中的网页网关） */
    saveApi(cfg: ApiChannelConfig): Promise<ChannelActionResult>;
    /** 选择通道：web 不会自动启动网关；切到 api 要求 API 配置已就绪 */
    select(channel: ChannelKind): Promise<ChannelActionResult>;
    /** 仅 web：显式 spawn 网关（DeepSeek 登录只发生在这一步） */
    startGateway(): Promise<ChannelActionResult>;
    /** 停止网页网关（不影响 api 通道） */
    stopGateway(): Promise<ChannelState>;
    /** 按当前通道做一轮非流式测试对话 */
    test(message: string): Promise<TestChatResult>;
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
  /** 仅允许 http/https（main 侧校验） */
  openExternal(url: string): Promise<void>;
  /** 订阅网关状态变化，返回退订函数 */
  onGatewayState(cb: (state: GatewayState) => void): () => void;

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
}

export interface ChatBusyEvent {
  /** null = 空闲 */
  sessionId: string | null;
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
  channelSelect: 'channel:select',
  channelStart: 'channel:start',
  channelStop: 'channel:stop',
  channelTest: 'channel:test',
  eventList: 'event:list',
  eventAdd: 'event:add',
  eventComplete: 'event:complete',
  eventRemove: 'event:remove',
  eventChanged: 'event:changed',
  appOpenTab: 'app:openTab'
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

// ===== 通道选择（OpenAI 兼容 API / DeepSeek 网页）=====

export type ChannelKind = 'api' | 'web';

export interface ApiChannelConfig {
  /** OpenAI 兼容 base，如 https://api.deepseek.com/v1 */
  baseUrl: string;
  /** 不回传给 renderer（仅保存/测试时使用）；saveApi 留空 = 保持已存 */
  apiKey: string;
  /** 如 deepseek-chat / gpt-4o-mini */
  model: string;
}

export interface ChannelState {
  /** null = 尚未选择（首启/升级后，设置页展示双通道选择卡） */
  channel: ChannelKind | null;
  /** api 通道配置概况（不含 apiKey 明文） */
  api: { configured: boolean; baseUrl: string; model: string };
  web: {
    /** DeepSeek 账号是否已配置（不回显明文） */
    accountConfigured: boolean;
    /** 网关状态；channel==='web' 且未手动启动时 status='stopped' */
    gateway: GatewayState;
  };
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
export type TabKey = 'chat' | 'calendar' | 'memory' | 'settings';
