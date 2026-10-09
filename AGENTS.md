# Fairy 项目上下文

- README：`README.md`（面向人：功能/快速开始/开发命令）

- 总纲：`docs/DEV_PLAN.md`（v0.3，阶段 0-10、里程碑 M0-M8、验收标准）
- 本机环境备忘：`docs/DEV_PLAN.md` 附录 C（Node 24.21 路径 / ELECTRON_RUN_AS_NODE 陷阱 / npmmirror 镜像 / 打包命令）
- 蓝本（只读）：`reference/deepseek-pp/`
- **接入方式：仅 OpenAI 兼容 API**（chat / responses 两种接口风格）；DeepSeek 网页通道（`ds-free-api` 网关 sidecar）已于 2026-10-10 彻底移除
- 下一步总览见 `PROJECT_STATE.md`（当前：阶段 7 验收通过；阶段 8 Skill+MCP、阶段 9 cron、阶段 10 联网检索代码完成待 GUI 验收（清单 §5 ⑤/⑥/⑦）；剩 MVP 收尾 + tag m6/m7/m8）

<!-- [交接] Fairy 状态=进行中 详情见 PROJECT_STATE.md（H15：① H14=Web 通道彻底移除（core gateway/main sidecar/网页登录引导/SessionExpiredError/网关打包分发全删 + 老配置一次性清理），唯一接入=OpenAI 兼容 API；② H15=渲染层 IPC 接缝深化：core 新增 FairyClient（接口由 FairyApi 派生、两种失败约定归一为 IpcResult），renderer 新增 useResource/useAction，日程面板迁为试点（零 window.fairy 直调），新增 vitest projects 分环境 + jsdom（renderer 首次有测试）+ GLOSSARY.md + docs/adr/0001；H15 复验 507 单测 + typecheck + build 绿；改动均未提交；GUI 验收待执行=清单 §5 ⑤/⑥/⑦；下一步=GUI 验收→tag m6/m7/m8；接缝下一轮=其余 7 面板迁移） -->

## Agent skills

### Issue tracker

Issues live as GitHub issues in `longge1213812138/project-overview-no-changes`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
