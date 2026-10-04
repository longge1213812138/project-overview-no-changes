# Fairy 项目交接材料

> 交接编号：**H11**（H8/H9/H10 同对话前序快照）｜ 状态：**阶段 7 GUI 验收通过（tag `m5`）；阶段 8（Skill+MCP）与阶段 9（cron）代码完成、自动化验收全绿（374 单测），GUI 人工验收待做（清单 §5 ⑤/⑥）；MVP GUI/干净虚拟机验收待做；下一步 = 阶段 8+9 GUI 验收 → tag m6/m7** ｜ 更新时间：2026-10-05
> 工作目录（绝对路径）：`C:\Users\91533\Desktop\Fairy`
> **本次开发实际工作目录**：`C:\Users\91533\Desktop\Fairy.worktrees\project-overview-no-changes`（git worktree，main 分支）

## 1. 任务与版本

- **目标**：Fairy = Windows 桌面私人助手，以 **DeepSeek 网页版**（chat.deepseek.com 会话）为 LLM 后端，零 API 成本。MVP 范围 F1–F7 见 `docs/DEV_PLAN.md` §1。
- **范围（MVP）**：聊天（流式）、多会话、"帮我记东西"、日程+托盘通知、FTS5 长期记忆、托盘/Alt+Space 浮窗/开机自启、登录引导流。
- **MVP 后续范围（用户决定，2026-10-03）**：阶段 7–9：工具循环/Agent/本地 Shell、Skill、MCP、cron 定时引擎；**不做云同步和多用户**，产品保持本地单用户。
- **完成标准**：M0–M4 为 MVP；当前 MVP 阶段 2/3/4/5 + 通道选择 + 阶段 6 打包硬化代码完成（待 GUI 验收 + 干净虚拟机验收）。阶段 7 工具循环/注册表/审批 IPC/受控 Shell **GUI 验收已通过**（「第二次审批框不弹」四轮修复破案=审批 id 被 registry 负载 id 覆盖，修复⑤+回归测试钉死）。**阶段 8 Skill+MCP（`5268007`/`0f4f13b`）与阶段 9 cron 定时引擎代码完成 + 自动化验收全绿（374 单测），待 GUI 人工验收（§5 ⑤/⑥）**；M5–M7 三阶段代码全部完成。
- **git 位置**：历史（当前唯一提交 = 根提交 `b001520 "MVP"`，81 文件）：
  - `bf06919` 阶段 0：pnpm workspace + Electron 骨架 + 图标 + NSIS 打包通过
  - `b9932fe` docs：附录 C 本机环境备忘
  - `5573a02` + tag `m0`：阶段 1 LLM 桥接通（docs/llm-bridge-notes.md）
  - `075937f` 阶段 2：sidecar 化 + 登录引导流
  - `011a6e9`/`fdf536d` 阶段 3：会话系统 + 聊天 UI + 双窗口
  - `129c655` 阶段 4：记忆（FTS5）+ 意图解析管线
  - `f4e61df` 通道选择：启动不自动登录，用户选 OpenAI API 或 DeepSeek 网页（§5.6）
  - `75876c5` 阶段 5：日程（意图 schedule_* + 通知轮询 + 面板）
- **tag**：**`m1`/`m2`/`m3`/`m4`/`m5` 全部归位至 `3b1dcd6`**（2026-10-04 用户指示执行：`git tag -f m1 m2 m3` 从 `b001520` 移至修复+验收提交、补打 `m4`=阶段 6/M4、`m5`=阶段 7/M5 验收通过）。`m0` 不在当前 tag 列表（历史 squash 后未保留）。
- **文档版本**：`docs/DEV_PLAN.md` v0.3（MVP 后续路线图；范围含阶段 7–9，不含云同步/多用户）。

## 2. 权威资料

| 资料 | 位置 | 管哪部分 |
|---|---|---|
| 开发计划（架构/阶段/验收/数据模型/风险） | `docs/DEV_PLAN.md`（v0.3） | 全部任务事实的总纲；验收标准以 §6 各阶段"验收"为准 |
| 本机环境备忘（Node 路径/镜像/打包命令/陷阱） | `docs/DEV_PLAN.md` 附录 C | 本机 Windows 开发环境与打包操作 |
| 蓝本（只读参考，nested gitlink，不参与构建） | `reference/deepseek-pp/` | 仅借鉴设计（记忆系统命名、schema 迁移规则）；自建网关（阶段 6 可选项）才需精读其 `core/deepseek/*` |
| 阶段 1 产出（已完成） | `docs/llm-bridge-notes.md`（已创建） | LLM 网关的 model 取值、会话过期报错指纹、限速特征 |

