# LLM 桥接通笔记（阶段 1 / M0）

> 2026-09-27 验收通过。网关：ds-free-api v0.2.11（Rust 单文件，github NIyueeE/ds-free-api）。

## 1. 选型变更（重要，推翻 DEV_PLAN 假设）

DEV_PLAN §6 阶段 1 假设 ds-free-api 走「浏览器 F12 复制 deepseek.com cookie → 写 config」。**v0.2.11 已改为账号池自动登录**：

- 配置项为 `[[ds_core.accounts]]`：`email` 或 `mobile`/`area_code` + `password` + `device_id`（可选但强烈必填）。
- 网关启动时自动登录 DeepSeek 网页 API（含 PoW/wasm 计算），会话过期会自动重登；客户端不再接触 cookie。
- `device_id` 获取：Chrome 打开 chat.deepseek.com 等加载完，F12 Console 执行 `SMSdk.getDeviceId()`（或登录请求 Payload 里的 `device_id`）。设备级指纹，同机器多账号可复用，一次长期有效。
- 凭据现在由用户直接提供**账号+密码**（而非 cookie），敏感度更高：阶段 6 DPAPI 加密对象相应改为账号+密码+device_id。

备选 deeperseeker（Python cookie 注入）仍有效，仅在 ds-free-api 停更/被禁时启用。

## 2. 运行方式（已验证 2026-09-27）

- 二进制：`C:\Users\91533\.fairy-tools\ds-free-api\ds-free-api-v0.2.11-windows-x86_64\ds-free-api.exe`（SHA256 已对 SHA256SUMS 校验）。
- 默认端口 **22217**（DEV_PLAN 写的 8080 已过时）。`[server] host/port` 可改。
- 手动跑法：`ds-free-api.exe`（用当前目录 config.toml）或 `-c <path>`。
- **网关启动时会重写/归一化 config.toml**：手动改文件前先删掉会被覆盖的冲突键（如顶层 `api_keys = []` 与 `[[api_keys]]` 冲突会导致解析失败、静默回落默认配置）。改完**必须重启**进程生效（热重载仅管理面板可靠）。
- 鉴权：`[[api_keys]] key="sk-..."`（面板亦可创建）；无 key/错 key → 401 `invalid_api_token`。
- 健康检查：`GET /health` → `{"status":"ok"}`。阶段 2 sidecar 探活用这个。
- 管理面板：`http://127.0.0.1:22217/admin`（首访设密码；账号池/API key 可视化管理）。
## 3. 模型与请求约定

- model 取值：仅 `deepseek-default`（裸名 `default`，大小写不敏感）。**expert/vision 上游已下线**（2026-09 起网页端 model_configs 标记 disabled），勿启用。
- 深度思考默认开启 → 响应/流内含 `reasoning_content`；关闭：请求体加 `"reasoning_effort":"none"`。
- 智能搜索默认开启；关闭：`"web_search_options":{"search_context_size":"none"}`。
- 流式 SSE：`data: {...chunk...}`，**没有 `data: [DONE]` 结尾**，以 `finish_reason:"stop"`/连接关闭为终点。
- **每个 chunk 都带 `obfuscation` 字段（加密并行流），客户端必须忽略，只读 `delta.content` / `delta.reasoning_content`**。
- 流式 usage chunk 不可靠（`completion_tokens=0`）；意图解析等小调用用**非流式**拿完整 `message`+`usage`。
- 鉴权：`/v1/*` 必须带 `Authorization: Bearer <api_key>`（`[[api_keys]]` 或管理面板创建）。
- 上下文上限：input 1,048,576 tokens / 2,621,440 字符，output 384,000。

## 4. 报错指纹（供 5.5 过期检测）

| 场景 | HTTP | 响应体特征 |
|---|---|---|
| 无 key / key 错 | 401 | `{"error":{"message":"invalid api token","type":"authentication_error","code":"invalid_api_token"}}` |
| 会话/凭据失效（账号池无可用账号） | 429 | `{"error":{"message":"service overloaded","type":"server_error","code":"overloaded"}}`；网关日志 `账号池无可用账号` |
| 登录被风控拦截 | 启动即失败 | 日志 `Business error: code=11, msg=RISK_DEVICE_DETECTED`（缺 device_id） |
| 账号封禁 | — | `code=10 USER_IS_BANNED`（永久） |
| 临时禁言 | — | `code=5 user is muted`（`mute_until` 数周） |

- **过期检测策略**：网关启动自动登录，凭据失效时客户端可见指纹 = 持续 429 `overloaded` → Fairy 应触发重新配置引导（账号/密码/device_id）。
- 怪癖：账号池为空时请求可能**挂起无响应**（curl 000 超时）；阶段 2 客户端必须带超时 + AbortController。

## 5. 限速特征

- 上游为 session 级限速；网关内置退避重试（1s→2s→4s→8s→16s），超限窗口内请求会挂 429 `overloaded`。
- 建议并发 = 账号数 / 2；单账号下主链路保持串行即可。

## 6. 环境备忘

- 网关目录：`C:\Users\91533\.fairy-tools\ds-free-api\ds-free-api-v0.2.11-windows-x86_64\`（config.toml 内已含账号、device_id、`sk-fairy-dev` 开发 key）。
- github 当前可直连（2026-09-27 验证 200）；release 下载走官方即可，无需镜像。
- 网关启动会重写 config.toml：手动改配置后**必须重启进程**（热重载仅管理面板路径可靠）。
