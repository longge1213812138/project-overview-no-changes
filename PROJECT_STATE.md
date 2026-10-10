# Fairy 项目交接材料

> 交接编号：**H15**（H1-H14 已归档；H8-H14 同对话前序快照）｜ 状态：**Web 通道已移除（H14）+ 渲染层 IPC 接缝已加深（H15：core 新增 FairyClient，renderer 新增 useResource/useAction，日程面板迁为试点面板，renderer 首次有测试）——两项改动均在**工作区未提交**；阶段 8/9/10 代码完成、自动化验收全绿（H15 复验 507 单测 + typecheck + build），GUI 人工验收待做（清单 §5 ⑤/⑥/⑦ 中 web 相关项已作废）；MVP GUI/干净虚拟机验收待做；下一步 = 阶段 8+9+10 GUI 验收 → tag m6/m7/m8** ｜ 更新时间：2026-10-10
> 工作目录（绝对路径）：`C:\Users\91533\Desktop\Fairy`
> **本次开发实际工作目录**：`C:\Users\91533\Desktop\Fairy.worktrees\project-overview-no-changes`（git worktree，main 分支）｜ **H14 有代码改动（未提交）**：Web 通道移除（core/main/preload/renderer/测试/打包/文档全链路）+ `AGENTS.md`「Agent skills」段 + `docs/agents/` 三文件

## 1. 任务与版本

- **目标**：Fairy = Windows 桌面私人助手，以 **OpenAI 兼容 API**（官方 DeepSeek API / 任意兼容端点）为 LLM 后端。MVP 范围 F1–F7 见 `docs/DEV_PLAN.md` §1（F7「登录引导流」已于 2026-10-10 移除）。
- **范围（MVP）**：聊天（流式）、多会话、"帮我记东西"、日程+托盘通知、FTS5 长期记忆、托盘/Alt+Space 浮窗/开机自启、API 接入配置（替代原登录引导流）。
- **MVP 后续范围（用户决定，2026-10-03）**：阶段 7–9：工具循环/Agent/本地 Shell、Skill、MCP、cron 定时引擎；**不做云同步和多用户**，产品保持本地单用户。
- **完成标准**：M0–M4 为 MVP；当前 MVP 阶段 2/3/4/5 + 通道选择 + 阶段 6 打包硬化代码完成（待 GUI 验收 + 干净虚拟机验收）。阶段 7 工具循环/注册表/审批 IPC/受控 Shell **GUI 验收已通过**（「第二次审批框不弹」四轮修复破案=审批 id 被 registry 负载 id 覆盖，修复⑤+回归测试钉死）。**阶段 8 Skill+MCP 与阶段 9 cron 定时引擎代码完成 + 自动化验收全绿（409 单测），待 GUI 人工验收（§5 ⑤/⑥）**；M5–M7 三阶段代码全部完成。**阶段 10 联网检索（2026-10-07）代码完成 + 自动化验收全绿（505 单测）并已提交（`ff20310`「联网」，2026-10-10），待 GUI 人工验收（§5 ⑦）**。
- **git 位置**：历史（当前唯一提交 = 根提交 `b001520 "MVP"`，81 文件）：
  - `bf06919` 阶段 0：pnpm workspace + Electron 骨架 + 图标 + NSIS 打包通过
  - `b9932fe` docs：附录 C 本机环境备忘
  - `5573a02` + tag `m0`：阶段 1 LLM 桥接通（docs/llm-bridge-notes.md）
  - `075937f` 阶段 2：sidecar 化 + 登录引导流
  - `011a6e9`/`fdf536d` 阶段 3：会话系统 + 聊天 UI + 双窗口
  - `129c655` 阶段 4：记忆（FTS5）+ 意图解析管线
  - `f4e61df` 通道选择：启动不自动登录，用户选 OpenAI API 或 DeepSeek 网页（§5.6）
  - `75876c5` 阶段 5：日程（意图 schedule_* + 通知轮询 + 面板）
  - `1d2ac06` 阶段 6：打包硬化（NSIS 自启默认勾选 + portable、凭据 DPAPI、日志 + 诊断导出）
  - `200da53` 阶段 7：Agent 工具运行时 → 验收修复 `cf88e41`/`2dfdf7f`/`41948d7`/`50f9a22`/`92a7a58`（审批 id 主权根因）→ `3b1dcd6` 验收归档
  - `e565453` docs：tag 归位（`m1`-`m5` → `3b1dcd6`）
  - `5268007` 阶段 8 Skill + `0f4f13b` 阶段 8 MCP + `b51639e` docs/examples（阶段 8 实施备注与验收清单）
  - `8591b05` 阶段 9：cron 定时引擎（迁移 v4 + 调度/幂等/预授权暂停 + 定时面板）
  - `25c911c` 接口风格 Responses（`config.api.apiStyle`，chat 默认 / responses 可选）
  - `ff20310` 阶段 10：联网检索（API 通道，`2026-10-10`，**当前 HEAD**）
- **tag**：**`m1`/`m2`/`m3`/`m4`/`m5` 全部归位至 `3b1dcd6`**（2026-10-04 用户指示执行：`git tag -f m1 m2 m3` 从 `b001520` 移至修复+验收提交、补打 `m4`=阶段 6/M4、`m5`=阶段 7/M5 验收通过）。`m0` 不在当前 tag 列表（历史 squash 后未保留）。
- **文档版本**：`docs/DEV_PLAN.md` v0.3（MVP 后续路线图；范围含阶段 7–9，不含云同步/多用户）。

## 2. 权威资料

| 资料 | 位置 | 管哪部分 |
|---|---|---|
| 开发计划（架构/阶段/验收/数据模型/风险） | `docs/DEV_PLAN.md`（v0.3） | 全部任务事实的总纲；验收标准以 §6 各阶段"验收"为准 |
| 本机环境备忘（Node 路径/镜像/打包命令/陷阱） | `docs/DEV_PLAN.md` 附录 C | 本机 Windows 开发环境与打包操作 |
| 蓝本（只读参考，nested gitlink，不参与构建） | `reference/deepseek-pp/` | 仅借鉴设计（记忆系统命名、schema 迁移规则） |
| 仓库约定（Issue tracker / triage 标签 / 领域文档） | `docs/agents/{issue-tracker,triage-labels,domain}.md` + `AGENTS.md`「Agent skills」段 | 工程协作类 skill 读取的配置；H13 新增（未提交） |
| ~~阶段 1 产出~~ | ~~`docs/llm-bridge-notes.md`~~ **已删除（2026-10-10）** | 该文档整篇描述 ds-free-api 网关 model 取值/过期指纹/限速，随 Web 通道一并移除 |

冲突规则：DEV_PLAN 与蓝本冲突时以 DEV_PLAN 为准；仅参考蓝本设计，不把蓝本的工具执行或自动化权限机制直接视为本项目决策。

## 3. 决定与限制

**用户已确认（DEV_PLAN 即用户认可的方案）**：
- MVP 的 LLM 通道：OpenAI 兼容 `/v1/chat/completions` 流式即可，不要求 tools；阶段 7 Agent 扩展已加入 tools 请求/响应支持。（原「仅验证 API 通道 / web 通道不做 tools 适配」的限制随 2026-10-10 移除 Web 通道而失效——现在只有一条通道。）
- ~~网关选型：ds-free-api 为 sidecar 首选，deeperseeker 备选~~ → **已移除（2026-10-10）**：不再有任何 LLM 网关 sidecar。
- "记东西/日程"走**意图解析**（非流式小调用出严格 JSON）不走工具调用；解析失败一律兜底 `chat`，绝不写脏数据。
- 数据库：better-sqlite3（WAL + FTS5），关键词+权重检索，**不引入 embedding**。
- 配置存 `%APPDATA%/fairy/config.json`；凭据存 `secrets.dpapi.json` 并由 Electron `safeStorage`（Windows DPAPI）保护，旧明文自动迁移。

