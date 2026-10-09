import { contextBridge, ipcRenderer } from 'electron'
import { APP_NAME, FAIRY_VERSION, IPC } from '@fairy/core'
import type {
  AgentApprovalRequest,
  AgentApprovalSettledEvent,
  AgentApprovalSnapshot,
  AgentToolNotice,
  ApiChannelConfig,
  ChannelActionResult,
  ChannelState,
  ChatBusyEvent,
  ChatDeltaEvent,
  ChatDoneEvent,
  CronActionResult,
  CronCreateInput,
  CronListResult,
  CronRun,
  CronUpdateInput,
  DiagnosticsExportResult,
  EventListFilter,
  EventRecord,
  FairyApi,
  MemoryImportResult,
  MemoryKind,
  MemoryListFilter,
  MemoryRecord,
  MessageDto,
  McpActionResult,
  McpSaveInput,
  McpServerListItem,
  SessionMeta,
  SkillListItem,
  TabKey,
  TestChatResult,
  WebAccessConfig,
  WebActionResult,
  WebSearchTestResult
} from '@fairy/core'

/**
 * 阶段 3+4 完整 FairyApi（按 @fairy/core ipc.ts 契约，通道名一律用 IPC 常量）。
 * 事件订阅统一 ipcRenderer.on(channel, (_e, payload) => cb(payload)) 包装并返回退订函数。
 * renderer 不直接 import electron，只经此边界访问 main。
 */

