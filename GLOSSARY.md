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