**Agent 自行选择（待用户推翻）**：
- 浮窗 380×560、主窗口底部 tab（日程/记忆/设置）布局、上下文裁剪预算 6000 token 等 DEV_PLAN 参数。
- 阶段 0 采用 electron-vite 模板结构。
- **阶段 6 实施选择（2026-10-02）**：① DPAPI 用 Electron `safeStorage`（= CryptProtectData，零原生依赖；npm 无 `@kingsu/windows-dpapi`，本机也不能编译原生模块），密件单独存 `secrets.dpapi.json`；② 开机自启 Run 值名 = AUMID `com.fairy.assistant`（实测 Electron 39：值名不对则 `openAtLogin` 恒 false）；~~③ 打包随包分发 ds-free-api 网关二进制~~、~~④ 网关 config.toml 停止/退出即删~~ → **③④ 随 Web 通道移除作废（2026-10-10）**。

**用户新决定（2026-09-27）**：
- **阶段 5（日程）**：一度暂缓，同日恢复并完成（见 §4 与 `75876c5`）。
- ~~**通道选择优先**：启动不自动登录 DeepSeek 网页，设置页让用户选 OpenAI 兼容 API 或 DeepSeek 网页~~ → **历史（2026-09-27）**：现仅保留 API 接入配置（2026-10-10）。

**用户新决定（2026-10-03）**：
- MVP 完成后继续阶段 7–9：Agent/工具循环/本地 Shell、Skill、MCP、cron。
- 不做云同步和多用户；继续本地单用户产品边界。
- Shell 目标权限为默认限当前工作区、越界操作需用户确认；工作目录本身不构成 OS 隔离，须选定并验证隔离边界（后续指令：阶段 7 直接实现 Shell 并验收，不再暂缓）。
- ~~阶段 7 工具调用只走 API 通道：不做 web 通道的 tools 适配与测试~~ → **历史（2026-10-03）**：Web 通道已移除（2026-10-10），tools 对所有会话开放，端点不支持时按能力提示处理。

**用户新决定（2026-10-10）**：
- **彻底移除 Web 通道**：删除 DeepSeek 网页通道（`channel:'web'`）、`ds-free-api` 网关 sidecar、网页账号登录引导流、登录态日志扫描、托盘红色告警、`SessionExpiredError`（持续 429 overloaded 过期指纹）、网关二进制打包分发与相关配置项/文档；唯一接入方式 = OpenAI 兼容 API（chat / responses 两种接口风格不变）。

**用户新决定（2026-10-05）**：
- **API 通道接口风格**：Base URL 此前只支持 `v1/chat/completions`，现**同时支持 `v1/responses`**（OpenAI Responses API）——设置页「接口风格」二选一（chat 默认 / responses），配置存 `api.apiStyle`；协议/端点细节见 DEV_PLAN §5.6 第 2 条与 §4 表「接口风格 Responses」行。

**本机硬性限制（附录 C，务必遵守）**：
- Node 24.21.0 位于 `C:\Users\91533\.fairy-tools\node24\node-v24.21.0-win-x64`（用户 PATH 最前；**旧终端不生效**，开新终端或手动拼 PATH）。
- **`ELECTRON_RUN_AS_NODE=1` 陷阱**：会被部分终端继承，导致 electron 退化为纯 Node（无 GUI）。`pnpm dev` 脚本已内置 unset；手动跑 electron 前也要清空。
- github.com 当前可直连（2026-09-27 验证 200；历史交接记录的“直连不通”已失效）；electron/electron-builder 二进制仍走 npmmirror 镜像；本机 HTTPS 代理 MITM，node 侧需 `NODE_OPTIONS=--use-system-ca`。
- 打包完整命令见附录 C 第 4 条。
- `reference/deepseek-pp` 是嵌套 git 仓库，不提交、不参与构建。

## 4. 进展与运行状态

