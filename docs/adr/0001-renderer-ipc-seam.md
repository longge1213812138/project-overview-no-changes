# 渲染层只经 Fairy client 访问 main

Status: accepted (2026-10-10)

渲染层面板不直接调用 `window.fairy`，只经 core 的 `FairyClient`（由 `createFairyClient(api)` 派生）取数与写操作。
原因：main 的 IPC 契约上并存两种结果约定（部分通道 `throw`，部分通道 resolve `{ ok: false, error }`）；若每个面板各自判错，
错误文案、忙碌态与「订阅并刷新」会在每个面板重复一遍。归一到 client 之后，面板只面对一种结果形状，失败一定不抛。

## Considered Options

- **在 main 侧统一错误约定**：改动面更大（要动每条 handler 与既有测试），且本轮只想动渲染层这一条接缝。
- **把 client 放在 renderer**：`FairyApi` 的家在 core；放 core 才能零依赖单测（无 React、无 DOM、无 electron），main 侧也能复用。
- **用 React context 注入 transport**：默认参数已足够让测试替换 `window.fairy`，context 等真需要「整棵子树换数据源」时再加。
- **手写每个域的方法清单**：会与 `FairyApi` 手动保持同步、必然漂移；改由类型映射派生，契约新增方法时 zero-diff。

## Consequences

- 新增 IPC 方法不需要新增 wrapper：client 的接口由 `FairyApi` 的类型映射派生，运行时按「返回 Promise 的调用」自动归一
  （`{ ok: false }` 与 `throw` 都变成失败结果；`{ ok: true, ... }` 的结果外壳被剥掉，只留领域字段）；同步返回值（订阅、退订）原样透传。
- `window.fairy` 仍是唯一 transport。测试通过给 hook 传替身 client 来替换它，不需要 mock `ipcRenderer`。
