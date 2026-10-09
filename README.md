# Fairy

Windows 桌面私人助手：以 **OpenAI 兼容 API**（官方 DeepSeek API / 任意兼容供应商）为 LLM 后端。数据全部本地化（SQLite 单文件），不上云。

> 总纲与验收标准见 [`docs/DEV_PLAN.md`](docs/DEV_PLAN.md)；开发环境备忘见其附录 C；交接进度见 [`PROJECT_STATE.md`](PROJECT_STATE.md)。

## 功能（MVP）

| 功能 | 说明 |
|---|---|
| 流式聊天 | 多会话、流式 Markdown（代码高亮）、停止按钮、上下文裁剪（~6000 token 预算） |
| 浮窗快问 | `Alt+Space` 呼出 380×560 置顶浮窗（快速会话），Esc / 失焦收起 |
| "帮我记东西" | 自然语言「记住：XXX」→ 意图解析 → 入本地 FTS5 记忆库；聊天时自动检索注入 |
| 长期记忆 | 意图直存 + 会话空闲自动抽取；关键词+权重（kind × 时间衰减）检索，**不用 embedding** |
| 日程 | 自然语言「明天上午十点提醒我交周报」→ 本地 events 表；到点系统托盘通知；面板可视管理 |
| 接入方式 | 设置页配置 **OpenAI 兼容 API**（填 baseUrl+key+model，可选 Chat Completions / Responses 两种接口风格） |
| 桌面形态 | 托盘常驻、开机自启、系统通知 |

后续路线进度（阶段 7–10，DEV_PLAN §6）：阶段 7 工具循环/Agent/受控 Shell **已验收（tag `m5`）**；阶段 8 Skill+MCP、阶段 9 cron 定时引擎、阶段 10 联网检索**代码完成**（自动化验收全绿，GUI 人工验收待做）。**不做云同步和多用户**；MVP 及后续仍为本地单用户应用。阶段和安全边界见 [`docs/DEV_PLAN.md`](docs/DEV_PLAN.md)。

## 快速开始

**环境**：Windows、Node ≥ 24.15、pnpm。

```bash
git clone <repo> && cd Fairy
pnpm install
pnpm dev
```

首启后在 **设置** tab 配置 LLM 接入：

1. 设置页 → 「OpenAI 兼容 API 配置」；
2. 官方 DeepSeek：Base URL `https://api.deepseek.com/v1`、Key 为你的 `sk-...`、模型 `deepseek-chat`；其他供应商按其文档填写；
3. **接口风格**二选一（同一 Base URL 下的两种 OpenAI 兼容协议）：**Chat Completions**（默认，`…/v1/chat/completions`）或 **Responses**（`…/v1/responses`；Base URL 填根地址或完整方法路径均可，自动归一不二次拼接）；
4. 「保存并启用」→ 下方「测试对话」验证 → 完成。

## 数据与配置（均在 `%APPDATA%\fairy\`）

| 文件 | 内容 |
|---|---|
| `config.json` | 明文非敏感项：接入配置（channel）、API baseUrl/model/接口风格、联网检索配置（`web` 段，无凭据） |
| `secrets.dpapi.json` | **凭据保险箱**：OpenAI API Key、MCP 服务器 env，全部 **Windows DPAPI 加密**（绑定当前用户；旧明文自动迁移） |
| `fairy.db` | SQLite（WAL）：sessions / messages / memories + memory_fts（trigram）/ events / **cron_tasks + cron_runs（阶段 9 定时任务与运行历史）** / kv（带幂等 schema 迁移，版本超限 fail-visible） |
| `logs/fairy-YYYY-MM-DD.log` | electron-log 按天滚动，保留 7 天；启动/接入/日程/崩溃均留痕 |

## 开发

pnpm workspace 两个包：

```
apps/desktop     Electron + React + Vite（main / preload / renderer）
packages/core    纯 TS 核心逻辑（llm / sessions / store / memory / intent / calendar / agent），vitest 单测
```

```bash
pnpm dev            # electron-vite 开发（已处理 ELECTRON_RUN_AS_NODE 陷阱）
pnpm typecheck      # 全部 tsconfig
pnpm test           # core + desktop 单元测试
pnpm build          # electron-vite 产物到 out/
pnpm package:win    # 打包：NSIS 安装包 + 免安装单 EXE → apps/desktop/release/
```