| 阶段 | 状态 | 证据 |
|---|---|---|
| 阶段 0 脚手架 | ✅ 已完成并验证 | `bf06919`：`pnpm dev` 出窗口+托盘；`release/Fairy Setup 0.0.1.exe`（NSIS ~94MB）已生成验证；单实例锁、外链转系统浏览器已实现（`apps/desktop/src/main/index.ts`） |
| 阶段 1 LLM 桥接通（历史） | ✅ **已完成（2026-09-27）** ⚠️ 实现已移除 | 当时用网关 ds-free-api v0.2.11（127.0.0.1:22217，账号池+device_id 登录）。**2026-10-10 起改为直连 OpenAI 兼容端点**，网关与 `docs/llm-bridge-notes.md` 一并删除 |
| 阶段 2 sidecar+登录流（历史） | ✅ **代码完成（2026-09-27）** ⚠️ 实现已移除 | 当时：core `llm/`（流式/退避/SessionExpired 指纹 + `gateway/` spawn/日志扫描/taskkill 树杀）、main `sidecar.ts`/托盘红图标、设置页四步引导流。**2026-10-10 全部删除**，替换为直连 API 的 `llm/` 客户端 + `main/channel.ts` 接入配置 + 设置页 API 配置表单（保留结论：`externalizeDepsPlugin({exclude:['@fairy/core']})` + renderer 走 `index.web.ts`） |
| 阶段 3 会话+聊天 UI | ✅ **代码完成（2026-09-27），待人工 GUI 验收** | core：`store/`（WAL+版本化迁移 fail-visible）+ `sessions/`（CRUD/自动标题/9000 字符裁剪/quick 会话），测试 48/48 绿；main：`windows.ts`（浮窗预建/Esc+blur 收起）+ `hotkeys.ts`（Alt+Space 失败降级）+ `chat.ts`（单飞流式编排，delta/done/busy 广播，stop 保留部分，过期→托盘红）；renderer：底部 tab + 会话侧栏 + ChatPane（react-markdown 流式、停止按钮、浮窗 `?float=1`） |
| 阶段 4 记忆 | ✅ **代码完成（2026-09-27），待人工 GUI 验收** | 迁移 v2（memories+trigram FTS+触发器，真实库 v1→v2 烟测升级成功）；意图 remember/forget/chat（失败兜底 chat）；检索三层候选+coverage×kind权重×0.95^天衰减 top-8（验收召回场景有单测）；chat 三步管线+空闲 5min 抽取；记忆面板（五色筛选/增删改/导出导入/onChanged 实时刷新）；测试 97/97 绿 |
| 阶段 5 日程 | ✅ **代码完成（2026-09-27），待 GUI 验收** | 迁移 v3（events+索引，真实库 v2→v3 烟测）；意图 schedule_add/done/cancel/query（add 非法时间追问一次、不写脏数据）；notify-loop 30s 轮询→通知→点通知开日程 tab、启动 sweep 已过期不补弹、退出前未触发提示；CalendarPanel（今天/明天/全部/勾选/手动增删/徽章）；测试 137/137 绿 |
| 通道选择（§5.6，插入需求）（历史） | ✅ **完成（2026-09-27）** ⚠️ web 部分已移除 | 当时：channel=null 双通道选择卡、API 表单、网页通道需手点「启动网关」、过期指纹按通道门控。**2026-10-10 移除 web 后**：单一接入方式，设置页只留 API 配置表单（常显）+「测试对话」，`channel:select/start/stop` 与 `gateway:*` IPC 一并删除 |
| 阶段 6 打包硬化 | ✅ **代码完成（2026-10-02），本机烟测通过，待干净虚拟机验收** | `electron-builder.yml`（NSIS+portable；**2026-10-10 起 extraResources 只带 icon.png**）+ `resources/installer.nsh`（安装选项页「开机自启」默认勾选，`/S` 也默认开；卸载清理 Run 键）；凭据 DPAPI：`main/secrets.ts` + `config.ts`（明文自动迁移、config.json 只剩非敏感字段；**2026-10-10 起密件只含 API Key + MCP env**）；日志 `main/logger.ts`（electron-log 按天滚动留 7 天）+ 诊断导出 `main/diagnostics.ts`（脱敏报告）+ 设置页「应用」区（自启开关/导出诊断/日志目录）+ `main/autostart.ts`。烟测（当时）：`Fairy Setup 0.0.1.exe`（112MB）+ portable；静默安装→Run 键写入→卸载全清；旧明文 config 自动迁移成功。~~`scripts/stage-extras.mjs` + 网关二进制随包分发~~：**已删除（2026-10-10）** |
| 阶段 7 Agent 工具运行时 | ✅ **代码完成（2026-10-03），待 GUI 人工验收** | core：`agent/runtime`（有界循环+授权决策 allowOutside/reason 穿透）、`agent/registry`（ToolRegistry + createRegistryAuthorizer，风险/审批/assess 策略，默认拒绝）、`agent/capability`（probeToolsSupport 两段探测三态）、`agent/tools`（pathguard 真实路径边界 + workspace_files + get_current_time + 受控 shell：白名单9命令/危险名单先查/spawn 无 shell/最小 env/输出截断）。main：`agent-approval.ts`（广播审批+60s超时拒绝+停止取消+全日志）、`agent-tools.ts`（workspace=%APPDATA%/fairy/workspace + 注册表装配 + 探测缓存）、chat 接线（通道门控+capabilityHint+toolNotice 广播）、浮窗 Esc 豁免。renderer：`ApprovalDialog`（队列/默认拒绝/Esc拒绝/越界红条）+ ChatPane 状态行/hint 灰条（落 meta 重开仍在）。证据：**227 单测 + 4 E2E 全绿、全仓 typecheck 绿、build 绿、bundle 实测无 OS 执行器、真实 agnes API 探测=supported(required)**。Shell 边界=白名单+路径边界+进程管控（**非 OS 级沙箱**，本机无原生依赖；DEV_PLAN 阶段 7 实施备注已如实声明）。**提交链**：`200da53`主体 → `cf88e41`/`2dfdf7f`/`41948d7`/`50f9a22` 审批框 GUI 缺陷四轮修复 → 修复⑤ 根因（审批 id 主权）+ 回归测试 3 项（详见 §5 ③ 进展实录）。 |
| 阶段 8 Skill+MCP | ✅ **代码完成（2026-10-04），自动化验收全绿，待 GUI 人工验收** | core：`agent/skill`（skill.json 严格解析 fail-visible / 发现+内容指纹 sha256 / electron-as-node 执行器：无 shell+最小 env+超时截断可取消 / 装配）+ `agent/mcp`（JSON-RPC 2.0 行协议 / stdio 客户端生命周期 initialize→tools/list→call、反向请求回 -32601、意外退出可见、taskkill 树杀 / 装配）+ `skill/schema` 零依赖 JSON Schema 子集校验器；main：`skills.ts`（新发现默认禁用、内容变更自动回禁用、状态入 config.json）+ `mcp.ts`（配置明文、**env 走 DPAPI**、用户驱动连接、退出树杀）+ IPC/preload（skills:* 与 mcp:*）；renderer：设置页「技能」区 + 「MCP 服务器」区。安全不变量：skill/mcp **审批恒 ask**、mcp risk 恒 exec、权限/来源进审批描述；**入口隔离**（执行面不进 index.web，测试断言）。证据：**skill 41 + mcp 17 新增测试，全仓 282+3 单测 + typecheck + build 全绿**；GUI 样例 `examples/skills/demo-echo`（含验收 README）+ `examples/mcp-demo-server.js`。**提交链**：`5268007`（Skill）→ `0f4f13b`（MCP）。 |
| 阶段 9 cron 定时引擎 | ✅ **代码完成（2026-10-05），自动化验收全绿，待 GUI 人工验收** | **迁移 v4**：`cron_tasks`（next_run_at/last_fired_at/preauthorized JSON/catchup/max_retries/failure_limit/consecutive_failures/pause_reason）+ `cron_runs`（**UNIQUE(task_id,scheduled_for) 幂等键**、attempt/manual/next_retry_at/output/error）。core `agent/cron`：`schedule`（5 字段 cron+宏、Vixie OR、Intl 时区、DST 缺口跳过/重叠取早、latestDue 错过合并、未来无触发保存期拒绝，38 测）+ `store`（幂等 claim、并发 skipped、状态迁移守卫、失败暂停，27 测）+ `policy`（planTrigger/planRecovery 纯决策、**预授权硬条件+越界永不授予+升级暂停**、无人值守提示词，14 测）+ 迁移 3 测；main `cron.ts`（10s tick、启动恢复 running→interrupted/陈旧 pending 按 catchup、串行执行队列、仅 API 通道门控、超范围/连续失败→暂停+通知点通知切「定时」tab、重试指数退避、IPC 面）+ 7 驱动测试；renderer：底部「定时」tab `CronPanel`（新建/编辑/暂停/恢复/立即运行/删除/运行历史展开）。**入口隔离**：cron 执行面不进 index.web（断言 createCronStore/createCronAuthorizer/planTrigger/planRecovery）。证据：**全仓 409 单测 + typecheck + build 全绿**；语义与验收对照见 DEV_PLAN 阶段 9 实施备注。 |
| 阶段 10 联网检索（API 通道） | ✅ **代码完成（2026-10-07）并已提交（`ff20310`「联网」，2026-10-10），自动化验收全绿，待 GUI 人工验收** | core `web/`：`types`（WebAccessConfig + 默认值）/ `urlguard`（协议·凭据·端口·IPv4/IPv6 私有段守卫 + 去重键 + 域名后缀匹配）/ `html`（零依赖：DDG 结果页抽取、页面正文抽取、内联标签不插空格）/ `search`（searchWeb 四道筛选 + fetchWebPage + 配置归一 + 中止抛 Abort）/ `trigger`（三类触发 + 排除面 + 检索词清洗，纯规则零 LLM 调用）/ `citations`（[n] 编号引用块 + 五条引用规范 + 失败说明）；工具 `agent/tools/web.ts`（`web_search`/`web_fetch`，approval 恒 **ask** / risk **read**，fetch 的 URL 守卫在 assess 即 deny）。main：`web.ts`（配置读写 + 检索编排 + 总预算 + 试跑）、`config.ts` 新增 `web` 段、`agent-tools.ts` 新增 `syncWebTools()`（开关关即卸载）、`chat.ts` 在 §5.1 ②c 注入引用块（仅 API 通道且 intent=chat）、sources 走 chatDone + meta 双路；renderer：设置页「联网检索」区（开关/条数/白黑名单/试跑）+ ChatPane 气泡下来源列表（点开走系统浏览器）。**入口隔离**：8 个执行面导出只进完整入口，entry-isolation 断言。证据：**core 新增 82（urlguard 16/html 10/search 20/trigger 14/citations 9/tools web 13）+ desktop 新增 14，全仓 505 单测 + typecheck + build 全绿**；语义对照见 DEV_PLAN §5.10。 |
| 接口风格 Responses（插入需求） | ✅ **完成（2026-10-05），自动化验收全绿** | 设置页 API 表单新增「接口风格」选择：**Chat Completions**（默认，`…/v1/chat/completions`）/ **Responses**（`…/v1/responses`），落 `config.json api.apiStyle`（老配置缺省归一 chat）。core：`llm/responses.ts` 协议适配（ChatMessage[]→`input` 项含 function_call/function_call_output、扁平 tools、`max_output_tokens`、非流式 `output[]` 解析、流式事件累计 completed/failed/incomplete、空 arguments 归一 `{}`、failed 抛错不伪装成功）+ `client.ts` 按风格**端点归一**（完整方法路径换/保后缀不二次拼接、`…/v1` 直接接方法名，修复 `/v1` 再拼 `/v1/v1` 隐患）并抽出**共用 `consumeSse`**（chat 路径行为回归不变）。main：saveApi 校验+持久化 style、resolveActiveChannel 带 apiStyle、**探测缓存键含风格**；preload/契约 `ApiChannelConfig.apiStyle` / `ChannelState.api.style`；设置页状态条回显风格。聊天/意图/抽取/工具探测/cron 全部自动跟随风格。证据：**409 单测（llm 新增 35：协议 25 + HTTP 集成 10）+ typecheck + build 全绿**。 |

