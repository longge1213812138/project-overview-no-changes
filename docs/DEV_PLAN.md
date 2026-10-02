# Fairy — Windows 私人助手开发文档（MVP）

> 项目代号：Fairy
> 目标：Windows 桌面私人助手，以 **DeepSeek 网页版**（chat.deepseek.com 会话）为 LLM 后端，零 API 成本。
> 参考蓝本：[zhu1090093659/deepseek-pp](https://github.com/zhu1090093659/deepseek-pp)（已归档，源码在 `reference/deepseek-pp/`，仅借鉴设计）。
> 文档版本：v0.2（按需求收敛范围重写）

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

### 1.2 明确不做的

- ❌ 工具循环 / Agent / 本地 Shell 执行（蓝本的 tool-loop、shell-host 全部不用）
- ❌ Skill 系统、MCP、浏览器控制、云同步、多模态、定时任务 cron 引擎
- ❌ 多用户、服务端部署。单机单用户，数据全在本地 SQLite。

> 日程的"到点提醒"是**应用内计时器**（查 `events.remind_at` 字段），不是 cron 任务引擎，实现成本 ≈ 1 个 30 秒轮询循环。

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
│  │ main 进程：托盘 / 热键 / 通知轮询 / sidecar 生命周期    │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                 ┌────────▼─────────┐                       │
│                 │ assistant-core     │  (Node，可单测)       │
│                 │ 会话/意图/记忆/日程 │                       │
│                 └───┬─────────┬────┘                       │
│        ┌─────────────┤         ├──────────────┐            │
│  ┌─────▼─────┐  ┌────▼──────┐  ┌─────────────▼─────────┐  │
│  │ LLM 客户端  │  │ SQLite    │  │ 通知循环(30s 轮询)     │  │
│  │ (流式)      │  │ 全部数据   │  │ → Electron Notification│ │
│  └─────┬──────┘  └───────────┘  └────────────────────────┘  │
│        │ OpenAI 兼容 /v1/chat/completions                    │
└────────┼───────────────────────────────────────────────────┘
         ▼
  LLM 网关 sidecar（阶段 1：ds-free-api / deeperseeker，外部进程）
         │  网页会话 = 账号池凭据（网关自动登录，PoW 等由网关内部处理）
         ▼
  chat.deepseek.com（免费网页额度）
```

三条核心设计决策：

1. **LLM 只用裸聊天接口**：因为砍掉工具循环，Fairy 对后端的要求降级为"支持流式 `/v1/chat/completions` 即可"，`tools` 参数不再是硬性要求（选网关时门槛大降）。
2. **"记东西 / 日程"走意图解析，不走工具调用**：每条用户消息先做一次**非流式小请求**做意图分类 + 参数抽取（模型返回严格 JSON），命中就写本地 SQLite，再回复；否则直接流式问答。详见 §5.1。
3. **LLM 通道可替换**：assistant-core 只认 OpenAI 兼容 base_url。网页会话（默认，免费）失效时可填官方 API Key 兜底（设置页一个输入框）。

---

## 3. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 桌面壳 | **Electron 31 + React 18 + Vite + TypeScript** | 托盘/全局热键/系统通知生态最成熟 |
| 核心逻辑 | **Node ≥24.15，纯 TS 包 `packages/core`（不依赖 Electron）** | 全部可 vitest 单测；SQLite 用 better-sqlite3 同步 API |
| LLM 网关 | **ds-free-api（Rust 单文件）作为 sidecar**，备选 deeperseeker（Python） | 单二进制零依赖；Fairy main 进程 `spawn` 管理生命周期 |
| 数据库 | **better-sqlite3**（WAL + FTS5） | 单文件零运维，记忆检索用 FTS5 关键词 + 权重，不引入 embedding |
| 热键/托盘/通知 | Electron 内置 `globalShortcut` / `Tray` / `Notification` | 无额外依赖 |
| 开机自启 | `app.setLoginItemSettings(true)` | 系统级 |
| 打包 | **electron-builder**（NSIS 安装包 + portable 单 EXE） | Windows 标准 |
| 测试 | vitest（core 全量单测）+ 手动验收清单 | 不引入 UI 自动化，MVP 够用 |

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
│           ├── chat/            # 聊天面板（流式 Markdown、工具无）
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

---

## 5. 核心机制设计

### 5.1 意图解析（代替工具循环的关键）

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
3. **配置存放**：`%APPDATA%/fairy/config.json`（MVP 明文 + 文件权限；硬化阶段再上 DPAPI，见 §8；保护对象 = 账号 + 密码 + device_id）。

### 5.6 通道选择（OpenAI 兼容 API / DeepSeek 网页）

1. **启动不自动登录（硬规则）**：应用启动不 spawn 网关、不发生任何 DeepSeek 网页登录；是否联网、走哪条通道由用户在设置页显式决定。
2. **通道持久化**：`config.json` 增加 `channel: 'api' | 'web' | null` 与 `api: { baseUrl, apiKey, model }`。
   - `channel = null`（首启/本节上线后升级）→ 设置页展示双通道选择卡：
   - **OpenAI 兼容 API**：baseUrl（默认 `https://api.deepseek.com/v1`）+ API Key + model（默认 `deepseek-chat`）→ 保存即启用；聊天/意图/抽取全部直连该端点，不启动网关（可接官方 DeepSeek API 或任意 OpenAI 兼容端点）。
   - **DeepSeek 网页**：走 §5.5 账号引导流；选中后需点击「启动网关」才 spawn+登录，**每次启动 Fairy 均需手动点一次**（启动后会话期间保持运行）。
3. **切换规则**：切到 api 会自动停止运行中的网页网关（避免后台登录）；切回 web 不自动启动；已在运行时保存账号 → 网关热重启应用新配置。
4. **测试对话按当前通道执行**；会话过期指纹（§5.5 / llm-bridge-notes §4，持续 429 overloaded）仅对网页通道生效，API 通道的 429 走常规退避。

---

## 6. 分阶段实施步骤

> 每阶段：**目标 → 步骤 → 验收**。阶段 1 结束 = 终端 curl 通；阶段 3 结束 = 可用的聊天助手；阶段 4/5 = 记忆与日程成形。

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

**验收**：干净虚拟机从安装到完成首次登录 < 10 分钟；开机自启后托盘自动出现且日程提醒不丢失（错过的标"已过期"不补弹）。

---

## 7. 数据模型

单文件 SQLite：`%APPDATA%/fairy/fairy.db`（WAL）

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
| 账号风控/封号 | 单机、单账号、低频（消息 ≈ 2 次调用）；全部数据本地化，封号后换通道数据不丢；UI 明示风险 |
| 账号凭据失效无感知 | 过期指纹（持续 429 `overloaded`）+ 网关日志登录失败扫描（RISK_DEVICE_DETECTED/USER_IS_BANNED/muted）→ 托盘红色 + 引导流一键重配（见 llm-bridge-notes §4） |
| 意图误判写脏日程 | JSON 校验 + `remind_at` 合法性 + 确认语可一键撤销（"没有/取消了"再一句即回滚） |
| 明文存账号凭据（MVP） | 文件权限收敛 + 阶段 6 上 DPAPI |
| Electron 冷启动慢 | 主进程常驻托盘；浮窗窗口启动时预建隐藏（show 即出） |
| 关着 Fairy 日程错过 | 退出前提示 + 重开时过期日程标"已过期"（不补弹，避免惊吓） |

---

## 9. 里程碑计划

| 里程碑 | 内容 | 工期 | 累计 |
|---|---|---|---|
| M0 | 阶段 0-1：curl 通 DeepSeek 网页会话 | 1-1.5 天 | ~1.5 天 |
| M1 | 阶段 2-3：sidecar + 登录流 + 会话系统 + 双窗口（**可用聊天助手**） | 3-5 天 | ~1 周 |
| M2 | 阶段 4：记忆（自动沉淀 + 注入 + 面板） | 2-3 天 | ~1.5 周 |
| M3 | 阶段 5：日程（意图 + 通知 + 面板） | 2-3 天 | ~2 周 |
| M4 | 阶段 6：打包、自启、DPAPI、日志（**日常可用版**） | 1-2 天 | ~2.5 周 |

> 每个里程碑打 git tag（m0…m4）。任意阶段中断，可回退到上一个 tag 的可用状态。

---

## 附录：蓝本阅读建议（动手前 1 小时，只读这些）

1. `reference/deepseek-pp/README.md` 的"核心功能/记忆系统"段——确认交互命名一致；
2. `reference/deepseek-pp/AGENTS.md` 中 schema migration 与 automation lease 两段（MVP 只保留 schema 一条规则）；
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
5. `reference/deepseek-pp` 是嵌套 git 仓库（gitlink），仅为本地参考，不参与 Fairy 构建。
6. 阶段 0 产物：`pnpm dev` 窗口+托盘正常；`release/Fairy Setup 0.0.1.exe`（NSIS，94MB）已验证可生成。