/** 事件订阅包装：返回退订函数 */
function onEvent<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld(
  'fairy',
  ({
    name: APP_NAME,
    version: FAIRY_VERSION,

    // ===== 接入配置（DEV_PLAN §5.6；目前仅 OpenAI 兼容 API） =====
    channel: {
      get: (): Promise<ChannelState> => ipcRenderer.invoke(IPC.channelGet),
      saveApi: (cfg: ApiChannelConfig): Promise<ChannelActionResult> =>
        ipcRenderer.invoke(IPC.channelSaveApi, cfg),
      test: (message: string): Promise<TestChatResult> => ipcRenderer.invoke(IPC.channelTest, message)
    },

    // ===== 阶段 10：联网检索（仅 API 通道；开关与来源范围由用户在设置页决定） =====
    web: {
      get: (): Promise<WebAccessConfig> => ipcRenderer.invoke(IPC.webGet),
      save: (cfg: Partial<WebAccessConfig>): Promise<WebActionResult> =>
        ipcRenderer.invoke(IPC.webSave, cfg),
      search: (query: string): Promise<WebSearchTestResult> =>
        ipcRenderer.invoke(IPC.webSearch, query)
    },

    // ===== 阶段 5：日程（eventChanged 双路广播：面板手动操作 + 聊天管道/通知轮询） =====
    events: {
      list: (filter?: EventListFilter): Promise<EventRecord[]> =>
        ipcRenderer.invoke(IPC.eventList, filter),
      add: (input: { title: string; remindAt: number; notes?: string }): Promise<EventRecord> =>
        ipcRenderer.invoke(IPC.eventAdd, input),
      complete: (id: number, done: boolean): Promise<void> =>
        ipcRenderer.invoke(IPC.eventComplete, id, done),
      remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.eventRemove, id),
      onChanged: (cb: () => void): (() => void) => onEvent<void>(IPC.eventChanged, () => cb())
    },

    /** 点系统通知 → 主窗口切 tab（main 广播 {tab}，此处拆包成 TabKey 给 renderer） */
    onOpenTab: (cb: (tab: TabKey) => void): (() => void) =>
      onEvent<{ tab: TabKey }>(IPC.appOpenTab, (payload) => cb(payload.tab)),

    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),

    // ===== 阶段 7：工具审批（renderer 只展示与回传决定；settled 到达即关闭对话框） =====
    agent: {
      onApproval: (cb: (request: AgentApprovalRequest) => void): (() => void) =>
        onEvent<AgentApprovalRequest>(IPC.agentApprovalRequest, cb),
      respondApproval: (id: number, approved: boolean, snapshot?: AgentApprovalSnapshot): Promise<boolean> =>
        ipcRenderer.invoke(IPC.agentApprovalRespond, id, approved, snapshot),
      onApprovalSettled: (cb: (event: AgentApprovalSettledEvent) => void): (() => void) =>
        onEvent<AgentApprovalSettledEvent>(IPC.agentApprovalSettled, cb),
      onSyncRequest: (cb: () => void): (() => void) => onEvent<void>(IPC.agentApprovalSyncReq, cb),
      getPendingApprovals: (): Promise<AgentApprovalRequest[]> =>
        ipcRenderer.invoke(IPC.agentApprovalGetPending),
      onToolNotice: (cb: (notice: AgentToolNotice) => void): (() => void) =>
        onEvent<AgentToolNotice>(IPC.agentToolNotice, cb)
    },

    // ===== 阶段 8：Skill 扩展（设置页列表/启用/重扫；工具执行仍走 agent 审批链） =====
    skills: {
      list: (): Promise<SkillListItem[]> => ipcRenderer.invoke(IPC.skillsList),
      setEnabled: (name: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke(IPC.skillsSetEnabled, name, enabled),
      reload: (): Promise<SkillListItem[]> => ipcRenderer.invoke(IPC.skillsReload),
      onChanged: (cb: () => void): (() => void) => onEvent<void>(IPC.skillsChanged, () => cb())
    },

    // ===== 阶段 8：MCP 服务器（连接管理；env 值永不出 main） =====
    mcp: {
      list: (): Promise<McpServerListItem[]> => ipcRenderer.invoke(IPC.mcpList),
      save: (input: McpSaveInput): Promise<McpActionResult> =>
        ipcRenderer.invoke(IPC.mcpSave, input),
      remove: (name: string): Promise<McpActionResult> => ipcRenderer.invoke(IPC.mcpRemove, name),
      connect: (name: string): Promise<McpActionResult> => ipcRenderer.invoke(IPC.mcpConnect, name),
      disconnect: (name: string): Promise<McpActionResult> =>
        ipcRenderer.invoke(IPC.mcpDisconnect, name),
      onChanged: (cb: () => void): (() => void) => onEvent<void>(IPC.mcpChanged, () => cb())
    },

    // ===== 阶段 9：cron 定时任务（任务 CRUD + 运行历史 + 变更广播） =====
    cron: {
      list: (): Promise<CronListResult> => ipcRenderer.invoke(IPC.cronList),
      runs: (taskId: string, limit?: number): Promise<CronRun[]> =>
        ipcRenderer.invoke(IPC.cronRuns, taskId, limit),
      create: (input: CronCreateInput): Promise<CronActionResult> =>
        ipcRenderer.invoke(IPC.cronCreate, input),
      update: (id: string, patch: CronUpdateInput): Promise<CronActionResult> =>
        ipcRenderer.invoke(IPC.cronUpdate, id, patch),
      setEnabled: (id: string, enabled: boolean): Promise<CronActionResult> =>
        ipcRenderer.invoke(IPC.cronSetEnabled, id, enabled),
      remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.cronRemove, id),
      trigger: (id: string): Promise<CronActionResult> => ipcRenderer.invoke(IPC.cronTrigger, id),
      onChanged: (cb: () => void): (() => void) => onEvent<void>(IPC.cronChanged, () => cb())
    },

    sessions: {
      list: (): Promise<SessionMeta[]> => ipcRenderer.invoke(IPC.sessionList),
      create: (): Promise<SessionMeta> => ipcRenderer.invoke(IPC.sessionCreate),
      remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionRemove, id),
      onChanged: (cb: () => void): (() => void) => onEvent<void>(IPC.sessionChanged, () => cb())
    },

    chat: {
      history: (sessionId: string): Promise<MessageDto[]> =>
        ipcRenderer.invoke(IPC.chatHistory, sessionId),
      send: (sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> =>
        ipcRenderer.invoke(IPC.chatSend, sessionId, text),
      stop: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.chatStop, sessionId),
      onDelta: (cb: (e: ChatDeltaEvent) => void): (() => void) =>
        onEvent<ChatDeltaEvent>(IPC.chatDelta, cb),
      onDone: (cb: (e: ChatDoneEvent) => void): (() => void) =>
        onEvent<ChatDoneEvent>(IPC.chatDone, cb),
      onBusy: (cb: (e: ChatBusyEvent) => void): (() => void) =>
        onEvent<ChatBusyEvent>(IPC.chatBusy, cb)
    },

    // ===== 阶段 4：记忆面板（memory:changed 双路广播：面板手动操作 + 聊天管道/抽取） =====
    memory: {
      list: (filter?: MemoryListFilter): Promise<MemoryRecord[]> =>
        ipcRenderer.invoke(IPC.memoryList, filter),
      add: (input: { content: string; kind?: MemoryKind }): Promise<MemoryRecord> =>
        ipcRenderer.invoke(IPC.memoryAdd, input),
      update: (
        id: number,
        patch: { content?: string; kind?: MemoryKind; weight?: number }
      ): Promise<void> => ipcRenderer.invoke(IPC.memoryUpdate, id, patch),
      remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.memoryRemove, id),
      exportAll: (): Promise<MemoryRecord[]> => ipcRenderer.invoke(IPC.memoryExport),
      importMany: (raw: unknown): Promise<MemoryImportResult> =>
        ipcRenderer.invoke(IPC.memoryImport, raw),
      onChanged: (cb: () => void): (() => void) => onEvent<void>(IPC.memoryChanged, () => cb())
    },

    // ===== 阶段 6：打包硬化（开机自启 / 日志目录 / 一键诊断导出） =====
    system: {
      autoStart: (): Promise<boolean> => ipcRenderer.invoke(IPC.appAutoStartGet),
      setAutoStart: (enabled: boolean): Promise<boolean> =>
        ipcRenderer.invoke(IPC.appAutoStartSet, enabled),
      exportDiagnostics: (): Promise<DiagnosticsExportResult> =>
        ipcRenderer.invoke(IPC.appDiagnosticsExport),
      openLogs: (): Promise<void> => ipcRenderer.invoke(IPC.appOpenLogs)
    }
  } as unknown as FairyApi & { name: string; version: string })
)