代码现状（**2026-10-10 H14 移除 Web 通道后**）：`packages/core` 含 llm/sessions/store/memory/intent/calendar（阶段 2-5）与 agent（runtime/registry/capability/tools，阶段 7；skill/mcp，阶段 8；**cron/schedule+store+policy，阶段 9**；均仅完整入口，执行面不进 renderer）+ `web`（阶段 10 联网检索，同样仅完整入口）——**`gateway/` 已整体删除**；main 含 config/secrets/logger/autostart/diagnostics/channel/ipc/chat/extract/notify-loop/windows/hotkeys + agent-approval/agent-tools/skills/mcp/cron/**web**——**`sidecar.ts` 已删除，托盘红色告警机制删除**；renderer 含 ChatPane/SessionSidebar/MemoryPanel/CalendarPanel/CronPanel/SettingsTab（含 API 配置区+技能区+MCP 区+**联网区**，网页引导流与网关控制卡已删）+ ApprovalDialog + 底部 tab（聊天/日程/记忆/定时/设置）。**尚未做**：阶段 8/9/10 GUI 人工验收（清单 §5 ⑤/⑥/⑦）、MVP GUI 验收、干净虚拟机验收。

**文档/仓库约定进展（2026-10-10，H13；H15 更新）**：`AGENTS.md` 新增「Agent skills」段（Issue tracker = GitHub issues in `longge1213812138/project-overview-no-changes`；Triage labels = 五个规范角色同名标签；Domain docs = 单上下文 `GLOSSARY.md` + `docs/adr/`），并新增 `docs/agents/{issue-tracker,triage-labels,domain}.md` 三份说明。**H15 起 `GLOSSARY.md` 与 `docs/adr/` 已创建**（`GLOSSARY.md` 收录 Fairy client / Resource / Action / Feedback；`docs/adr/0001-renderer-ipc-seam.md` 记录「渲染层只经 Fairy client 访问 main」）。以上均**未提交**。

**已解决/已知事实**（原“未确认项”已全部落地）：~~ds-free-api v0.2.11 本机下载+运行 OK；账号池+device_id 登录 OK（网关运行配置含临时明文，停止/退出即删，勿入 git）~~ → **随 Web 通道移除失效（2026-10-10）**：不再需要本机网关，接入只需 API baseUrl + Key（Key 由 DPAPI 保护）。

**H14 移除 Web 通道（2026-10-10）改动清单**：
- **删除文件**：`packages/core/src/gateway/*`（manager/config/log-parser/index + 3 个测试）、`apps/desktop/src/main/sidecar.ts`、`apps/desktop/scripts/stage-extras.mjs`、`apps/desktop/scripts/make-icon-red.mjs`、`apps/desktop/resources/icon-red.png`、`docs/llm-bridge-notes.md`。
- **core**：`ChannelKind` 收窄为 `'api'`；删 `GatewayState/GatewayAccountConfig/ConfigureResult` 与 `TestChatResult.expired`；`ChannelState` 去掉 `web` 段；IPC 常量删 `channel:select/start/stop`；删 `SessionExpiredError` 与 client 的「429 overloaded → expired」分类（429 一律常规退避）；capability 只 rethrow `LlmAuthError`。
- **main**：`channel.ts` 重写为单通道（`getChannelState/saveApi/resolveActiveChannel/channelTest`）；`config.ts` 删 `gatewayBin`/网关 `apiKey`/`account` 与探测/迁移函数，新增**一次性清理**旧 `channel:'web'` 与遗留密件；`secrets.ts` 密件只留 `apiApiKey` + `mcpEnv`；`ipc.ts` 删 `gateway:*` 与 `channel:select/start/stop` handler、删托盘状态机；`windows.ts` 删 `sendStateOnFinishLoad` 与 `gateway:state` 广播；`diagnostics.ts` 报告去网关段；`index.ts` 退出流程去 sidecar 回收；`chat.ts`/`cron.ts` 去 web 门控与过期分支。
- **preload/renderer**：`FairyApi` 去 `gateway` 子面与 `onGatewayState`；设置页删双通道选择卡、四步引导流、网关控制卡、过期红卡，API 表单常显。
- **打包**：`electron-builder.yml` extraResources 只留 icon.png；`package:win` 去掉 stage-extras 前置。
- **验证**：**490 单测全绿**（core 466 passed + 1 skipped；desktop 24 passed）+ `tsc --noEmit`（core / desktop node / desktop web）全绿 + `electron-vite build` 成功（产物已生成，bundle 无 gateway/sidecar 代码）。
- **残留兼容**：老 `config.json`（`gatewayBin`/`apiKey`/`account`/`channel:'web'`）与老 `secrets.dpapi.json`（`apiKey`/`account`）在首次读取时被识别并一次性重写清出；`channel` 归一为 `null` 时需用户在设置页重新「保存并启用」（**不静默切通道**）。

**H15 渲染层 IPC 接缝深化（2026-10-10）——试点已落地**（来源：`/improve-codebase-architecture` 架构评审候选 1，设计经三轮确认；未提交）：
- **新增 module**：`packages/core/src/client/`（`FairyClient` = 渲染层访问 main 的唯一通道；接口由 `FairyApi` 类型映射**派生**，不手写方法清单；运行时把「返回 Promise 的调用」归一为 `IpcResult`——main 侧 `throw` 与 `{ok:false}` 两种约定都变失败结果，`{ok:true,...}` 外壳被剥掉；同步返回值如 `onChanged` 原样透传）；`apps/desktop/src/renderer/src/ipc/`（`fairyClient.ts` 默认 client、`useResource`（取数 + 订阅 + **过期响应丢弃** + 读失败保留旧数据）、`useAction`（按 key 忙碌态 + 失败归一 + 成功回调 + `fail` 供本地校验））。
- **试点面板**：`calendar/CalendarPanel.tsx` —— `events.list` + `onChanged` 交 `useResource`，`add/complete/remove` 交 `useAction`（按日程 id 忙碌），删掉本文件内的 `errText`；只留日程自己的规则（scope 过滤、列表排序、30s 跨天时钟、表单校验）。**面板内零 `window.fairy` 直调**。
- **测试基建（本仓首次）**：新增 `apps/desktop/vitest.config.mts`（vitest `projects` 分环境：`src/main/**` → node、`src/renderer/**` → jsdom 且 alias 指向 `index.web.ts`）+ `src/renderer/test-setup.ts`（显式挂 RTL `cleanup`：vitest 默认不开 globals，否则上一用例 DOM 残留）；新 devDeps `jsdom` + `@testing-library/react` + `@testing-library/dom`。
- **口径与决定**：见 `docs/adr/0001-renderer-ipc-seam.md`（未在 main 侧统一错误约定、client 放 core、默认参数注入而非 React context）。
- **验证**：**507 单测全绿**（core 472 passed + 1 skipped（新增 client 6）；desktop 35 passed（新增 renderer 11：`useResource` 4 + `CalendarPanel` 7））+ 三份 typecheck 绿 + `electron-vite build` 绿。
- **未做（下一轮候选）**：其余 7 个面板（`SessionSidebar` 最简、`SettingsTab` 的 4 个自洽子区块、`MemoryPanel`/`CronPanel` 同构浅模块、`ChatPane` 的乐观更新留在面板）仍直调 `window.fairy`；`errText` 仍有 2 份（Memory/Cron）。

## 5. 接续动作

**当前并行事项**：① **【阻塞在用户侧】阶段 8 GUI 人工验收**（清单见 §5 ⑤，样例 `examples/skills/demo-echo` + `examples/mcp-demo-server.js`，需 `pnpm dev` 重启）；② **【阻塞在用户侧】阶段 9 GUI 人工验收**（清单见 §5 ⑥）；③ **【阻塞在用户侧】阶段 10 联网检索 GUI 人工验收**（清单见 §5 ⑦，需外网可达）；④ MVP GUI/干净虚拟机验收（**H14 后不再有 web 项**）；⑤ 三项验收通过后打 tag `m6`（阶段 8）/`m7`（阶段 9）/`m8`（阶段 10）。

**① GUI 验收清单（阶段 2/3/4/5 + 通道选择合并，DEV_PLAN §6 各阶段验收 + §9 M2/M3）**：
1. `pnpm dev`（新终端，Node 24，`ELECTRON_RUN_AS_NODE` 未被继承）。
2. **聊天（阶段 3）**：底部 tab；新建/切换/删除 10 个会话；流式 markdown；停止按钮保留已生成部分；**Alt+Space 浮窗**问答、Esc 收起；重启后历史完整。
3. **设置 / 接入配置（阶段 2）**：设置页顶部状态条显示「尚未配置接入方式」（首次）→ 填 baseUrl/key/model → 「保存并启用」→ 状态条变绿并回显端点/模型/接口风格；「测试对话」绿卡；把 API Key 改坏 → 测试对话红字「API Key 无效」，改回恢复；把 baseUrl 改成非法值 → 保存即报错（不落库）。
4. **记忆（阶段 4，M2 验收）**：
   - 聊天说「记住：我喝美式不加糖」→ 回复开头有确认语；**新开会话**问「我咖啡怎么喝」→ 答案能引用该记忆；
   - 记忆面板出现该条（kind=note）；删掉后新会话再问 → 不再引用；
   - 面板手动新增/编辑/筛选/搜索/导出 JSON/导入同文件（应显示 skipped 去重）；
   - 闲聊后等 5 分钟（或下轮对话前）观察抽取入库 preference/fact 类记忆（面板 onChanged 刷新）；
   - 连续聊 10+ 轮，面板误入库目测可接受（prompt 可调，DEV_PLAN §6 阶段 4 验收第 3 条）。
5. **接入配置（§5.6，H14 后为唯一通道）**：
   - 首次进设置页：status bar「尚未配置接入方式」+ API 表单常显（无任何选择卡/引导流）；
   - 填 baseUrl+key+model（可选接口风格 chat/responses）→ 保存启用 → 测试对话通；
   - 重启 Fairy → 配置与 Key 保留（Key 不落明文，输入框留空 = 不改）；
   - 老配置迁移：手动造一份含 `channel:"web"` / `gatewayBin` / 网关 `apiKey` / `account` 的 `config.json` → 启动后这些字段被清出、channel 归一 null、设置页提示重新配置（**不静默切通道**）；
   - 观察 `tasklist`：全程**无任何网关/外部辅助进程**（H14 后不存在 ds-free-api 进程）。
6. **日程（阶段 5，M3 验收）**：
   - 「明天上午十点提醒我交周报」→ 回复确认语含正确绝对时间；面板“明天”可见该条；
   - 面板手动新增一个 1-2 分钟后的日程 → 到点系统通知弹出；**点通知 → 主窗口切到日程 tab**；
   - 「周报完成了」→ 面板勾上；「把明天所有提醒取消」→ 明天列表清空；
   - 对话问「我明天有什么安排」→ 回复总结相关日程；
   - 面板手动增删/勾选 → 对话查询实时一致（eventChanged）；
   - 重启后已过期未触发的日程标「已过期」**不补弹**；有未触发日程时退出 → 弹退出提示通知；
   - 时间非法表达 → 模型追问一次，不写脏数据。
7. ~~通过后：`git tag m1 m2 m3`~~ → **已提前执行（`b001520`）**；若验收发现问题，修复后再 `git tag -f m1 m2 m3` 移 tag。
8. **阶段 6（打包硬化，M4 验收）**：
   - `pnpm package:win`（附录 C 环境变量）→ 生成 `Fairy Setup 0.0.1.exe` + `Fairy-0.0.1-portable.exe`（本机已生成验证）；
   - **干净虚拟机**：安装（注意安装选项页「开机自启」默认勾选）→ 首启填 API 配置 → 测试对话通 < 10 分钟（H14 后无需任何额外二进制或安装步骤）；
   - 重启虚拟机 → 托盘自动出现（日程提醒不丢：错过的标「已过期」不补弹）；取消勾选自启/应用内关闭自启 → 重启不再自启；卸载后 Run 键清理；
   - 设置页「应用」区：自启开关状态与托盘菜单一致；「导出诊断信息」→ JSON 报告确认**不含账号凭据**（含日志尾部已脱敏）；「打开日志目录」→ `logs/fairy-YYYY-MM-DD.log`；
   - 免安装单 EXE：直接双击可用（同样支持自启/日志/诊断）。
   - （已本机验证：静默安装→Run 键写入→实机日志 `openAtLogin=true`→卸载全清；DPAPI 迁移+双上下文解密。）

**② 阶段 5 已完成（`75876c5`，暂缓后同日恢复）**：迁移 v3 events 表、意图 schedule_*、notify-loop、CalendarPanel 均已落地（详见 §4）。

**③ 阶段 7 GUI 人工验收清单（2026-10-03；真实 API E2E 4/4 已自动通过）**

**验收进展实录（日志：`%APPDATA%/fairy/logs/fairy-2026-10-03.log` 与 `fairy-2026-10-04.log`）**：
- ✅ 已测通过：第 2 项首次弹框+允许（18:43/18:51/19:07/19:30 及 10-04 01:01/01:03/01:19 多轮 `approved=true`）、第 3 项拒绝（18:43 `approved=false`）、Esc/停止路径（18:44 `cancelled`）、60s 超时（18:45 等多轮 `timeout`）、**第 6 项白名单拒绝（10-04 01:12 `denied reason=该命令被安全策略禁止`，powershell 未进审批即拒）**
- ❌→✅ **「第二次审批框不弹」已破案（第 4 轮复测 2026-10-04，快照诊断命中）**：
  - 复测复现三次（01:01/01:05/01:21）：首次审批框正常（`wc1` respond 受理），第二次起只显示 🔧 状态行「等待审批」、审批框不弹，60s 后 `reason=timeout`；关窗重开后弹出的框点「允许」→ `respond id=1 ... snapshot={"queueIds":[1],"handledIds":[1],"from":"main"}` 被记 `忽略未知/重复 id=1`。
  - **根因（日志+静态双向确证）**：`requestApproval` 用 `{ id, ...req }` 组装广播负载，而 registry 的 confirm 负载自带 `id`（registry 内部 nextId，每轮生成=每个 authorizer 从 1 重计）→ **registry id 把 agent-approval 的 seq id 覆盖**：
    - 广播负载 id 恒为 1 → renderer `handledRef` 把后续请求当「已处理的重复 id」**静默丢弃** → 不弹框（🔧 状态行走 toolNotice 另一通道，照常显示「等待审批」）；
    - 重建窗挂载对账 `getPending` 返回负载 id=1（pending 真 key 是 seq id=2/3）→ 弹「id=1」的框 → 点「允许」回传 1 → `respondApproval` 判未知忽略。
  - **谜团破**：重建窗 renderer 队列里的 id=1 = `getPending` 返回的**负载 id**（不是历史广播残留）；`handledIds:[]`→`[1]` 证明该 renderer 是全新实例（点击前未处理过任何 id）。19:31 与 10-04 两次快照完全一致。
  - **修复链**：`cf88e41`（权威对账）→ `2dfdf7f`（召唤+定时对账）→ `41948d7`（焦点自愈+双保险事件）→ `50f9a22`（修复④：延迟 500ms 三保险 syncReq + summon moveTop 置顶 + 快照诊断）→ **修复⑤（根因，2026-10-04 提交）**：`agent-approval.ts` 改 `{ ...req, id }`（seq id 一锤定音）+ `chat.ts` confirm 接线显式剥离 registry id + **回归测试 3 项**（apps/desktop 新增 vitest 测试基建：id 主权/重复 respond 幂等/60s 收敛；变异验证=回退旧写法即红 2 例，咬住的正是生产症状）。
  - ~~**待第 5 轮复测**~~ → ✅ **第 5 轮复测通过（2026-10-04 02:13-02:14，用户确认「验收通过」）**：连续两次请求（`get_current_time` id=1 / `shell` id=2）均**自动弹框**、respond id 与请求 id 一致（`respond id=2 ... snapshot={"queueIds":[2],"handledIds":[1,2]}`）、全程无「忽略未知/重复」——**缺陷关闭**。
- 🚫 **已确认无效路线（勿回退）**：纯事件驱动的队列同步（仅 onApproval/onSettled 单保险）经 18:43-19:31 共四轮实测失效；现架构 = 五时机对账（挂载/新请求/提交被拒/3s 定时（修复④由 10s 降频）/焦点变化）+ 双保险广播事件，后续改动不得删减任一时机。**新增不变量**：审批 id 必须由 agent-approval 的 seq 生成，任何上游负载携带的 id 一律不得进入广播负载（renderer 按 id 去重依赖此不变量，回归测试钉死）。

**清单（未测项）**：
1. `pnpm dev`（新终端，Node 24）；设置页确认 API 通道（agnes 配置已有）。
2. 聊天里说「用 get_current_time 工具查一下现在几点」→ **弹审批对话框**（工具名/绿「只读」徽标/JSON 入参）→ 点「允许」→ 回复含真实时间；输入区下方出现 🔧 工具状态行（等待审批→执行中→已完成）。
3. 同样请求再触发一次 → 点「拒绝」或按 **Esc** → 模型收到拒绝原因、不执行（回复中可见）。
4. 审批弹出后放 60 秒不理 → 对话框自行关闭（超时拒绝），`logs` 里 `[approval] ... reason=timeout`。
5. 「用 shell 运行 whoami」→ 审批（红「执行」徽标）→ 允许 → 输出用户名；「用 shell 读 ..\..\ 下某文件」→ 审批对话框出现**越界红条警告**（reason 显示具体路径）。
6. ~~拒绝类（白名单）~~（✅ 已测通过 10-04 01:12）：「用 shell 运行 powershell Get-Date」→ 即便模型调用也 `denied`（日志 reason=该命令被安全策略禁止），回复可见拒绝。
7. ~~web 通道：切到网页通道…工具调用仅支持 API 通道~~ → **已作废（2026-10-10 web 通道移除）**；现改为：把 baseUrl 指向一个 `unsupported` 端点（不支持 tools 的兼容端点）→ 回复中可见 `capabilityHint`「当前 API 端点不支持工具调用…」（重开会话灰条仍在，已落 meta）。
8. 浮窗（Alt+Space）触发审批 → 对话框出现，且**有 pending 时 Esc 不收窗**（Esc=拒绝）；失焦收窗仍正常。
9. 主窗与浮窗同时收到审批 → 任一窗口响应后另一窗对话框自动关闭（settled）。
10. 生成中点「停止」→ 悬挂审批立即以 cancelled 关闭，无残留对话框。

**注意事项**：~~web 账号已被禁言（muted，2026-10-03 实测，至 2026-10-11 21:37）——web 通道聊天验收需等解禁~~ → **H14（2026-10-10）后不再相关**：网页通道已彻底移除，不再有 web 账号、风控或解禁依赖。**阶段 7 新增**：① Electron safeStorage 的 DPAPI 熵绑定 app name（dev/打包均 productName=Fairy 故互通；外部解密脚本必须 `app.setName('Fairy')`，见 scripts/unlock-e2e-config.cjs）；② E2E 复跑：`npx electron scripts/unlock-e2e-config.cjs` → `FAIRY_E2E_CONFIG=<路径> vitest run src/agent/e2e.api.test.ts`（key 不落日志）；③ LLM client endpoint 已归一（baseUrl 带完整 /v1/chat/completions 路径不再二次拼接）；④ shell 白名单/越界审批是当前唯一执行边界，扩白名单前先过 DEV_PLAN 阶段 7 实施备注的残余风险评估。~~通道选择遗留：`gateway:getState/configure/state` 通道名不在 IPC 常量表（兼容保留）~~ → **H14 已删除这些通道名与 handler**。其余遗留：done/cancel 匹配依赖 title LIKE 关键词（模型分词质量影响命中）；通知单次触发（构造异常也 markFired 防刷屏）；空闲抽取是全局单例 5min 定时器；面板列表 limit 无分页（memory 200/events 500）；`.pi/` 已入 .gitignore；生成中切走再切回占位为空、bundle >500kB 等阶段 3 遗留仍有效；`electron-builder.yml` 已设 `npmRebuild: false`，extraResources 现只含 `icon.png`（**H14 起不含网关二进制与红图标**）。

**④ 下一步开发计划（2026-10-04 拟定，按 DEV_PLAN v0.3 路线）**：

1. **收尾（MVP 验收）**：MVP GUI 验收清单①剩余项补验（**H14 后 web 项已作废，不再解除禁言依赖**）→ 干净虚拟机验收（清单第 8 条 = 阶段 6/M4）→ ~~tag 归位~~ ✅ **已执行（2026-10-04）**：`m1`/`m2`/`m3` 移至 `3b1dcd6`、补打 `m4`，与 `m5` 同点；剩余 = 试用反馈。
2. ~~**阶段 8（M6）：Skill 与 MCP**~~ → ✅ **代码完成（2026-10-04，`5268007` Skill + `0f4f13b` MCP）**，自动化验收全绿；设计前置（信任/分发/沙箱/凭据策略）已按 DEV_PLAN §5.8 细化并写入实施备注（默认禁用+指纹防篡改+恒 ask+无网络安装+env 走 DPAPI+不自动连接外部进程），**待用户推翻或 GUI 验收（清单⑤）**。
3. ~~**阶段 9（M7）：cron 定时引擎**~~ → ✅ **代码完成（2026-10-05）**，按 DEV_PLAN v0.3 阶段 9 三条落地：迁移 v4（cron_tasks/cron_runs 幂等键）、时区/DST/错过/重启/并发/失败语义、预授权+超范围暂停通知、「定时」tab 查看/暂停/恢复/编辑/删除入口。**已确认语义与测试证据全部写入 DEV_PLAN 阶段 9 实施备注**；409 单测 + typecheck + build 全绿。**待 GUI 人工验收（清单⑥）→ 过后打 tag `m7`**。
4. **阶段 10（M8）：API 通道联网检索** → ✅ **代码完成（2026-10-07）**：core `web/`（触发判定/URL 守卫/HTML 抽取/检索引擎/抓取/引用编排）+ 工具 `web_search`/`web_fetch`（恒 ask / read）+ main `web.ts` 编排与配置 + chat 管线注入 + 设置页联网区 + 气泡来源列表；**505 单测 + typecheck + build 全绿**。触发口径（三类触发 + 排除面 + 仅 API 通道）、来源范围（域名白黑名单/URL 守卫）、数据筛选四道、引用规范（[n] 编号 + 禁编造）与失败语义全部写入 DEV_PLAN §5.10。**待 GUI 人工验收（清单⑦）→ 过后打 tag `m8`**。

**⑤ 阶段 8 GUI 人工验收清单（2026-10-04 拟定；样例与步骤见 `examples/skills/README.md`）**

1. **安装与默认禁用**：复制 `examples/skills/demo-echo` 整目录 → `%APPDATA%/fairy/skills/`；设置 → 技能 →「重新扫描」→ 列表出现 `demo-echo v1.0.0`，状态**已禁用**，来源/声明权限（workspace:read）/两个工具（demo_echo、demo_bad_input，均「只读」徽标）可见。
2. **启用 + 审批展示**：勾选启用（提示"每次调用需确认"）→ 聊天「用 demo_echo 工具回显 hello」→ **弹审批框**：「扩展」徽标 + 描述尾部 `来自 Skill「demo-echo v1.0.0」· 来源：local… · 声明权限：workspace:read` → 允许 → 回复含 `{ok:true, echoed:{text:"hello"}, env:{... leakedAppSecret:null}}`（**凭据零注入实证**）；拒绝/Esc 路径与阶段 7 相同。
3. **整包拒绝可见**：给 skill.json 加一个未知字段 → 重扫 → 红字「加载失败（整包拒绝）：skill.json 含未知字段…」，工具不注册。
4. **指纹防篡改**：启用状态下改动 `tools/echo.js` → 重扫 → 自动变「已禁用 + 内容已变更」，重新勾选才恢复启用。
5. **入参校验**：让模型调 `demo_bad_input` 且 text 不以 ok 开头 → **审批前**被拒，回复含可见原因（入参校验失败）。
6. **MCP 添加与连接**：设置 → MCP →「添加服务器」：名称 `demo-mcp`；启动命令 = node.exe 绝对路径（`C:\Users\91533\.fairy-tools\node24\node-v24.21.0-win-x64\node.exe`）；参数一行一个 = `examples\mcp-demo-server.js` 全路径；环境变量 `DEMO_TOKEN=abc123` → 保存（提示 env 已加密存 DPAPI，列表**只显示 KEY 名**）→「连接」→ 状态「已连接」+ `fairy-demo-mcp v1.0.0` + 工具 `demo_greet、demo_time`。
7. **MCP 调用审批**：聊天「用 demo_greet 工具问候小F」→ 审批框（「扩展」徽标、红「执行」徽标、`来自 MCP 服务「demo-mcp」（每次调用需审批）`）→ 允许 → 回复含 `tokenConfigured:true`（env 注入成功且**不回显值**）；demo_time 同理返回服务端时间。
8. **异常可见**：启动命令改成不存在的 exe → 连接失败红字（启动失败…）；连接成功后任务管理器杀掉对应 node 进程 → 状态自动变「错误」+ exit code/stderr 可见；「断开」→ 状态回「未连接」，**新会话中模型不再引用其工具**。
9. **凭据落盘检查**：保存含 env 的服务器后查 `config.json`（**无 env 字段**）与 `secrets.dpapi.json`（protected:true、含 mcpEnv），`fairy-*.log` 与诊断报告**无 token 值**。
10. **退出回收**：连接状态下托盘退出 → `tasklist` 无残留 demo-mcp 的 node 进程（taskkill 树杀）；重启后状态为「未连接」（**不自动重连**）。

**⑥ 阶段 9 GUI 人工验收清单（2026-10-05 拟定；与 §5 ⑤ 同一次 `pnpm dev` 可一并做；需 API 通道）**

> 语义基准 = DEV_PLAN 阶段 9 实施备注；日志看 `%APPDATA%/fairy/logs/fairy-*.log` 的 `[cron]` 行。快速验收可用 `* * * * *`（每分钟）任务。

1. **新建与校验**：底部「定时」tab →「＋新建任务」→ 名称/指令/表达式 `* * * * *`/时区默认 → 创建成功，列表「运行中」+ 下次触发 ≤1 分钟后；表达式填 `乱填` → 红字错误不落库；`0 0 30 2 *` → 报「未来没有有效触发时间」。
2. **到点执行 + 幂等**：等 1-2 分钟 →「运行历史」出现一条 成功（输出=任务总结）；同一分钟绝不出现两条；日志 `触发/开始/成功` 齐全。
3. **预授权工具**：新任务预授权勾 `workspace_files`，指令读工作区内文件 → 运行成功；**凭据/权限按集合**：不勾任何工具 + 指令要求用工具 → 该轮「超范围被拒」+ **任务自动暂停** + 系统通知（原因=未预授权）——全程**不弹审批框**（不绕过交互审批）。
4. **越界暂停**：任务预授权 `workspace_files`，指令读 `..\..\` 下文件 → 运行「超范围被拒」+ 暂停 + 通知（原因=不授予越界权限）；面板暂停原因可见；点通知 → 主窗切「定时」tab。
5. **暂停/恢复/编辑/删除**：暂停 → 到点不触发（历史无新记录、下次触发变「—」）；恢复 → 重算下次触发且连续失败计数清零；编辑改表达式 `*/2 * * * *` → 下次触发按新表达式；删除 → 任务与历史一并消失（确认框提示）。
6. **立即运行**：点「立即运行」→ 立刻出现一条带「（手动）」的记录；任务暂停时按钮禁用/触发报「请先恢复」。
7. **错过补跑（catchup 开）**：建每分钟任务 → 托盘**完全退出** → 等 3-5 分钟 → 重启 → 历史只多 **1** 条补跑（合并更早错过，日志 `补跑错过触发`），next 正常推进。
8. **错过不补（catchup 关）**：新建时取消勾选「错过触发时补跑」→ 同上退出重启 → 历史多 **1** 条「已错过」，无执行、任务未被暂停。
9. **执行中退出**：任务运行中托盘退出（可用长指令制造）→ 重启 → 该轮显示「运行中断」+ 错误说明（不伪装成功/失败）。
10. **连续失败自动暂停**：把 API baseUrl 改坏 → 任务失败 3 次（可配合 `* * * * *` 快速复现）→ 自动暂停 + 通知，暂停原因含「连续失败达上限」与错误详情；改回配置 → 恢复后正常执行。
11. **接入门控**：把 `config.json` 的 `channel` 临时改成 `null`（或清掉 api 段）→ 任务到点 → 该轮失败 + **立即暂停** + 通知（原因=通道不可用）；改回配置并恢复任务后继续执行。
12. **与日程分开**：定时任务不出现在日程 tab；日程提醒（阶段 5）不进运行历史；两边互不影响。
13. **重启恢复不重复**：连续重启两次，历史不因重启多出重复记录（幂等键；日志无同刻两条 `触发`）。

**⑦ 阶段 10 联网检索 GUI 人工验收清单（2026-10-07 拟定；需 API 通道 + 本机可访问 bing.com）**

> 语义基准 = DEV_PLAN §5.10；日志看 `%APPDATA%/fairy/logs/fairy-*.log` 的 `[web]` / `[tools]` 行。

1. **默认态与开关**：设置 →「联网检索」默认**开启**；关掉再开启 → 保存提示出现，日志随之出现「web_search / web_fetch 未注册」或「联网工具已注册」（工具随开关装配/卸载）。
2. **明确要求触发**：聊天「联网搜一下 Node LTS 的最新版本号」→ 日志 `[web] 触发联网 kind=explicit` → 回复给出版本并**句末带 [n] 编号**；气泡下方出现「🌐 本次参考了 N 个来源」列表，点条目 → 系统浏览器打开对应链接。
3. **时效信号触发**：聊天「最新的 Electron 版本是多少」「今天上海天气」→ `kind=freshness`；闲聊/创作类指令（「帮我写一封请假邮件」「刚才我说了什么」）日志 `未命中联网触发规则`，气泡下方**无**来源列表。
4. **直达链接**：发一条含 `https://example.com` 之类链接的消息 → `kind=link` → 该页被抓取，来源列表出现该链接。
5. **工具路径需每次确认**：让模型主动调用（`用 web_search 查一下 X`）→ **弹审批框**（只读徽标）、允许后才执行；诱导模型抓取 `http://127.0.0.1/` 或 `http://169.254.169.254/` 一类内网地址 → **不弹审批、直接在 assess 阶段拒绝**，日志可见拒绝原因。
6. **来源范围白/黑名单**：设置页白名单填 `python.org` → 检索「python 教程」→ 结果只剩该域名；黑名单填某域名 → 该域名结果消失（试跑按钮即可复现）。
7. **失败可见**：临时断网（或改坏防火墙）后触发 → 回复如实说「这次没查到」且**不编造外部事实**；恢复网络再问 → 正常带来源。
8. **关闭后零外发**：关闭开关 → 触发类消息不再有 `[web] 触发联网` 之检索行为（日志 `本次未联网（开关关闭）`），且模型看不到 `web_search`/`web_fetch` 工具。
9. **持久化**：来回切换/重启应用后设置保持不变；历史会话里这一轮的来源列表仍在（落 meta）。
10. ~~网页通道不联网~~ → **已作废（2026-10-10 web 通道移除）**；改为：把 baseUrl 改坏（不可达）→ 触发检索类消息，日志显示检索失败且回复如实说明，不编造外部事实。