本机打包的完整命令（Node 路径 / 镜像 / 代理变量）见 `docs/DEV_PLAN.md` 附录 C。

架构：renderer 只经 preload 的 `window.fairy`（契约 `packages/core/src/ipc.ts`）与 main 通信；LLM 流式、意图解析、记忆注入、日程轮询均在 main 侧编排；阶段 7 的 Agent 工具运行时位于纯 TypeScript core，工具执行器（含受控 Shell）只从 main 入口导出，renderer bundle 实测无任何 OS 执行能力（`entry-isolation.test.ts` 护栏）。受控 Shell 采用命令白名单 + realpath 工作区路径边界 + 无 shell 解释器的最小环境子进程（本机无原生依赖，**非 OS 级沙箱**，边界与残余风险见 `docs/DEV_PLAN.md` §6 阶段 7 实施备注）；`better-sqlite3` 为 N-API 预编译（node/electron 通吃，无需 VS Build Tools）。

## 打包硬化（阶段 6）

- **安装包**：NSIS（`Fairy Setup x.y.z.exe`，可选安装目录；安装选项页「开机自启」**默认勾选**）
  + **免安装单 EXE**（`Fairy-x.y.z-portable.exe`）。
- **开机自启**：安装器写 `HKCU\...\Run\com.fairy.assistant`；应用内（托盘菜单 / 设置页）用
  `app.setLoginItemSettings` 开关同一项，卸载自动清理。**验证自启请用打包产物**（开发态 exe 是 electron.exe）。
- **凭据安全**：API Key、MCP env 全部 DPAPI 加密（`secrets.dpapi.json`），旧明文自动迁移；诊断报告与日志均脱敏。
- **日志**：`%APPDATA%\fairy\logs\fairy-YYYY-MM-DD.log`，按天滚动保留 7 天。
- **一键诊断**：设置页 →「导出诊断信息」→ JSON 报告（版本/系统/接入配置/存储/日志尾部，**不含凭据**）。

## 里程碑

| 状态 | 内容 |
|---|---|
| ✅ | 阶段 0–5 + 接入配置（DEV_PLAN §6 / §5.6）：脚手架、LLM 桥、会话+聊天 UI+双窗口、记忆（FTS5）、日程（意图+通知+面板） |
| ✅ | 阶段 6 打包硬化：NSIS 自启默认勾选 + 免安装 EXE、凭据 DPAPI、滚动日志+诊断导出（待干净虚拟机验收） |
| ✅ | 阶段 7 Agent 工具运行时：工具注册表 + 能力探测（API 通道实测 supported）+ 审批 IPC/对话框 + 受控 Shell（白名单 + 工作区路径边界）；227 单测 + 真实 API 端到端 4/4；GUI 验收通过（tag `m5`） |
| ✅ | 阶段 8 Skill + MCP：技能包发现/启用/指纹防篡改 + MCP stdio 客户端（恒审批、env 走 DPAPI）；自动化验收全绿，待 GUI 人工验收 |
| ✅ | 阶段 9 cron 定时引擎：迁移 v4 + 时区/DST 感知调度 + 幂等运行记录 + 无人值守预授权/超范围暂停通知 + 「定时」面板；374 单测全绿，待 GUI 人工验收 |
| ✅ | 阶段 10 联网检索：确定性触发（明确要求/时效信号/给出链接）+ DuckDuckGo 免 Key 检索 + 四道筛选（URL 守卫·域名黑白名单·去重·裁剪）+ `[n]` 编号引用规范 + `web_search`/`web_fetch` 工具（逐次审批）；490 单测全绿，待 GUI 人工验收 |
| 🏷 | `m0` 已打；`m1`-`m5` 归位至 `3b1dcd6`；阶段 8 验收过后打 `m6`，阶段 9（M7）验收过后打 `m7`，阶段 10（M8）验收过后打 `m8` |

## 注意

- 凭据已 DPAPI 加密落盘（`secrets.dpapi.json`，仅当前 Windows 用户可解）；仍请勿把该文件提交/外发。
- 本机开发环境陷阱（Node 路径 / `ELECTRON_RUN_AS_NODE` / 镜像与代理）见 `docs/DEV_PLAN.md` 附录 C。