冲突规则：DEV_PLAN 与蓝本冲突时以 DEV_PLAN 为准；仅参考蓝本设计，不把蓝本的工具执行或自动化权限机制直接视为本项目决策。

## 3. 决定与限制

**用户已确认（DEV_PLAN 即用户认可的方案）**：
- MVP 的 LLM 通道：OpenAI 兼容 `/v1/chat/completions` 流式即可，不要求 tools；阶段 7 Agent 扩展现正加入 tools 请求/响应支持，**仅验证 API 通道**（web 通道不做 tools 适配与测试，2026-10-03）。
- 网关选型：**ds-free-api（Rust 单文件）为 sidecar 首选**，deeperseeker（Python）备选；main 进程 spawn 管理生命周期。
- "记东西/日程"走**意图解析**（非流式小调用出严格 JSON）不走工具调用；解析失败一律兜底 `chat`，绝不写脏数据。
- 数据库：better-sqlite3（WAL + FTS5），关键词+权重检索，**不引入 embedding**。
- 配置存 `%APPDATA%/fairy/config.json`；凭据存 `secrets.dpapi.json` 并由 Electron `safeStorage`（Windows DPAPI）保护，旧明文自动迁移。

**Agent 自行选择（待用户推翻）**：
- 浮窗 380×560、主窗口底部 tab（日程/记忆/设置）布局、上下文裁剪预算 6000 token 等 DEV_PLAN 参数。
- 阶段 0 采用 electron-vite 模板结构。
- **阶段 6 实施选择（2026-10-02）**：① DPAPI 用 Electron `safeStorage`（= CryptProtectData，零原生依赖；npm 无 `@kingsu/windows-dpapi`，本机也不能编译原生模块），密件单独存 `secrets.dpapi.json`；② 开机自启 Run 值名 = AUMID `com.fairy.assistant`（实测 Electron 39：值名不对则 `openAtLogin` 恒 false）；③ 打包随包分发 ds-free-api 网关二进制（`stage-extras.mjs` 预置，不入 git）；④ 网关 config.toml（含明文密码）停止/退出即删，下次启动重写。

**用户新决定（2026-09-27）**：
- **阶段 5（日程）**：一度暂缓，同日恢复并完成（见 §4 与 `75876c5`）。
- **通道选择优先**：启动不自动登录 DeepSeek 网页，设置页让用户选 OpenAI 兼容 API 或 DeepSeek 网页（已实现，DEV_PLAN 新增 §5.6）。

