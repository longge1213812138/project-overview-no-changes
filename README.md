# Fairy

Windows 桌面私人助手：以 **DeepSeek 网页版会话**为 LLM 后端，**零 API 成本**；也可切换任意 **OpenAI 兼容 API**（官方 DeepSeek API / 其他供应商）。数据全部本地化（SQLite 单文件），不上云。

> 总纲与验收标准见 [`docs/DEV_PLAN.md`](docs/DEV_PLAN.md)；开发环境备忘见其附录 C；交接进度见 [`PROJECT_STATE.md`](PROJECT_STATE.md)。

## 功能（MVP）

| 功能 | 说明 |
|---|---|
| 流式聊天 | 多会话、流式 Markdown（代码高亮）、停止按钮、上下文裁剪（~6000 token 预算） |
| 浮窗快问 | `Alt+Space` 呼出 380×560 置顶浮窗（快速会话），Esc / 失焦收起 |
| "帮我记东西" | 自然语言「记住：XXX」→ 意图解析 → 入本地 FTS5 记忆库；聊天时自动检索注入 |
| 长期记忆 | 意图直存 + 会话空闲自动抽取；关键词+权重（kind × 时间衰减）检索，**不用 embedding** |
| 日程 | 自然语言「明天上午十点提醒我交周报」→ 本地 events 表；到点系统托盘通知；面板可视管理 |
| 通道选择 | 设置页二选一：**OpenAI 兼容 API**（填 baseUrl+key+model）或 **DeepSeek 网页**（本地网关账号池）；**启动不自动登录**，网页通道需手动点「启动网关」 |
| 桌面形态 | 托盘常驻、开机自启、系统通知 |

明确不做（MVP 范围外）：工具循环 / Agent / 本地 Shell、Skill、MCP、云同步、多用户、cron 定时引擎。

## 快速开始

**环境**：Windows、Node ≥ 24.15、pnpm。

```bash
git clone <repo> && cd Fairy
pnpm install
pnpm dev
```

首启后在 **设置** tab 选择 LLM 通道：

### 通道 A：OpenAI 兼容 API（推荐先跑通）

1. 设置页 → 「接入 OpenAI 兼容 API」；
2. 官方 DeepSeek：Base URL `https://api.deepseek.com/v1`、Key 为你的 `sk-...`、模型 `deepseek-chat`；其他供应商按其文档填写；
3. 「保存并启用」→ 下方「测试对话」验证 → 完成（全程不启动本地网关）。

### 通道 B：DeepSeek 网页（免费额度，需本地网关）

1. 准备 `ds-free-api` 单文件网关（Rust，见 [releases](https://github.com/NIyueeE/ds-free-api/releases)），开发态默认探测路径 `C:\Users\91533\.fairy-tools\ds-free-api\<版本>\ds-free-api.exe`，或用环境变量 `FAIRY_GATEWAY_BIN` 指定；
2. 设置页 → 「登录 DeepSeek 网页」：
   - 打开 `chat.deepseek.com`（无需登录），F12 Console 执行 `copy(SMSdk.getDeviceId())` → 复制输出的 device_id；
   - 填写账号（邮箱或手机号）+ 密码 + device_id → 保存；
   - 点「**启动网关**」（只有这一步会向 DeepSeek 发起登录）；
3. 状态卡变绿「网关运行中 · 端口 X」→ 测试对话验证。

> 网页通道的登录态失效指纹（持续 429 overloaded / 风控错误码）见 [`docs/llm-bridge-notes.md`](docs/llm-bridge-notes.md) §4。

## 数据与配置（均在 `%APPDATA%\fairy\`）

| 文件 | 内容 |
|---|---|
| `config.json` | 通道选择、OpenAI API 凭据、DeepSeek 账号凭据（MVP 明文，阶段 6 上 DPAPI） |
| `fairy.db` | SQLite（WAL）：sessions / messages / memories + memory_fts（trigram）/ events / kv（带幂等 schema 迁移，版本超限 fail-visible） |
| `gateway/config.toml`、`gateway-data/` | 网关子进程的配置与运行产物（由 Fairy 生成管理） |

## 开发

pnpm workspace 两个包：

```
apps/desktop     Electron + React + Vite（main / preload / renderer）
packages/core    纯 TS 核心逻辑（llm / gateway / sessions / store / memory / intent / calendar），vitest 单测
```

```bash
pnpm dev            # electron-vite 开发（已处理 ELECTRON_RUN_AS_NODE 陷阱）
pnpm typecheck      # 全部 tsconfig
pnpm test           # core 单元测试（137 用例，含真实网关 spawn 集成）
pnpm build          # electron-vite 产物到 out/
pnpm package:win    # NSIS 安装包到 release/（阶段 6 硬化中）
```

架构：renderer 只经 preload 的 `window.fairy`（契约 `packages/core/src/ipc.ts`）与 main 通信；LLM 流式、意图解析、记忆注入、日程轮询均在 main 侧编排；`better-sqlite3` 为 N-API 预编译（node/electron 通吃，无需 VS Build Tools）。

## 里程碑

| 状态 | 内容 |
|---|---|
| ✅ | 阶段 0–5 + 通道选择（DEV_PLAN §6 / §5.6）：脚手架、LLM 桥、sidecar+登录引导、会话+聊天 UI+双窗口、记忆（FTS5）、日程（意图+通知+面板） |
| ⏳ | 阶段 6 打包硬化：NSIS 自启默认勾选、凭据 DPAPI、滚动日志+诊断导出、网关二进制随包分发 |
| 🏷 | `m0` 已打；`m1/m2/m3` 待 GUI 验收后补打（清单见 `PROJECT_STATE.md` §5） |

## 注意

- `ds-free-api` 网关为 GPL 开源 sidecar（独立进程、独立二进制，不参与本仓库构建），**上游声明严禁商用**；商用场景请用 OpenAI 通道接官方 API。
- 网页通道账号凭据 + device_id 目前明文存 `config.json`；请勿提交到任何仓库。
- 本机开发环境陷阱（Node 路径 / `ELECTRON_RUN_AS_NODE` / 镜像与代理）见 `docs/DEV_PLAN.md` 附录 C。