## 6. 交接简区

- 编号：**H15**（H1-H14 已完成归档；H8-H14=同对话前序快照；H14=**Web 通道彻底移除** + 仓库约定文档；H15=**渲染层 IPC 接缝深化**（Fairy client + 两个 hook + 日程面板试点 + renderer 测试基建）+ 词表/ADR 落地）
- 源对话：本机 Pi 会话（阶段 7 GUI 验收闭环 + 阶段 8 Skill/MCP + 阶段 9 cron + 阶段 10 联网检索实现全程）；H13：阶段 10 提交入库（`ff20310`）+ `AGENTS.md`/`docs/agents/`；H14：按「彻底移除所有 Web 通道相关功能模块」完成全链路重构；H15：按 `/improve-codebase-architecture` 评审候选 1 完成接缝深化（三轮 grilling 确认方案）
- 状态：**H15：渲染层接缝深化试点落地（2026-10-10，工作区改动未提交）；H14：Web 通道已移除（同一工作区）；阶段 7 GUI 验收通过（tag `m5`）；阶段 8/9/10 代码完成、自动化验收全绿，GUI 人工验收待执行（清单 §5 ⑤/⑥/⑦）**。提交链（H15 之前）：阶段 8（`5268007` + `0f4f13b`）→ 阶段 9（`8591b05`）→ 接口风格 Responses（`25c911c`）→ 阶段 10（`ff20310`，**当前 HEAD**）。**H15 复验：507 单测通过**（core 472 passed + 1 skipped；desktop 35 passed）+ **三份 typecheck 绿** + **`electron-vite build` 绿**；tag `m1`-`m5` 在 `3b1dcd6`（**`m6`/`m7`/`m8` 未打**）。MVP GUI/干净虚拟机验收待做（不再有 web 依赖）。
- 用户已确认接续范围：阶段 7 全量（**已完成并验收**）；阶段 8 Skill/MCP（**代码完成待 GUI 验收**）；阶段 9 cron（**代码完成待 GUI 验收**）；阶段 10 联网检索（**代码完成待 GUI 验收**，默认开启、每次联网可见）；**唯一接入方式 = OpenAI 兼容 API**（web 通道已移除）；**渲染层经 Fairy client 访问 main**（ADR-0001）；无云同步/多用户。
- **接续第一步**：① 用户执行 §5 ⑤（阶段 8）+ §5 ⑥（阶段 9）+ §5 ⑦（阶段 10）GUI 验收——同一次 `pnpm dev` 可一并走（阶段 10 需外网可达）；② 验收通过 → tag `m6`（阶段 8=M6）、`m7`（阶段 9=M7）、`m8`（阶段 10=M8）；③ 并行可做 MVP GUI/干净虚拟机验收收尾；④ H14+H15 改动如需入库，先复核 diff 再提交（建议分两个提交：Web 通道移除 / 接缝深化）；⑤ 接缝深化的下一轮 = 其余 7 个面板迁到 Fairy client（`SessionSidebar` 最简，可作为第二个试点验证通用性）。