**用户新决定（2026-10-03）**：
- MVP 完成后继续阶段 7–9：Agent/工具循环/本地 Shell、Skill、MCP、cron。
- 不做云同步和多用户；继续本地单用户产品边界。
- Shell 目标权限为默认限当前工作区、越界操作需用户确认；工作目录本身不构成 OS 隔离，须选定并验证隔离边界（后续指令：阶段 7 直接实现 Shell 并验收，不再暂缓）。
- 阶段 7 工具调用只走 **API 通道**：不做 web 通道的 tools 适配与测试；web 通道保留聊天功能，激活 web + 已注册工具时须明确能力提示、不得静默降级。

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
| 阶段 1 LLM 桥接通 | ✅ **已完成（2026-09-27）** | 网关 ds-free-api v0.2.11 跑在 127.0.0.1:22217，账号池+device_id 登录成功，流式 curl 验收通过，结论已写入 `docs/llm-bridge-notes.md` |
| 阶段 2 sidecar+登录流 | ✅ **代码完成（2026-09-27），待人工 GUI 验收** | core：`llm/`（流式/退避/SessionExpired 指纹，单测 25 绿含真实网关集成）+ `gateway/`（spawn/日志扫描/taskkill 树杀）；main：`config.ts`（config.json + 一次性迁移）/`sidecar.ts`/`ipc.ts`/托盘红图标；设置页四步引导流+测试对话；build 产物曾因 `@fairy/core` 外部化崩溃→已改 `externalizeDepsPlugin({exclude:['@fairy/core']})`+renderer 走 `index.web.ts` |
| 阶段 3 会话+聊天 UI | ✅ **代码完成（2026-09-27），待人工 GUI 验收** | core：`store/`（WAL+版本化迁移 fail-visible）+ `sessions/`（CRUD/自动标题/9000 字符裁剪/quick 会话），测试 48/48 绿；main：`windows.ts`（浮窗预建/Esc+blur 收起）+ `hotkeys.ts`（Alt+Space 失败降级）+ `chat.ts`（单飞流式编排，delta/done/busy 广播，stop 保留部分，过期→托盘红）；renderer：底部 tab + 会话侧栏 + ChatPane（react-markdown 流式、停止按钮、浮窗 `?float=1`） |
| 阶段 4 记忆 | ✅ **代码完成（2026-09-27），待人工 GUI 验收** | 迁移 v2（memories+trigram FTS+触发器，真实库 v1→v2 烟测升级成功）；意图 remember/forget/chat（失败兜底 chat）；检索三层候选+coverage×kind权重×0.95^天衰减 top-8（验收召回场景有单测）；chat 三步管线+空闲 5min 抽取；记忆面板（五色筛选/增删改/导出导入/onChanged 实时刷新）；测试 97/97 绿 |
| 阶段 5 日程 | ✅ **代码完成（2026-09-27），待 GUI 验收** | 迁移 v3（events+索引，真实库 v2→v3 烟测）；意图 schedule_add/done/cancel/query（add 非法时间追问一次、不写脏数据）；notify-loop 30s 轮询→通知→点通知开日程 tab、启动 sweep 已过期不补弹、退出前未触发提示；CalendarPanel（今天/明天/全部/勾选/手动增删/徽章）；测试 137/137 绿 |
| 通道选择（§5.6，插入需求） | ✅ **完成（2026-09-27），待 GUI 验收** | 启动零登录烟测通过（12s 零 ds-free-api 进程/零端口）；channel=null 选择卡、API 表单（baseUrl/key/model）、网页通道需手点「启动网关」才登录、切 API 自动停网关、过期指纹按通道门控（仅 web 上报托盘红） |
| 阶段 6 打包硬化 | ✅ **代码完成（2026-10-02），本机烟测通过，待干净虚拟机验收** | `electron-builder.yml`（NSIS+portable、extraResources 带网关二进制/双图标）+ `resources/installer.nsh`（安装选项页「开机自启」默认勾选，`/S` 也默认开；卸载清理 Run 键）+ `scripts/stage-extras.mjs`；凭据 DPAPI：`main/secrets.ts` + `config.ts` 重写（明文自动迁移、config.json 只剩非敏感字段）；日志 `main/logger.ts`（electron-log 按天滚动留 7 天 + 崩溃/子进程留痕）+ 诊断导出 `main/diagnostics.ts`（脱敏报告）+ 设置页「应用」区（自启开关/导出诊断/日志目录）+ `main/autostart.ts`。烟测：打包出 `Fairy Setup 0.0.1.exe`（112MB）+ `Fairy-0.0.1-portable.exe`（112MB）；静默安装→Run 键 `com.fairy.assistant` 写入→实机启动日志 `[autostart] openAtLogin=true`→静默卸载键/目录/卸载项全清；旧明文 config 自动迁移到 `secrets.dpapi.json`（protected:true，打包/开发两种上下文解密均成功），`config.json` 已无任何凭据；137 测试绿 + typecheck 绿 |
| 阶段 7 Agent 工具运行时 | ✅ **代码完成（2026-10-03），待 GUI 人工验收** | core：`agent/runtime`（有界循环+授权决策 allowOutside/reason 穿透）、`agent/registry`（ToolRegistry + createRegistryAuthorizer，风险/审批/assess 策略，默认拒绝）、`agent/capability`（probeToolsSupport 两段探测三态）、`agent/tools`（pathguard 真实路径边界 + workspace_files + get_current_time + 受控 shell：白名单9命令/危险名单先查/spawn 无 shell/最小 env/输出截断）。main：`agent-approval.ts`（广播审批+60s超时拒绝+停止取消+全日志）、`agent-tools.ts`（workspace=%APPDATA%/fairy/workspace + 注册表装配 + 探测缓存）、chat 接线（通道门控+capabilityHint+toolNotice 广播）、浮窗 Esc 豁免。renderer：`ApprovalDialog`（队列/默认拒绝/Esc拒绝/越界红条）+ ChatPane 状态行/hint 灰条（落 meta 重开仍在）。证据：**227 单测 + 4 E2E 全绿、全仓 typecheck 绿、build 绿、bundle 实测无 OS 执行器、真实 agnes API 探测=supported(required)**。Shell 边界=白名单+路径边界+进程管控（**非 OS 级沙箱**，本机无原生依赖；DEV_PLAN 阶段 7 实施备注已如实声明）。**提交链**：`200da53`主体 → `cf88e41`/`2dfdf7f`/`41948d7`/`50f9a22` 审批框 GUI 缺陷四轮修复 → 修复⑤ 根因（审批 id 主权）+ 回归测试 3 项（详见 §5 ③ 进展实录）。 |
| 阶段 8 Skill+MCP | ✅ **代码完成（2026-10-04），自动化验收全绿，待 GUI 人工验收** | core：`agent/skill`（skill.json 严格解析 fail-visible / 发现+内容指纹 sha256 / electron-as-node 执行器：无 shell+最小 env+超时截断可取消 / 装配）+ `agent/mcp`（JSON-RPC 2.0 行协议 / stdio 客户端生命周期 initialize→tools/list→call、反向请求回 -32601、意外退出可见、taskkill 树杀 / 装配）+ `skill/schema` 零依赖 JSON Schema 子集校验器；main：`skills.ts`（新发现默认禁用、内容变更自动回禁用、状态入 config.json）+ `mcp.ts`（配置明文、**env 走 DPAPI**、用户驱动连接、退出树杀）+ IPC/preload（skills:* 与 mcp:*）；renderer：设置页「技能」区 + 「MCP 服务器」区。安全不变量：skill/mcp **审批恒 ask**、mcp risk 恒 exec、权限/来源进审批描述；**入口隔离**（执行面不进 index.web，测试断言）。证据：**skill 41 + mcp 17 新增测试，全仓 282+3 单测 + typecheck + build 全绿**；GUI 样例 `examples/skills/demo-echo`（含验收 README）+ `examples/mcp-demo-server.js`。**提交链**：`5268007`（Skill）→ `0f4f13b`（MCP）。 |
| 阶段 9 cron 定时引擎 | ✅ **代码完成（2026-10-05），自动化验收全绿，待 GUI 人工验收** | **迁移 v4**：`cron_tasks`（next_run_at/last_fired_at/preauthorized JSON/catchup/max_retries/failure_limit/consecutive_failures/pause_reason）+ `cron_runs`（**UNIQUE(task_id,scheduled_for) 幂等键**、attempt/manual/next_retry_at/output/error）。core `agent/cron`：`schedule`（5 字段 cron+宏、Vixie OR、Intl 时区、DST 缺口跳过/重叠取早、latestDue 错过合并、未来无触发保存期拒绝，38 测）+ `store`（幂等 claim、并发 skipped、状态迁移守卫、失败暂停，27 测）+ `policy`（planTrigger/planRecovery 纯决策、**预授权硬条件+越界永不授予+升级暂停**、无人值守提示词，14 测）+ 迁移 3 测；main `cron.ts`（10s tick、启动恢复 running→interrupted/陈旧 pending 按 catchup、串行执行队列、仅 API 通道门控、超范围/连续失败→暂停+通知点通知切「定时」tab、重试指数退避、IPC 面）+ 7 驱动测试；renderer：底部「定时」tab `CronPanel`（新建/编辑/暂停/恢复/立即运行/删除/运行历史展开）。**入口隔离**：cron 执行面不进 index.web（断言 createCronStore/createCronAuthorizer/planTrigger/planRecovery）。证据：**全仓 374 单测 + typecheck + build 全绿**；语义与验收对照见 DEV_PLAN 阶段 9 实施备注。 |

