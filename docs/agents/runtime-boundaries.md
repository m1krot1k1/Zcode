# 进程、工作区与实时链路边界

修改 main/host/services 的进程职责、工作区隔离、session/task、输入队列、stream、snapshot 或远控链路前读取。这里只保留跨模块约束；具体实现以对应当前事实文档和契约为依据。

## 进程归属

- App 通过子进程 stdio 与 Agent 通信，协议为 `@zcode/protocol`。
- Main 只负责窗口/native dialog、进程 fork、广播中转、日志接收，以及远控鉴权/配对/心跳、payload 透传和 host attachment 调度；session/task、stream、queue、snapshot 业务状态保留在业务 owner。
- 每个 BrowserWindow 有且只有一个 window-scoped Local Host，通过 MessagePort 直连 renderer。同一窗口的多个本地 workspace tab 共用该 Host，服务按 workspaceKey 隔离；不要把 workspace service scope 变成独立 Host 进程。
- Local Host 通过 `createLocalServices({ parentPort })` 承载 file/system/terminal/setting/credential/broadcast，并按 workspaceKey 管理本地 Agent CLI。
- SSH/WSL/Docker/Server 工作区由同一 Local Host 的 `RemoteConnectionRegistry` 创建或复用连接，作为逻辑 tab/session 打开；不创建独立 Desktop Remote Host，broadcast 仍属桌面本地行为。
- 手机 `/remote` 通过 shared-host attachment 连接桌面已有 local host 或 remote workspace session host。为手机另建独立 runtime、local host 或 SSH/WSL/Docker session 属于架构变化，需先沟通、更新架构文档并完成桌面/手机回归。
- 外部 relay 仅承担鉴权、配对、心跳和 `rpc-frame`/app payload 透传，不持有业务状态。

## 并发启动与释放

同一 `workspaceKey` 的模型执行启动由 Service 中同一个在途 Promise 承担，覆盖 Provider
readiness 读取、只读 runtime 复用/启动和模型执行能力提升。并发的 warmup、草稿预热与首次
发送共享该结果；不能把另一个调用成功后移除等待记录误判成 workspace 已释放。
真实 `disposeWorkspace` 仍取消旧等待 identity，旧 continuation 不得复活 runtime；重新打开
同一路径使用新 identity。Provider 未就绪时不启动，后续 ready 事件仍可重试。
ready 事件若与旧 readiness 读取交错，先等待旧尝试收口，再确认 waiting identity 并读取新状态，
不能让新事件复用旧的未就绪结果后消失。

```text
warmup / createSession / sendText → workspace startup Promise → ready → 各自命令
                                            │
                            disposeWorkspace → cancelled → 旧调用失败
```

此状态只控制 runtime 启动，不接管 CLI CommandInbox；桌面 continuous 与手机 replayable
继续使用各自可信 clientMode 和同一个 shared-host runtime。

## 工作区身份

- `workspaceIdentity` 是身份/隔离，`workspacePath` 是真实文件路径。所有身份判断统一使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。
- 身份语义包括 tab 去重、session 绑定、缓存/队列/持久化 key、跨进程请求关联、工作区配置目录隔离和远程历史匹配。
- 文件读写、命令 cwd、Git 操作、路径展示和用户路径输入继续用 `workspacePath`。
- 远程工作区必须传递 `workspaceIdentity`；构造/解析复用统一工具，如 `buildRemoteWorkspaceIdentity`，不在业务代码中手写拼接规则。
- 本地继续允许不传 identity，走 path fallback，不新增本地 identity 格式。工作区隔离接口支持可选 identity，保持旧调用兼容。
- 远控链路贯穿 `workspaceIdentity` 和 `remoteSessionId`；snapshot、queue、command、缓存/去重 key 不能只按 path 匹配。

## 输入与实时消息

