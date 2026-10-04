# Fairy Skill 演示样例（阶段 8 GUI 验收用）

## 安装（手工放置，应用不提供网络安装）

把 `demo-echo` 整个目录复制到技能扫描根：

```
%APPDATA%\fairy\skills\demo-echo\
  skill.json
  tools\echo.js
```

然后打开 Fairy → 设置 → 技能（Skill）→「重新扫描」。

## 预期行为（对照 PROJECT_STATE.md §5 ⑤ 验收清单）

1. 列表出现 `demo-echo v1.0.0`，状态 = **已禁用**（新发现默认禁用），来源/声明权限/工具可见；
2. 勾选启用 → 聊天里说「用 demo_echo 工具回显 hello」→ 审批对话框出现
   （「扩展」徽标，描述尾部含 `来自 Skill「demo-echo v1.0.0」· 来源 · 声明权限`）；
3. 「允许」→ 回复含 `{ok:true, echoed:{text:"hello"}, env:{...}}`；
   其中 `env.leakedAppSecret` 必须为 `null`（最小 env 不泄漏应用凭据）；
4. 篡改测试：编辑 skill.json 加一个未知字段 → 重新扫描 → 列表红字
   「加载失败（整包拒绝）：skill.json 含未知字段…」；
5. 变更测试：启用后修改 tools/echo.js 内容 → 重新扫描 → 自动变
   「已禁用 + 内容已变更」，需重新勾选启用（供应链防篡改）；
6. 拒绝路径：模型带非法入参调 `demo_bad_input`（text 不以 ok 开头）→
   审批前即被入参校验拒绝，回复可见拒绝原因。