代码现状：`packages/core` 含 llm/gateway/sessions/store/memory/intent/calendar（阶段 2-5）与 agent（runtime/registry/capability/tools，阶段 7；skill/mcp，阶段 8；**cron/schedule+store+policy，阶段 9——均仅完整入口，执行面不进 renderer**）；main 含 config/secrets/logger/autostart/diagnostics/sidecar/ipc/chat/extract/notify-loop/windows/hotkeys + agent-approval/agent-tools/skills/mcp/cron；renderer 含 ChatPane/SessionSidebar/MemoryPanel/CalendarPanel/CronPanel/SettingsTab（含技能区+MCP 区）+ ApprovalDialog + 底部 tab（聊天/日程/记忆/定时/设置）。**尚未做**：阶段 8 与阶段 9 GUI 人工验收（清单 §5 ⑤/⑥）、MVP GUI 验收、干净虚拟机验收。

**已解决/已知事实**（原“未确认项”已全部落地）：ds-free-api v0.2.11 本机下载+运行 OK；账号池+device_id 登录 OK（应用侧凭据由 DPAPI 保护；网关运行配置含临时明文，停止/退出即删，勿入 git）。

## 5. 接续动作

**当前并行事项**：① **【阻塞在用户侧】阶段 8 GUI 人工验收**（清单见 §5 ⑤，样例 `examples/skills/demo-echo` + `examples/mcp-demo-server.js`，需 `pnpm dev` 重启）；② **【阻塞在用户侧】阶段 9 GUI 人工验收**（清单见 §5 ⑥，同一次 `pnpm dev` 可一并做）；③ MVP GUI/干净虚拟机验收（web 项等 10-11 解禁）；④ 两项验收通过后打 tag `m6`（阶段 8=M6）/`m7`（阶段 9=M7）。

