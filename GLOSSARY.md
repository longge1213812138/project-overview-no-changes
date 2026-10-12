# Fairy

Windows 桌面私人助手：本地单用户的聊天助手，带长期记忆、日程、定时任务与工具调用。

## Language

**Fairy client**:
渲染层访问 main 的唯一通道。取数与写操作都经过它，渲染层不直接触达底层传输。
_Avoid_: IPC 层, bridge, api wrapper

**Resource**:
一份从 main 取来、并会随 main 的变更声明而重新取的数据。
_Avoid_: 状态, 缓存, store

**Action**:
一次会改动状态的写操作。它带忙碌态，并以一条 Feedback 收尾。
_Avoid_: 命令, mutation, 提交

**Feedback**:
一次 Action 之后用户能看到的结论：成功或失败，各附一句说明。
_Avoid_: 提示, toast, notice, error 对象

**工具调用**:
模型请求执行一次工具；它可能被直接放行、交由用户确认，或被拒绝。
_Avoid_: Action, 命令, 函数调用

**风险级别**:
工具声明自身能力的三档标记：read（只读）/ write（有副作用）/ exec（进程、系统级）。
_Avoid_: 危险等级, 权限级别

**权限档位**:
决定哪些工具调用仍需用户确认的全局设置，三档：默认 / 只读放行 / 全放行。档位只改变「是否询问」，不改变「是否允许」。
_Avoid_: 权限等级, 信任级别, 模式
