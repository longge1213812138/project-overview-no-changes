import { contextBridge, ipcRenderer } from 'electron'
import { APP_NAME, FAIRY_VERSION, IPC } from '@fairy/core'
import type {
  ApiChannelConfig,
  ChannelActionResult,
  ChannelKind,
  ChannelState,
  ChatBusyEvent,
  ChatDeltaEvent,
  ChatDoneEvent,
  ConfigureResult,
  EventListFilter,
  EventRecord,
  FairyApi,
  GatewayAccountConfig,
  GatewayState,
  MemoryImportResult,
  MemoryKind,
  MemoryListFilter,
  MemoryRecord,
  MessageDto,
  SessionMeta,
  TabKey,
  TestChatResult
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

    gateway: {
      getState: (): Promise<GatewayState> => ipcRenderer.invoke('gateway:getState'),
      configure: (input: GatewayAccountConfig): Promise<ConfigureResult> =>
        ipcRenderer.invoke('gateway:configure', input)
    },

    // ===== 通道选择（DEV_PLAN §5.6；test 替代旧 gateway.testChat，按当前通道探活） =====
    channel: {
      get: (): Promise<ChannelState> => ipcRenderer.invoke(IPC.channelGet),
      saveApi: (cfg: ApiChannelConfig): Promise<ChannelActionResult> =>
        ipcRenderer.invoke(IPC.channelSaveApi, cfg),
      select: (channel: ChannelKind): Promise<ChannelActionResult> =>
        ipcRenderer.invoke(IPC.channelSelect, channel),
      startGateway: (): Promise<ChannelActionResult> => ipcRenderer.invoke(IPC.channelStart),
      stopGateway: (): Promise<ChannelState> => ipcRenderer.invoke(IPC.channelStop),
      test: (message: string): Promise<TestChatResult> => ipcRenderer.invoke(IPC.channelTest, message)
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

    // 'gateway:state' 为阶段 2 遗留通道（不在 IPC 常量表，保持兼容）
    onGatewayState: (cb: (state: GatewayState) => void): (() => void) =>
      onEvent<GatewayState>('gateway:state', cb),

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
    }
  } as unknown as FairyApi & { name: string; version: string })
)
