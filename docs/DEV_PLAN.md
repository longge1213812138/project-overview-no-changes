# Fairy — Windows 私人助手开发总纲

> 项目代号：Fairy
> 目标：Windows 桌面私人助手；MVP 支持 **DeepSeek 网页版**（chat.deepseek.com 会话）与 OpenAI 兼容 API，扩展路线图见阶段 7–11。
> 参考蓝本：[zhu1090093659/deepseek-pp](https://github.com/zhu1090093659/deepseek-pp)（已归档，源码在 `reference/deepseek-pp/`，仅借鉴设计）。
> 文档版本：v0.3（MVP 完成后的扩展路线图）

---

## 目录

1. [需求范围](#1-需求范围)
2. [总体架构](#2-总体架构)
3. [技术选型](#3-技术选型)
4. [目录结构](#4-目录结构)
5. [核心机制设计](#5-核心机制设计)
6. [分阶段实施步骤](#6-分阶段实施步骤)
7. [数据模型](#7-数据模型)
8. [风险与对策](#8-风险与对策)
9. [里程碑计划](#9-里程碑计划)

---

## 1. 需求范围

### 1.1 要做的（MVP 全部）

| # | 功能 | 说明 |
|---|---|---|
| F1 | 简单问答 | 与 DeepSeek 网页版对话，流式输出；**不做**工具调用/Agent |
| F2 | 会话系统 | 多会话、切换/新建/删除、历史本地持久化、上下文裁剪 |
| F3 | 帮我记东西 | 自然语言"记一下 XXX"→ 意图识别 → 存入本地 `memories` 表；随时查（"我之前让你记过什么"） |
| F4 | 日程管理 | 自然语言增/查/改/完成/取消日程；到点托盘通知；日程面板可视管理 |
| F5 | 长期记忆 | FTS5 自动沉淀（关键信息抽取入库）+ 对话时按相关性自动注入 |
| F6 | 桌面形态 | 托盘、`Alt+Space` 浮窗、开机自启 |
| F7 | 登录引导流 | 首次启动 / 会话过期时引导登录 DeepSeek 网页版并接管会话 |

### 1.2 MVP 范围外

以下能力不属于 M0–M4 验收范围；纳入后续阶段规划，须按 §6 的依赖顺序逐步实施：

- 工具循环 / Agent / 本地 Shell 执行
- Skill 系统、MCP、cron 定时引擎

浏览器控制、多模态仍不在当前路线图承诺范围内。MVP 的日程提醒继续使用应用内 `events.remind_at` 轮询；它与后续面向通用任务的 cron 定时引擎是不同能力。

### 1.3 后续能力的产品与安全边界

- **Agent 不等于任意执行**：模型只能提出符合 schema 的工具调用，由 Fairy 的工具注册表和权限策略校验后执行；模型不能直接访问 OS、数据库或 renderer。
- **本地 Shell**：默认仅在当前工作区边界内执行；涉及越界访问或副作用时须先向用户确认。实现阶段必须验证路径规范化、符号链接/重解析点及子进程逃逸等边界；不能可靠约束的命令不得静默执行。
- **Skill / MCP**：均视为可执行扩展或外部工具边界，须有明确来源/启用状态、输入校验、权限说明、生命周期管理和可见错误；信任策略在实现前细化。
- **cron**：无人值守任务不得自动获得交互会话之外的新权限；需预先授权且可撤销。超出既有授权范围的动作应暂停并通知用户，而不是绕过确认。
- **不做云同步与多用户**：本路线图不建设同步服务、账号服务或多租户模式；后续产品继续保持本地单用户边界。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ Fairy Desktop (Electron)                                    │
│  ┌───────────────┐  ┌──────────────────────────────────┐   │
│  │ 浮窗(Alt+Space)│  │ 主窗口：聊天 / 日程 / 记忆 / 设置  │   │
│  │ 快速问答      │  │                                  │   │
│  └──────┬────────┘  └───────────────┬──────────────────┘   │
│         │           IPC            │                         │
│  ┌──────▼───────────────────────────▼───────────────────┐  │
│  │ main 进程：托盘 / IPC 边界 / 工具权限 / 后台任务       │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                 ┌────────▼─────────┐                       │
│                 │ assistant-core     │  (Node，可单测)       │
│                 │ 会话/Agent/工具注册表 │                      │
│                 └───┬─────────┬────┘                       │
│        ┌─────────────┤         ├──────────────┐            │
│  ┌─────▼─────┐  ┌────▼──────┐  ┌─────────────▼─────────┐  │
│  │ LLM 客户端  │  │ SQLite    │  │ 受控工具 / scheduler   │  │
│  │ (流式/工具) │  │ 本地数据   │  │ 日程通知与 cron 分离   │  │
│  └─────┬──────┘  └───────────┘  └────────────────────────┘  │
│        │ OpenAI 兼容 /v1/chat/completions                    │
└────────┼───────────────────────────────────────────────────┘
         ▼
  LLM 网关 sidecar（阶段 1：ds-free-api / deeperseeker，外部进程）
         │  网页会话 = 账号池凭据（网关自动登录，PoW 等由网关内部处理）
         ▼
  chat.deepseek.com（免费网页额度）/ OpenAI 兼容 API
```

上图表达 MVP 架构及本地后续能力方向；当前实际能力与组件以现有代码和 M0–M4 验收记录为准。

后续能力（按阶段启用）：Agent → 工具注册表（本地 Shell / Skill / MCP）；
cron 调用受控 Agent 运行时。产品范围保持本地单用户，不包含云同步、多用户或服务端账号体系。

三条核心设计决策：

1. **MVP 与 Agent 分层演进**：M0–M4 当前只依赖流式聊天和意图解析；后续 Agent 层统一适配模型工具调用格式，LLM 输出的工具调用仍须经本地工具注册表和权限策略。
2. **"记东西 / 日程"走意图解析，不走工具调用**：每条用户消息先做一次**非流式小请求**做意图分类 + 参数抽取（模型返回严格 JSON），命中就写本地 SQLite，再回复；否则直接流式问答。详见 §5.1。
3. **LLM 通道可替换**：assistant-core 只认 OpenAI 兼容 base_url。网页会话（默认，免费）失效时可填官方 API Key 兜底（设置页一个输入框）。

后续 Agent 不直接取代已验证的记忆/日程意图路径；是否迁移某项能力，需在相应阶段用兼容性与安全验收决定。

---

## 3. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 桌面壳 | **Electron 39 + React 19 + Vite + TypeScript** | 当前项目版本；托盘/全局热键/系统通知生态成熟 |
| 核心逻辑 | **Node ≥24.15，纯 TS 包 `packages/core`（不依赖 Electron）** | 全部可 vitest 单测；SQLite 用 better-sqlite3 同步 API |
| LLM 网关 | **ds-free-api（Rust 单文件）作为 sidecar**，备选 deeperseeker（Python） | 单二进制零依赖；Fairy main 进程 `spawn` 管理生命周期 |
| 数据库 | **better-sqlite3**（WAL + FTS5） | 单文件零运维，记忆检索用 FTS5 关键词 + 权重，不引入 embedding |
| 热键/托盘/通知 | Electron 内置 `globalShortcut` / `Tray` / `Notification` | 无额外依赖 |
| 开机自启 | `app.setLoginItemSettings(true)` | 系统级 |
| 打包 | **electron-builder**（NSIS 安装包 + portable 单 EXE） | Windows 标准 |
| 测试 | vitest（core 单测）+ 手动验收清单 | 覆盖核心逻辑；Agent、执行权限与 scheduler 需增加边界/集成验收 |

---

## 4. 目录结构

```
fairy/
├── package.json                 # pnpm workspace
├── apps/
│   └── desktop/                 # Electron
│       ├── src/main/
│       │   ├── index.ts         # 启动、生命周期
│       │   ├── tray.ts          # 托盘 + 菜单
│       │   ├── hotkeys.ts       # Alt+Space 浮窗
│       │   ├── windows.ts       # 浮窗 / 主窗口管理（alwaysOnTop、失焦收起）
│       │   ├── sidecar.ts       # 启停 LLM 网关子进程（随机端口、退出回收）
│       │   ├── notify-loop.ts   # 日程提醒 30s 轮询 → Notification
│       │   └── ipc.ts           # renderer ⇄ main 的 IPC 边界
│       ├── src/preload/
│       └── src/renderer/        # React
│           ├── chat/            # 聊天面板（流式 Markdown；Agent 状态/审批按后续阶段加入）
│           ├── calendar/        # 日程面板
│           ├── memory/          # 记忆面板
│           └── settings/       # 设置：登录引导、通道切换、热键、自启
├── packages/
│   └── core/
│       ├── src/
│       │   ├── llm/            # OpenAI 兼容客户端（流式/中断/重试/会话过期检测）
│       │   ├── intent/         # 意图解析（prompt + JSON 解析 + 校验）
│       │   ├── memory/         # 记忆抽取、FTS5 检索、注入组装
│       │   ├── calendar/       # 日程增删改查 + 自然语言→绝对时间
│       │   ├── sessions/       # 会话/消息存取、上下文裁剪
│       │   └── store/          # SQLite 连接、迁移
│       └── test/
├── docs/
└── reference/deepseek-pp/       # 蓝本（只读）
```

目录树描述的是当前 MVP 结构；注记中的后续模块只是路线图方向，不代表已创建或已定型的代码目录。

---

## 5. 核心机制设计

### 5.1 意图解析（MVP 本地动作入口）

每条用户消息进入聊天流水线：

```
用户消息
  │
  ├─① 意图请求（非流式，1 次小调用）
  │    system: 「你是意图分类器。判断用户想做什么，只输出一个 JSON，
  │             不要解释。当前时间: {now ISO}。
  │             可选 intent: remember | forget | schedule_add |
  │              schedule_done | schedule_cancel | schedule_query | chat
  │             schedule_add 时给出 title 和 remind_at(ISO, 依据当前时间换算
  │             相对表达) 和 notes。全部不命中 → intent:"chat"」
  │    输出: {"intent":"schedule_add","payload":{...}}
  │
  ├─② 命中应用动作 → 写 SQLite → 生成确认语
  │   · remember    → memories(kind='note')
  │   · forget      → 按关键词删除
  │   · schedule_*  → events 增/改/删
  │   · schedule_query → 读 events，把结果塞进下一步 system
  │
  └─③ 回复请求（流式）
       system = 基础人设 + 注入的记忆(top-8 FTS5) + 相关日程 + [日程查询结果]
       → 流式输出；若 ② 命中动作，回复开头带确认语
         （"已帮你记下了 ✓" / "好的，已安排：9/30 09:00 交周报"）
```

要点：

- 意图分类 prompt 短（< 300 token），成本可忽略；**失败兜底**：JSON 解析失败或置信低 → 一律按 `chat` 处理，绝不写脏数据。
- 相对时间（"明天上午"）在意图 prompt 的 system 里注入 `当前时间`，要求模型直接换算出 ISO 绝对时间；解析后校验 `remind_at` 合法性，非法则追问一次（最多 1 次）。
- 每用户消息 LLM 调用次数：**常规 2 次**（意图 + 回复）；纯闲聊也 2 次（意图判为 chat 后照发回复请求）。若嫌浪费，后续可加关键词快车道（"记一下/提醒我/日程"开头直接走意图，省 1 次）——作为优化项，MVP 不做。

### 5.2 记忆（FTS5 自动沉淀 + 注入）

**沉淀（自动）**：仅在两种时机触发，省额度——

1. 意图为 `remember` 时：原文直接入库（kind=`note`）；
2. 每次会话结束 / 空闲 5 分钟：发 1 次非流式"记忆抽取"请求：

```
system: 「从以下对话中抽取值得长期记住的信息：用户偏好、事实、决定、
        项目背景。没有就输出 []。只输出 JSON 数组：
        [{"kind":"preference|fact|decision|topic","content":"一句话"}]」
```

**注入（自动）**：发起回复前，对用户消息做 FTS5 检索（`LIKE + bm25` 排序，top-8，按 kind 加权：preference 1.0 / fact 0.9 / note 0.8 / topic 0.7，时间衰减 ×0.95^days），拼进 system：

```
【关于这个用户】
- 喜欢简洁回答（preference, 9/15）
- 在写 Fairy 项目，Electron 技术栈（topic, 9/20）
```

**记忆面板**：列表（kind 筛选）、手动增删改、导出/导入 JSON。

### 5.3 日程（events + 应用内通知）

- 增改删走 5.1 的意图；面板里也可手动操作。
- 通知：main 进程 `notify-loop.ts` 每 30s 查 `events WHERE remind_at <= now AND fired=0 AND done=0`，命中 → 系统通知（标题+内容，点通知打开主窗口日程 tab），置 `fired=1`。Fairy 关闭时（退出托盘不退出）通知不触发——MVP 接受，退出前弹提示"有未触发的日程"。
- 查询：`schedule_query` 按时间窗（今天/明天/本周/全部）读库，结果注入 system 让模型自然语言总结。

### 5.4 会话系统与上下文裁剪

- `sessions` / `messages` 表；浮窗默认使用"快速会话"（固定 session），主窗口可管理全部会话。
- 裁剪策略：system + 最近 N 条消息；总预算约 6000 token（按 1 token ≈ 1.5 字符估算），超预算从最旧开始丢弃（保留 system 与用户明确要保留的内容）。MVP 不做摘要式压缩。

### 5.5 登录引导流（F7）

1. **触发**：首次启动、或 LLM 客户端命中会话过期指纹（持续 429 `overloaded`，见 `docs/llm-bridge-notes.md` §4）、或网关日志登录失败扫描（`RISK_DEVICE_DETECTED` / `USER_IS_BANNED` / `user is muted`）→ 托盘红色 + 设置页弹引导卡。
2. **步骤**（设置页内图文引导，每步一个按钮；账号池版，不再收 cookie）：
   - a. `shell.openExternal('https://chat.deepseek.com')` 用系统浏览器打开页面（取设备指纹用，**无需登录**）；
   - b. F12 → Console 执行 `copy(SMSdk.getDeviceId())` 复制设备指纹（设备级，同机器多账号可复用，一次获取长期有效，见 `llm-bridge-notes` §1）；
   - c. 填写账号（邮箱/手机号）/密码/device_id → 写配置 → 重启 sidecar → `GET /health` 探活 + 测试对话 → 完成。
3. **配置存放**：凭据现存于 `%APPDATA%/fairy/secrets.dpapi.json`，通过 Electron `safeStorage`（Windows DPAPI）保护；`config.json` 只保存非敏感配置。早期 MVP 的明文配置由阶段 6 迁移逻辑兼容处理。

### 5.6 通道选择（OpenAI 兼容 API / DeepSeek 网页）

1. **启动不自动登录（硬规则）**：应用启动不 spawn 网关、不发生任何 DeepSeek 网页登录；是否联网、走哪条通道由用户在设置页显式决定。
2. **通道持久化**：`config.json` 增加 `channel: 'api' | 'web' | null` 与 `api: { baseUrl, apiKey, model }`。
   - `channel = null`（首启/本节上线后升级）→ 设置页展示双通道选择卡：
   - **OpenAI 兼容 API**：baseUrl（默认 `https://api.deepseek.com/v1`）+ API Key + model（默认 `deepseek-chat`）→ 保存即启用；聊天/意图/抽取全部直连该端点，不启动网关（可接官方 DeepSeek API 或任意 OpenAI 兼容端点）。
   - **DeepSeek 网页**：走 §5.5 账号引导流；选中后需点击「启动网关」才 spawn+登录，**每次启动 Fairy 均需手动点一次**（启动后会话期间保持运行）。
3. **切换规则**：切到 api 会自动停止运行中的网页网关（避免后台登录）；切回 web 不自动启动；已在运行时保存账号 → 网关热重启应用新配置。
4. **测试对话按当前通道执行**；会话过期指纹（§5.5 / llm-bridge-notes §4，持续 429 overloaded）仅对网页通道生效，API 通道的 429 走常规退避。

### 5.7 Agent 与工具循环（后续阶段）

- **通道范围（2026-10-03 用户决定）**：工具调用仅走 **API 通道**并以其为验收通道；web 通道不做 tools 适配与测试（保留原有聊天功能）。会话已注册工具而激活通道为 web 时，必须向用户给出明确的「当前通道不支持工具调用」能力提示，不得静默降级为无工具聊天。
- 对话运行时可消费模型返回的工具调用，按「校验 → 权限判定/用户审批 → 执行 → 结果回传模型」循环；每轮、总轮数、耗时、输出大小与并发均须有上限，且可取消、可观测、可测试。
- 工具由 main/core 侧注册表持有强类型 schema、风险级别、权限需求和执行器。renderer 只展示状态与审批 UI，不直接执行工具；LLM 输出视为不可信输入。
- 工具错误应明确回传并保留失败状态；超时、取消、模型异常和进程退出不能伪装成成功。
- 本地 Shell 默认受限于当前工作区。实现前需验证 Windows 可用的 OS 级隔离方案，覆盖路径逃逸、符号链接/重解析点、子进程与环境继承；目录作为 cwd 不足以构成安全边界。确需越界时先确认，无法可靠隔离/确认的操作拒绝执行。
- 模型/网页内容可能包含 prompt injection。工具权限由代码策略而非模型文字授予；高影响或不可逆操作需单独审批。

### 5.8 Skill 与 MCP（后续阶段）

- Skill 是有版本、来源、输入约束和权限声明的能力包；加载后仍须经统一工具注册表和权限判定，不能自行绕开审批。
- MCP 是外部服务/进程提供工具的协议适配层。连接、断开、超时、协议错误和服务退出需可见；工具 schema 与返回值须验证，默认不把凭据交给未授权服务。
- Skill 和 MCP 的信任/分发策略、沙箱等级及凭据访问政策需在实现前细化；默认禁用新来源的自动安装或自动执行。

### 5.9 cron 定时引擎（后续阶段）

- 与日程提醒（§5.3）分开建模：日程是用户可见的一次性提醒；cron 是可重复触发的自动化任务。
- 任务定义与运行记录持久化，计划处理时区/DST、错过触发、重启恢复、重复防护、并发、失败重试与取消。
- 定时执行复用 Agent 和工具权限策略；只允许事先授权的操作。需要交互确认的动作不能在无人值守时自动放宽权限，须暂停任务并通知用户。

---

## 6. 分阶段实施步骤

> 每阶段：**目标 → 步骤 → 验收**。阶段 1 结束 = 终端 curl 通；阶段 3 结束 = 可用的聊天助手；阶段 4/5 = 记忆与日程成形；阶段 6 = MVP 打包硬化。阶段 7 起为 MVP 后续规划，不代表已经实现。

### 阶段 0：脚手架（0.5 天）

1. Node ≥24.15（兼容 npm 12 支持区间 `^22.22.2 || ^24.15.0 || >=26.0.0`；本机已装 24.21.0 于 `C:\Users\91533\.fairy-tools\node24` 并置于用户 PATH 最前）+ pnpm；workspace：`apps/desktop`（Electron+React+Vite，可用 `electron-vite` 模板）、`packages/core`。
2. Electron 最小化跑通：窗口 + 托盘；`electron-builder` 能打出 NSIS 包。

**验收**：`pnpm dev` 出窗口；安装包在干净系统可装可跑。

### 阶段 1：LLM 桥接通（0.5-1 天）★先打通

1. 二选一跑起来（**只需支持流式 chat completion，不要求 tools**，门槛大幅降低）：
   - ds-free-api（Rust 单文件）：账号池（邮箱/手机号 + 密码 + device_id）自动登录，写进配置 `[[ds_core.accounts]]` 段 → `ds-free-api -c config.toml` → 监听 `127.0.0.1:22217`；（v0.2.11 起不再收 cookie，详见 docs/llm-bridge-notes.md §1）；
   - deeperseeker（Python）：按其 README 注入 cookie → `:8000/v1`。
2. curl 验证：

   ```bash
   curl -N http://127.0.0.1:22217/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"default","stream":true,
          "messages":[{"role":"user","content":"一句话说说你是谁"}]}'
   ```

3. **记录到 `docs/llm-bridge-notes.md`**：model 取值（default/expert…）、会话过期时的**报错指纹**（HTTP 码 + 响应体特征，供 5.5 的过期检测用）、限速特征。

**验收**：拿到流式回复；过期指纹有书面结论。

### 阶段 2：sidecar 化 + 登录引导流（1-2 天）

1. `main/sidecar.ts`：Fairy 启动时 `spawn` 网关（端口随机、配置含账号凭据（账号/密码/device_id）），退出时 kill 并回收（防 Windows 僵尸进程）；health 轮询（`GET /health`）。
2. `packages/core/llm`：OpenAI 兼容客户端——流式解析、`AbortController` 停止、4xx 指数退避重试（≤3）、**过期指纹匹配 → 抛 `SessionExpired` 事件**给 main。
3. 设置页实现 5.5 引导流（填账号/device_id → 写配置 → 重启 sidecar → 探活 → 完成态）。

**验收**：清掉旧进程场景：会话过期/登录失败时托盘变红 + 设置页出引导卡，按引导重新保存账号凭据后可继续对话；验收手段：设置页「测试对话」按钮端到端探活（本阶段替代完整聊天 UI）。

### 阶段 3：会话系统 + 聊天 UI（2-3 天）

1. `core/sessions` + SQLite（`sessions`/`messages`，WAL）；上下文裁剪（§5.4）；会话 CRUD。
2. 聊天 UI：流式 Markdown（react-markdown + 代码高亮）、停止按钮、新建/切换/删除会话、空态。
3. 浮窗 + 主窗口双形态（`main/windows.ts`）：
   - 浮窗：无边框 380×560、`alwaysOnTop`、`Alt+Space` 开合、`Esc`/失焦收起；仅聊天 tab（快速会话）；
   - 主窗口：聊天 + 底部 tab（日程/记忆/设置，先留占位）。

**验收**：热键唤起浮窗问答；主窗口切换 10 个会话；重启 Fairy 历史会话完整。

### 阶段 4：记忆（2-3 天）

1. `core/memory`：入库（remember 意图直存 + 会话空闲抽取，§5.2）、FTS5 建表与检索（bm25 + kind 权重 + 时间衰减）、注入组装。
2. 意图解析管线接入（§5.1，`remember`/`forget` 两个意图先行）。
3. 记忆面板：列表 / 筛选 / 增删改 / 导出导入。

**验收**：
- 说"记住：我喝美式不加糖" → 确认语 → 次日开新会话问"我咖啡怎么喝"，答对；
- 记忆面板删掉该条后立刻失效；
- 抽取质量抽查 20 轮对话，误入库率可接受（可调 prompt，留好回归样本）。

### 阶段 5：日程（2-3 天）

1. `core/calendar` + `events` 表；意图 `schedule_add/done/cancel/query`（§5.1/5.3），`remind_at` 合法性校验 + 一次追问。
2. `main/notify-loop.ts`：30s 轮询 → `Notification`（点通知开主窗口日程 tab）→ `fired=1`；退出时未触发日程提示。
3. 日程面板：今天/明天/全部列表、勾选完成、手动增删（与对话操作同数据）。

**验收**：
- "明天上午十点提醒我交周报" → 确认语含正确绝对时间；到点系统通知出现；
- "周报完成了" / "把明天所有提醒取消" → 正确操作；
- 面板与对话数据实时一致。

### 阶段 6：打包 + 硬化（1-2 天）

1. NSIS（开机自启选项默认勾选）+ portable 单 EXE；`app.setLoginItemSettings` 生效。
2. 账号凭据（账号 + 密码 + device_id）存 DPAPI（`@kingsu/windows-dpapi` 或自调 `CryptProtectData`），旧明文自动迁移。
3. 日志（electron-log，滚动 7 天）+ 一键诊断导出（版本/系统信息，不含账号凭据）。
4. （可选，以后再说）自建 LLM 网关替换 sidecar：参考 `reference/deepseek-pp/core/deepseek/{pow.ts,request-codec.ts,stream-codec.ts}`——**MVP 不排期**，仅在 sidecar 停更/被禁时启动。

**实施备注（2026-10-02 已落地）**：
- ② DPAPI 走 Electron `safeStorage`（win32 下即 `CryptProtectData`）：零原生依赖（本机无 VS Build Tools，且 npm 上并无 `@kingsu/windows-dpapi`）；密件单独存 `secrets.dpapi.json`，`config.json` 只剩非敏感字段；`safeStorage` 不可用时降级明文并在诊断报告如实标注 `secretsProtected:false`。
- ①「默认勾选」= NSIS 自定义安装选项页（`apps/desktop/resources/installer.nsh`；`/S` 静默安装也按默认开启）；**Run 值名必须是 AUMID `com.fairy.assistant`**（实测 Electron 39：值名不匹配时 `openAtLogin` 恒 false，只有 `executableWillLaunchAtLogin` 为 true），应用侧 `app.setLoginItemSettings` 传同一 `name`。
- 网关二进制随包分发：`scripts/stage-extras.mjs` 预置 `resources/ds-free-api/`（不入 git；绝不复制 `config.toml`），`extraResources` 带进安装包/免安装包。

**验收**：干净虚拟机从安装到完成首次登录 < 10 分钟；开机自启后托盘自动出现且日程提醒不丢失（错过的标"已过期"不补弹）。

### 阶段 7：Agent 工具运行时与本地 Shell

> **通道范围（2026-10-03 用户决定）**：本阶段 tools 适配、能力探测与验收**只走 API 通道**；web 通道不做 tools 适配与测试（保留原有聊天功能，MVP 聊天验收清单不受影响）。激活通道为 web 而会话已注册工具时，必须给出明确能力提示，不做成功形状的静默降级。

1. 复核 API 通道对工具调用的支持差异，定义统一的工具调用/结果类型、循环状态、取消和错误语义；不支持工具调用的通道须有明确能力提示，不做成功形状的静默降级。
2. 实现有界工具循环和工具注册表；工具输入严格 schema 校验，执行结果、安全决策和失败状态可追踪。
3. 实现审批与权限策略；本地 Shell 默认限制在当前工作区，越界操作先确认。选用并验证真正可用的 Windows 隔离边界；无法证明安全的命令拒绝执行。

**验收**：模拟工具可完整往返多轮；模型伪造参数、循环超限、超时和取消均正确失败/终止；未经授权的工具不会执行；Shell 不能逃逸工作区或启动脱离管控的子进程；越界操作需得到明确确认；renderer 无直接 OS 执行能力。端到端验收在 API 通道完成；web 通道不参与阶段 7 工具调用测试。

**实施备注（2026-10-03 已落地）**：
- **能力探测**：`probeToolsSupport`（`core/agent/capability.ts`）两段探测（`tool_choice:required` → 必要时降级 `auto`），三态 `supported/unsupported/unknown`；同 baseUrl+model 只探一次（`main/agent-tools.ts` 缓存）。`unsupported` → 本轮不带 tools 且 `chatDone.capabilityHint` 明示原因（不静默降级）；`unknown` → 带 tools 尝试，失败即可见错误。实测 `apihub.agnes-3.0-flash = supported（required 一次通过）`。web 通道按范围决定：不探测、不带 tools、恒回传 hint。
- **注册表与授权链**：`ToolRegistry`（schema/risk/approval/source/assess）→ `createRegistryAuthorizer`（未注册/策略 deny/需确认而无审批通道 → 一律默认拒绝；审批 60s 超时 = 拒绝）→ `execute` 拿 `ctx.allowOutside` 二次校验（防御纵深）。内置工具三个：`get_current_time`（read/ask）、`workspace_files`（read，越界 ask）、`shell`（exec，恒 ask）。
- **Shell 边界（如实声明）**：本机无 VS Build Tools、无法上原生隔离，采用**白名单 + 路径边界 + 进程管控组合，非 OS 级沙箱**：① 正向白名单 9 个只读单进程命令（whoami/hostname/ipconfig/systeminfo/tasklist/findstr/fc/where/tree）+ 危险命令显式拒绝名单先查，命令名禁止含路径；② 参数逐个过 `resolveWorkspacePath`（realpath 解 junction/symlink；UNC/设备路径/盘符相对/`%VAR%` 展开一律拒绝；工作区外 → 越界审批）；③ `spawn` 不经 shell、cwd=工作区、最小 env（SystemRoot/windir/PATH=System32/TEMP/TMP，不泄漏宿主环境）、输出 10 万字符截断、signal/超时杀进程。残余风险：获批越界参数下白名单工具的只读访问（由审批显式覆盖）；cmd/powershell/node 等可派生任意代码的命令永不可放行。
- **审批 IPC**：`agent:approvalRequest/Settled/Respond` + `agent:toolNotice`；广播全窗口、首响应生效；停止/退出 `cancelAllPending`；浮窗 Esc 豁免（有 pending 时 Esc = 审批拒绝而非收窗）；全部决策 `log.info('[approval]'/'[tool]')` 可追踪。renderer 对话框：默认焦点=拒绝、Esc=拒绝、无「全部允许」、越界红条警告。
- **端到端验收（真实 API 通道 4/4）**：probe `supported(required)` → 双工具（get_current_time→shell）多轮 `requested→started→completed` 往返 → `confirm=false` 单 `denied` 零执行 → shell `whoami` 真实 stdout。凭据经 `scripts/unlock-e2e-config.cjs`（Electron+DPAPI 解密到临时文件，key 不落日志）；测试 `core/agent/e2e.api.test.ts`（`FAIRY_E2E_CONFIG` 门控，默认 skip 可复跑）。
- **renderer 隔离验收**：`entry-isolation.test.ts` 断言 `index.web` 不导出任何执行器；打包 bundle 实测无 `child_process`/`createBuiltinTools`（仅契约字符串）。
- **修复与发现**：① LLM client endpoint 归一：`baseUrl` 已含 `…/v1/chat/completions` 完整路径时不再二次拼接（E2E 发现的真实配置形态，否则 404）；② Electron `safeStorage` 的 DPAPI 熵**绑定 app name**——应用 dev/打包均 `productName:Fairy` 故互通，任何外部解密辅助脚本必须 `app.setName('Fairy')`；③ `AgentToolEvent.denied.reason` 与 `AgentToolNotice.error` 字段名差异由 main 侧映射。

### 阶段 8：Skill 与 MCP

1. 基于阶段 7 工具契约实现 Skill 的发现、启用/禁用、版本与来源校验、权限声明及失败可见性。
2. 实现 MCP 客户端生命周期与工具 schema/结果校验；服务连接配置和凭据按最小权限管理。
3. 所有扩展通过统一注册表和权限策略，补充恶意/异常输入、服务断开与版本不匹配测试。

**验收**：获准 Skill/MCP 工具可调用并展示来源与所需权限；未启用/未授权扩展不可执行；错误、断连、无效 schema 与取消均清晰反馈且不泄露凭据。

**实施备注（2026-10-04 已落地，代码完成待 GUI 人工验收）**：
- **Skill 包格式**：`%APPDATA%/fairy/skills/<目录>/skill.json`（schemaVersion=1：name / version(semver) / description / **source 必填** / permissions / tools[{name, description, risk, inputSchema, entry, timeoutMs}]）。本地手工放置，**应用不提供任何网络安装路径**；未知顶层键/工具键、子集外 schema 关键字、非法 entry 路径（..、绝对路径、盘符、UNC、非 .js/.mjs/.cjs）→ **整包拒绝且错误可见**（fail-visible，绝不静默少校验）。
- **信任/启用策略（§5.8 细化）**：新发现**默认禁用**；启用时记录内容指纹 `sha256(manifest + 各 entry 脚本)`，包内容一变即**自动回禁用**（标记「内容已变更」）需用户重新启用——供应链防篡改。状态存 config.json `skills` 明文字段（无凭据）；启用/禁用/重扫即时装配进统一 ToolRegistry 并广播 `skills:changed`。
- **执行边界（如实声明，非 OS 级沙箱）**：entry 为 Node 脚本，经 **electron-as-node**（`ELECTRON_RUN_AS_NODE=1` 定向注入，与附录 C「意外继承」陷阱相反的刻意用法）`spawn` 执行：无 shell、cwd=工作区、最小 env + `FAIRY_SKILL_DIR/FAIRY_WORKSPACE_DIR/FAIRY_TOOL_NAME`、超时（1000–60000ms，默认 10s）、stdout+stderr 10 万字符截断、支持取消。**安全边界 = 默认禁用 + 指纹启用确认 + 每次调用审批（approval 恒 ask，v1 不提供 auto 通道）+ 进程管控**；凭据零注入（应用凭据永不进入子进程 env）。
- **入参/结果契约**：`inputSchema` 必须 `type:"object"` 且只支持 JSON Schema 子集（type/properties/required/additionalProperties/items/minItems/maxItems/minLength/maxLength/minimum/maximum/enum/const/pattern；注解关键字忽略）——子集外关键字在加载期即拒绝。execute 前 assess+validateInput 双重校验（拒绝原因可见）。脚本协议：stdin 收一行 `{tool, input}` JSON → stdout 打印**单个 JSON 值**且退出码 0（调试输出走 stderr；非 JSON/非零退出/超时均抛可见错误）。
- **审批/展示**：`definition.description` 尾部附 `来自 Skill「名 vX」· 来源 · 声明权限`（审批对话框与模型看到同一份来源信息）；`source='skill'` 显示「扩展」徽标。**权限声明是作者自述**，用于展示与启用认知，不构成运行时强制（无 OS 沙箱事实下唯一硬边界是逐次审批）。
- **MCP stdio 客户端**：JSON-RPC 2.0 行协议（换行分隔）；连接 = spawn → initialize（protocolVersion 2024-11-05）→ notifications/initialized → tools/list，各 10s 超时；tools/call 60s 超时且支持取消（本地拒绝——外部进程副作用不可中断，正是必须逐次审批的原因）；收到服务端反向请求回 -32601 Method not found（不让服务端干等）；非法消息行/缓冲超限计入 `protocolIssues` 可见；意外退出 → state=error + stderr/exit code 可见 + `mcp:changed` 广播；断开/退出 **taskkill /T /F 树杀**防孤儿进程。
- **MCP 工具策略**：**approval 恒 ask + risk 恒 exec**（外部服务能力不可验证，取最保守徽标，不给「只读」错觉）；入参按服务端 inputSchema **宽松校验**（我方子集生效、子集外关键字忽略——绝不因不支持而空校验）；返回值结构**严格校验**（content 块数组 / type 字符串 / text 块必须带 text / isError 布尔）。工具名与现有注册冲突 → 跳过该工具并记可见警告（连接不断；与 skill 整包拒绝语义区分：服务是长驻连接资源）。
- **MCP 配置与凭据**：config.json 明文只存 name/command/args/cwd；**env（可能含 token）走 DPAPI 密件**（与 api.apiKey 同一模式），renderer 仅回显 KEY 名、日志/诊断天然无凭据。**用户驱动连接，不自动连接**任何外部进程（=「默认不把凭据交给未授权服务」）。子进程 env = 最小 env + **宿主 PATH**（外部命令发现需要，与内置 shell 工具刻意不同，此处明确声明）+ USERPROFILE/HOME + 配置 env；命令行不经 shell（Windows 下运行 npx/uvx 类脚本请显式配置 `cmd /c` 或 node 绝对路径）。
- **入口隔离**：skill/mcp 全部执行面（`runSkillTool/discoverSkills/McpClient/buildMcpRegistrations/killTree` 等）只从 `@fairy/core` 完整入口导出，`entry-isolation.test.ts` 断言不进 index.web/renderer。
- **测试**：skill 41 项（manifest 严格解析 / schema 子集 / 发现+指纹 / executor 真实子进程含超时取消截断 / builder 安全不变量 / 入口隔离）+ mcp 17 项（protocol 行编解码 / 假服务器 fixture 端到端：反向请求闸门、崩溃退出可见、超时、断连挂起拒绝、坏结构拒绝 / builder）。**GUI 验收样例**：`examples/skills/demo-echo`（技能包，含 README 验收步骤）与 `examples/mcp-demo-server.js`（演示 MCP 服务，注释含添加参数）。

### 阶段 9：cron 定时引擎

1. 为重复任务与执行历史建模，采用确定性幂等 schema migration；定义时区/DST、错过触发、重启恢复、并发和失败策略。
2. scheduler 持久化调度状态，重启后恢复且避免重复执行；运行任务使用阶段 7 的 Agent、工具权限与可观测状态。
3. 提供任务查看、暂停、恢复、编辑和删除入口；区分 cron 自动化任务与 §5.3 的日程提醒。

**验收**：重启、时区变化、错过触发、重复触发与执行中退出均按已确认语义工作；重复/并发不会造成重复副作用；超出预授权权限的任务暂停并通知，不会绕过交互审批。

## 7. 数据模型

**当前 MVP 及后续路线**使用单文件 SQLite：`%APPDATA%/fairy/fairy.db`（WAL）。Agent/工具循环和 cron 需通过确定性、幂等 migration 扩展本地 schema；产品保持本地单用户，不建设云同步或多用户服务端 schema。

```sql
CREATE TABLE sessions(
  id TEXT PRIMARY KEY,            -- uuid
  title TEXT, kind TEXT DEFAULT 'chat',   -- chat | quick
  created_at INT, updated_at INT
);
CREATE TABLE messages(
  id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,
  content TEXT, meta TEXT,        -- JSON: intent 结果、token 数、耗时
  created_at INT
);
-- 记忆
CREATE TABLE memories(
  id INTEGER PRIMARY KEY,
  kind TEXT,                       -- preference | fact | note | decision | topic
  content TEXT,
  source_session TEXT, weight REAL DEFAULT 1.0,
  created_at INT, updated_at INT
);
CREATE VIRTUAL TABLE memory_fts USING fts5(content, content='memories',
  content_rowid='id');
-- 日程
CREATE TABLE events(
  id INTEGER PRIMARY KEY,
  title TEXT, notes TEXT,
  remind_at INT,                  -- epoch ms
  done INT DEFAULT 0, fired INT DEFAULT 0,
  created_at INT
);
-- 设置
CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT);
```

约束（沿用蓝本的 schema invariant）：schema 变更必须带**确定性、幂等** migration；未知版本 fail-visible，绝不覆盖用户数据。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| DeepSeek 网页改版导致 sidecar 失效 | LLM 层隔离，官方 API 兜底（设置页填 Key）；关注蓝本/社区；终极手段 = 阶段 6 的可选项（自建网关） |
| 账号风控/封号 | MVP 保持本地、单用户、低频（消息 ≈ 2 次调用）；全部数据本地化，封号后换通道数据不丢；UI 明示风险 |
| 账号凭据失效无感知 | 过期指纹（持续 429 `overloaded`）+ 网关日志登录失败扫描（RISK_DEVICE_DETECTED/USER_IS_BANNED/muted）→ 托盘红色 + 引导流一键重配（见 llm-bridge-notes §4） |
| 意图误判写脏日程 | JSON 校验 + `remind_at` 合法性 + 确认语可一键撤销（"没有/取消了"再一句即回滚） |
| 凭据保护不可用或旧配置迁移失败 | Electron `safeStorage` 保护凭据；迁移失败须明确报错，诊断标记保护状态，不得静默丢弃或伪报成功 |
| Electron 冷启动慢 | 主进程常驻托盘；浮窗窗口启动时预建隐藏（show 即出） |
| 关着 Fairy 日程错过 | 退出前提示 + 重开时过期日程标"已过期"（不补弹，避免惊吓） |
| Agent 受 prompt injection 诱导执行工具 | LLM 输出视为不可信；工具 allowlist、schema 校验、风险分级和代码侧权限判定；高风险操作显式审批 |
| Shell / MCP / Skill 越权或供应链风险 | 工作区 OS 级隔离、最小权限、来源/版本校验；无法验证边界时拒绝执行，外部服务不得默认获得凭据 |
| cron 无人值守造成重复或超权副作用 | 幂等运行记录、并发/重试上限、预授权能力集；超出范围暂停并通知，不自动放宽权限 |

---

## 9. 里程碑计划

| 里程碑 | 内容 | 工期 | 累计 |
|---|---|---|---|
| M0 | 阶段 0-1：curl 通 DeepSeek 网页会话 | 1-1.5 天 | ~1.5 天 |
| M1 | 阶段 2-3：sidecar + 登录流 + 会话系统 + 双窗口（**可用聊天助手**） | 3-5 天 | ~1 周 |
| M2 | 阶段 4：记忆（自动沉淀 + 注入 + 面板） | 2-3 天 | ~1.5 周 |
| M3 | 阶段 5：日程（意图 + 通知 + 面板） | 2-3 天 | ~2 周 |
| M4 | 阶段 6：打包、自启、DPAPI、日志（**日常可用版**） | 1-2 天 | ~2.5 周 |
| M5 | 阶段 7：Agent 工具运行时 + 经安全验证的本地 Shell（tools 仅 API 通道） | 待阶段设计评估 | — |
| M6 | 阶段 8：Skill + MCP 接入 | 待阶段设计评估 | — |
| M7 | 阶段 9：持久化 cron 定时引擎 | 待阶段设计评估 | — |

> M0–M4 对应 MVP 里程碑；M5–M7 为本地能力扩展。完成并验收后再打相应 git tag。任意阶段中断，应能回退到上一个已验收的可用状态。

---

## 附录：蓝本阅读建议（动手前 1 小时，只读这些）

1. `reference/deepseek-pp/README.md` 的"核心功能/记忆系统"段——确认交互命名一致；
2. `reference/deepseek-pp/AGENTS.md` 中 schema migration 与 automation lease 两段——迁移规则适用于各阶段；automation lease 可为阶段 9 的调度并发/恢复设计提供参考，不直接照搬；
3. `reference/deepseek-pp/core/deepseek/contracts.ts` 与 `request-codec.ts` 路由表（仅当将来做自建网关时精读，当前阶段 1 用现成 sidecar，**可跳过**）。

---

## 附录 C：本机开发环境备忘（阶段 0 实测）

1. **Node**：系统默认 Node 24.14.0 不在 npm 支持区间；新版 Node 24.21.0 装在 `C:\Users\91533\.fairy-tools\node24\node-v24.21.0-win-x64`（已置于用户 PATH 最前，新终端生效；pnpm 全局装在该 node 目录下，`pnpm.cmd` 可直接调）。
2. **`ELECTRON_RUN_AS_NODE=1` 陷阱**（重点）：部分开发终端环境会继承该变量——electron 会退化为纯 Node 运行：`require('electron')` 返回二进制路径字符串、无 GUI、无 API，症状极难排查。`pnpm dev` 脚本已内置 `set ELECTRON_RUN_AS_NODE=`；手动跑 electron 二进制时也要 unset。
3. **网络**：github.com 直连不通；electron 二进制与 electron-builder 工具走镜像：`ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/`、`ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/`。本机 HTTPS 走代理 MITM，node 侧需 `NODE_OPTIONS=--use-system-ca`。
4. **打包命令**（electron-builder 会探测 pnpm 路径，需先让新 node 进 PATH）：
   ```bat
   set PATH=C:\Users\91533\.fairy-tools\node24\node-v24.21.0-win-x64;%PATH%
   set ELECTRON_RUN_AS_NODE=
   set NODE_OPTIONS=--use-system-ca
   set ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/
   set ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/
   pnpm package:win
   ```
   `pnpm package:win` = `stage-extras`（预置网关二进制）→ `electron-vite build` → `electron-builder --win`；
   产物：`apps/desktop/release/Fairy Setup <版本>.exe`（NSIS）+ `Fairy-<版本>-portable.exe`（免安装单 EXE）。
5. `reference/deepseek-pp` 是嵌套 git 仓库（gitlink），仅为本地参考，不参与 Fairy 构建。
6. 阶段 0 产物：`pnpm dev` 窗口+托盘正常；`release/Fairy Setup 0.0.1.exe`（NSIS，94MB）已验证可生成。
7. **工具陷阱**：`npx asar extract-file <app.asar> package.json` 会把内容**写到当前目录**——曾把 `apps/desktop/package.json` 整个覆盖成打包精简版（scripts/devDependencies 丢失 → pnpm 顺手把 lockfile 裁掉 2800 行）。解包/检查产物请先 `cd` 到临时目录。