```text
桌面 desktop-continuous ─ direct continuous 实时链路 ─┐
                                                    ├─ 各自 task 运行时
手机 web-remote-replayable ─ snapshot + gap 恢复 ──────┘

桌面/手机提交输入 → 可信 attachment 注入 clientMode
                 → CLI/runtime CommandInbox 串行 admission → FIFO 执行
Renderer：未提交草稿 + pending optimistic overlay
```

- 桌面默认 direct continuous；手机远控默认 replayable。桌面不拼接手机的运行态恢复消息，手机不绕过 replayable gap/snapshot 恢复。
- 修改 `getTaskSnapshot`、dynamic task event、runtime snapshot、queued prompt、task command、permission/elicitation、stop generation 或重连恢复时，显式传递/核对 `clientMode`、`deliveryKind`。
- 已提交的 busy/running 输入统一由 CLI/runtime `CommandInbox` 接收，FIFO 以 CLI 串行 admission 顺序为准。Host 只转发任务元数据和 session route，不重新保存第二份 accepted input queue；command 保留可信 attachment 注入的 clientMode。
- 当前生产装配**没有** Host 级 owner/lease/mirror 层：Host 不创建 `createTaskRealtimeBridgeForHostInit`，也不向 task service 注入 realtime port。移动端与桌面的会话内容以 V4 conversation topic 为权威读路径，bots 仍走 adapter 的 legacy `onDynamicTaskEvent` 读路径。
- `TaskRealtimeBus` 仍负责跨 Host session route（`SessionRouteAnnounce`、`SessionMessageSendRequested`、`SessionMessageDeliver`）。它的 lease、stream mirror、owner-command 状态没有生产生产者/消费者，只保留 shared wire schema 兼容；不要再把这段状态描述成当前路由层。
- 若未来要恢复镜像或 owner-command，必须先补齐消费者，验证 stale run、跨端去重（同一文本不重复渲染）与 mobile relay 恢复语义，再替换本段约束。

修改上述远控/实时行为前，按问题读取以下当前事实文档；历史 plan/spec 仅作背景：

- [远控架构](../web-remote-control/web-remote-control-architecture.md)：attachment、进程职责与远程工作区。
- [实时同步](../web-remote-control/task-realtime-sync.md)：continuous/replayable、snapshot、gap 和重连。
- [输入队列](../web-remote-control-task-command-queue.md)：CommandInbox、admission 与跨端 command 路由。

## Host 生命周期回收

- Host 的 per-session 内存镜像（事件序号/去重、traceId、session emitter）只属于当前 runtime；会话关闭/删除、或 runtime 发布 `unavailable` 后必须释放。
- emitter 是否可销毁由订阅者数量决定：还有活跃订阅时保留，最后一个订阅者离开后由 `onDidRemoveLastListener` 回收；禁止在 close/delete 时强行 dispose 正在使用的流。
- Host command queue 中失败的命令必须离队并释放它占用的 active input reservation；runtime 死亡时该 workspace 的残留 active input 和旧 `running` 命令也必须回收，否则后续 drain 永久阻塞。
- 本地窗口 Host 意外退出时，main 必须通知 renderer 并以一次为上限尝试 respawn；主动 dispose、窗口已销毁或配额用尽时不重启，避免无限崩溃循环。

## 运行时证据

- RPC 通道使用 [LoggingChannelServer / LoggingChannelClient](../../packages/rpc/src/logging-middleware.ts) 记录频道、命令和耗时；优先利用已有日志定位调用链。
- Agent session 轨迹在 `~/.zcode/cli/rollout` 或 `~/.zcode/cli/debug`，CLI 日志在 `~/.zcode/cli/log`。
- 界面复现优先使用 agent-browser；失败时可直接 CDP 调试，开发默认端口为 9229，连接前核实实际监听端口。
- 验证分别覆盖受影响的桌面本地和手机远控路径，记录 owner、事件顺序、identity 和 delivery 边界证据；必要环境缺失按根 AGENTS.md 的阻塞规则处理。
