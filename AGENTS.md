# Fairy 项目上下文

- README：`README.md`（面向人：功能/快速开始/开发命令）

- 总纲：`docs/DEV_PLAN.md`（v0.3，阶段 0-10、里程碑 M0-M8、验收标准）
- 本机环境备忘：`docs/DEV_PLAN.md` 附录 C（Node 24.21 路径 / ELECTRON_RUN_AS_NODE 陷阱 / npmmirror 镜像 / 打包命令）
- 蓝本（只读）：`reference/deepseek-pp/`
- **接入方式：仅 OpenAI 兼容 API**（chat / responses 两种接口风格）；DeepSeek 网页通道（`ds-free-api` 网关 sidecar）已于 2026-10-10 彻底移除
- 下一步总览见 `PROJECT_STATE.md`（当前：H14/H15 已入库（`9de0bca`），MVP 全阶段验收按 `79a395d` 已通过；H16 = 工具权限档位（默认 / 只读放行 / 全放行）落地，改动未提交，待 GUI 验收（清单 §5 ⑧）+ 入库；本地 tag 只剩 `Fairy_1.0.0_Setup_64`，`m0`-`m8` 是否重打待确认）

<!-- [交接] Fairy 状态=进行中 详情见 PROJECT_STATE.md（H16：① H14（Web 通道彻底移除）+ H15（渲染层 IPC 接缝深化：FairyClient/useResource/useAction/日程面板试点/renderer 测试基建/GLOSSARY/ADR-0001）**均已入库**，合并于 `9de0bca`；② 其后提交链：a9f83ff 修复联网 BUG → 48e1132 改人设 → 86ea361 联网只用 bing → 79a395d 版本 1.0.0（MVP 全阶段验收通过，补打 m6/m7/m8）→ 7f1e2b9 附录 C（主仓库 .git 重建）→ f603c3d 汉化 = 当前 HEAD；③ ⚠️ 本地 tag 只剩 Fairy_1.0.0_Setup_64，m0-m8 疑随 .git 重建丢失，是否重打待用户确认；④ H16=工具权限档位：三档 permissions.toolPolicy（default 逐工具按声明=现状零变化 / readonly 额外放行「内置+read」、不信第三方自述 / open 全部免确认含 shell+MCP+skill），核心不变量=档位只放宽「是否询问」不放宽「是否允许」（assess 的 deny、未注册恒拒绝，assess 的 ask 越界恒弹窗），改动面=core 新增 agent/permissions.ts + registry 只换 needsConfirm 的一项 + main permissions.ts/config/ipc/chat + preload + 设置页新增档位区与三处旧「每次确认」文案改中性；H16 复验 580 单测 + typecheck + build 绿；H16 改动**未提交**，待 GUI 验收（清单 §5 ⑧，重点 3/6/7 三条不变量）→ 入库；接缝下一轮=其余 7 面板迁移；独立议题=工具调用落库） -->

## Agent skills

### Issue tracker

Issues live as GitHub issues in `longge1213812138/project-overview-no-changes`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