**① GUI 验收清单（阶段 2/3/4/5 + 通道选择合并，DEV_PLAN §6 各阶段验收 + §9 M2/M3）**：
1. `pnpm dev`（新终端，Node 24，`ELECTRON_RUN_AS_NODE` 未被继承）。
2. **聊天（阶段 3）**：底部 tab；新建/切换/删除 10 个会话；流式 markdown；停止按钮保留已生成部分；**Alt+Space 浮窗**问答、Esc 收起；重启后历史完整。
3. **设置（阶段 2）**：测试对话绿卡；改坏密码→保存→托盘红+红卡→改回恢复；托盘退出后无 ds-free-api 残留。
4. **记忆（阶段 4，M2 验收）**：
   - 聊天说「记住：我喝美式不加糖」→ 回复开头有确认语；**新开会话**问「我咖啡怎么喝」→ 答案能引用该记忆；
   - 记忆面板出现该条（kind=note）；删掉后新会话再问 → 不再引用；
   - 面板手动新增/编辑/筛选/搜索/导出 JSON/导入同文件（应显示 skipped 去重）；
   - 闲聊后等 5 分钟（或下轮对话前）观察抽取入库 preference/fact 类记忆（面板 onChanged 刷新）；
   - 连续聊 10+ 轮，面板误入库目测可接受（prompt 可调，DEV_PLAN §6 阶段 4 验收第 3 条）。
5. **通道选择（§5.6）**：
   - 首次进设置页显示双通道选择卡（config 无 channel）；
   - 选 API：填 baseUrl+key+model → 保存启用 → 测试对话通；**全程无 ds-free-api 进程**；
   - 切到网页：保存账号 → 点「启动网关」才登录（tasklist 出现 ds-free-api）→ 测试对话通；
   - 切回 API → 网关自动停（进程消失）；重启 Fairy → **不自动登录**，网页通道需再点一次启动；
   - 会话过期红卡仅网页通道出现（已按通道门控）。
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
   - **干净虚拟机**：安装（注意安装选项页「开机自启」默认勾选）→ 首启选通道完成首次登录 < 10 分钟（网关二进制已随包，无需另装）；
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
7. web 通道：切到网页通道发任意消息 → 气泡下灰条「当前为 DeepSeek 网页通道，工具调用仅支持 API 通道…」（重开会话灰条仍在，已落 meta）。
8. 浮窗（Alt+Space）触发审批 → 对话框出现，且**有 pending 时 Esc 不收窗**（Esc=拒绝）；失焦收窗仍正常。
9. 主窗与浮窗同时收到审批 → 任一窗口响应后另一窗对话框自动关闭（settled）。
10. 生成中点「停止」→ 悬挂审批立即以 cancelled 关闭，无残留对话框。

**注意事项**：**web 账号已被禁言（muted，2026-10-03 实测，至 2026-10-11 21:37）**——web 通道聊天验收需等解禁；阶段 7/8 工具测试不受影响（已定仅 API 通道）。**阶段 7 新增**：① Electron safeStorage 的 DPAPI 熵绑定 app name（dev/打包均 productName=Fairy 故互通；外部解密脚本必须 `app.setName('Fairy')`，见 scripts/unlock-e2e-config.cjs）；② E2E 复跑：`npx electron scripts/unlock-e2e-config.cjs` → `FAIRY_E2E_CONFIG=<路径> vitest run src/agent/e2e.api.test.ts`（key 不落日志）；③ LLM client endpoint 已归一（baseUrl 带完整 /v1/chat/completions 路径不再二次拼接）；④ shell 白名单/越界审批是当前唯一执行边界，扩白名单前先过 DEV_PLAN 阶段 7 实施备注的残余风险评估。通道选择遗留：`gateway:getState/configure/state` 通道名不在 IPC 常量表（兼容保留）；done/cancel 匹配依赖 title LIKE 关键词（模型分词质量影响命中）；通知单次触发（构造异常也 markFired 防刷屏）；空闲抽取是全局单例 5min 定时器；面板列表 limit 无分页（memory 200/events 500）；`.pi/` 已入 .gitignore；生成中切走再切回占位为空、bundle >500kB 等阶段 3 遗留仍有效；`electron-builder.yml` 已设 `npmRebuild: false`，阶段 6 打包需补 extraResources（红图标+网关二进制）。

**④ 下一步开发计划（2026-10-04 拟定，按 DEV_PLAN v0.3 路线）**：

1. **收尾（MVP 验收）**：MVP GUI 验收清单①剩余项补验（web 通道项等账号 2026-10-11 解禁）→ 干净虚拟机验收（清单第 8 条 = 阶段 6/M4）→ ~~tag 归位~~ ✅ **已执行（2026-10-04）**：`m1`/`m2`/`m3` 移至 `3b1dcd6`、补打 `m4`，与 `m5` 同点；剩余 = 试用反馈。
2. ~~**阶段 8（M6）：Skill 与 MCP**~~ → ✅ **代码完成（2026-10-04，`5268007` Skill + `0f4f13b` MCP）**，自动化验收全绿；设计前置（信任/分发/沙箱/凭据策略）已按 DEV_PLAN §5.8 细化并写入实施备注（默认禁用+指纹防篡改+恒 ask+无网络安装+env 走 DPAPI+不自动连接外部进程），**待用户推翻或 GUI 验收（清单⑤）**。
3. ~~**阶段 9（M7）：cron 定时引擎**~~ → ✅ **代码完成（2026-10-05）**，按 DEV_PLAN v0.3 阶段 9 三条落地：迁移 v4（cron_tasks/cron_runs 幂等键）、时区/DST/错过/重启/并发/失败语义、预授权+超范围暂停通知、「定时」tab 查看/暂停/恢复/编辑/删除入口。**已确认语义与测试证据全部写入 DEV_PLAN 阶段 9 实施备注**；374 单测 + typecheck + build 全绿。**待 GUI 人工验收（清单⑥）→ 过后打 tag `m7`**。

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
11. **通道门控**：切到网页通道 → 任务到点 → 该轮失败 + **立即暂停** + 通知（仅支持 API 通道/通道不可用）；切回 API 恢复后继续。
12. **与日程分开**：定时任务不出现在日程 tab；日程提醒（阶段 5）不进运行历史；两边互不影响。
13. **重启恢复不重复**：连续重启两次，历史不因重启多出重复记录（幂等键；日志无同刻两条 `触发`）。

## 6. 交接简区

- 编号：**H11**（H1-H10 已完成归档；H8/H9/H10=同对话前序快照）
- 源对话：本机 Pi 会话（阶段 7 GUI 验收闭环 + 阶段 8 Skill/MCP + 阶段 9 cron 实现全程）
- 状态：**阶段 7 GUI 验收通过（缺陷关闭，tag `m5`）；阶段 8 Skill+MCP 与阶段 9 cron 代码完成、自动化验收全绿，GUI 人工验收待执行（清单 §5 ⑤/⑥）**。代码提交至阶段 9 提交（阶段 8：`5268007` Skill + `0f4f13b` MCP；阶段 9 见下方提交链），worktree main 分支全部已提交；**374 单测**（core 364 + desktop 10）+ typecheck + build 全绿；tag `m1`-`m5` 在 `3b1dcd6`。MVP GUI/干净虚拟机验收待做（web 账号禁言至 2026-10-11）。
- 用户已确认接续范围：阶段 7 全量（**已完成并验收**）；阶段 8 Skill/MCP（**代码完成待 GUI 验收**）；阶段 9 cron（**代码完成待 GUI 验收**）；工具调用仅 API 通道；web 通道不做 tools；无云同步/多用户。
- **接续第一步**：① 用户执行 §5 ⑤（阶段 8）+ §5 ⑥（阶段 9）GUI 验收——同一次 `pnpm dev` 可一并走；② 验收通过 → tag `m6`（阶段 8=M6）、`m7`（阶段 9=M7）；③ 并行可做 MVP GUI/干净虚拟机验收收尾。
