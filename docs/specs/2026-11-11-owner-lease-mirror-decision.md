# Owner/lease/mirror：Host 侧退役，保留 session route（R09 决策记录）

| 字段     | 值                                                                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | **Host 侧已实施（Option B）**：删除死链与注入点；不接线。TaskRealtimeBus 仅保留跨 Host session route，owner/lease/mirror 分支无生产者。                                                                                 |
| 日期     | 2026-11-11 决策；2026-11-12 实施                                                                                                                                                                                        |
| 来源     | `docs/research/2026-11-11-zcode-wide-competitive-research.md` §R09（`:239-248`）                                                                                                                                        |
| 适用范围 | `packages/desktop/src/host/index.ts`、`packages/desktop/src/main/taskRealtimeBus.ts`、`packages/services/src/session/sessionRealtimePort.ts`（已删）                                                                    |
| 主要对象 | `createReportingRemoteZCodeTaskService`、`TaskRealtimeBus`、shared `task-realtime` schema                                                                                                                               |
| 结论     | 选 **B（删除 Host 死链）**，不选 A（接线）。镜像路径没有消费者、V4 topic 是权威读路径、bots 走 legacy adapter，接线只会制造双流与无人应答的 owner-command。shared wire schema 暂留，波次 3 再定。                       |
| 关联文档 | `AGENTS.md:69-70`、`docs/agents/runtime-boundaries.md:45-58`、`docs/web-remote-control/task-realtime-sync.md:5-7,19,121-135`、`docs/v4-refactor/11-deletion-plan.md:143-152`、`docs/v4-refactor/01-topology.md:122-124` |

## 0. 2026-11-12 实施更新（覆盖下文 2026-11-11 的“未实施”状态）

> 以下 §1–§8 保留为 2026-11-11 的决策过程与当时证据；其中引用的 `taskRealtimeBridge.ts`、
> `sessionRealtimePort.ts` 和 `host/index.ts` 行号已被本节删除/移动。当前可执行命令与状态以 §0 为准。

### 0.1 选择：Option B（删除），不是 Option A（接线）

代码与测试证据（本次按检出源码复核）：

1. `createReportingRemoteZCodeTaskService` 只有一个生产调用点，且只传 `{ reportRunningPromptCount: false }`。在该配置下
   `shouldWrapSendPrompt` 为 `false`，`sendPrompt` 原样返回；镜像分支不仅没有 port，连包装器都不会创建。
2. 即使补上 port，`mirrorRemotePrompt` 的产出也没有消费者：host 侧没有 `onDidReceiveEvent` 订阅方，
   renderer/手机使用 V4 conversation topic，bots 使用 adapter legacy `onDynamicTaskEvent`。
3. owner-command 在 Host 侧没有消费者。接上 port 后 `stop_generation` / `respond_permission` 等请求会进入
   `TaskRealtimeBus` 并等待 30s 超时，而不是生效。
4. 镜像会与 V4 topic 形成双流；desktop-continuous 与 web-remote-replayable 的恢复语义不同，
   `mirrorRemotePrompt` 没有 `deliveryKind` 参数，无法证明去重或顺序。
5. bridge 的 lease 以 `runId` 为键，bots 同时 `sendPrompt` 时可能出现 `owned_by_other_host`，
   行为随窗口时序漂移。以上任一问题都不是“加一行注入”能收口的。

因此按“未验证路径不能进生产”的规则删除 Host 侧死链，而不是把文档改成它已经工作。

### 0.2 本次删除的内容

- `packages/desktop/src/host/index.ts`
  - 删除 `createReportingRemoteZCodeTaskService` 的 `taskRealtimePort` 与 `materializePromptAttachments` 选项。
  - 删除 `mirrorRemotePrompt`、`isRemoteMirrorableStreamEvent`、`prepareRemotePromptParams`。
  - 删除 `activeSessionRealtimePort` 声明、`InitLocal` 赋值和两处 dispose。
  - `sendPrompt` 包装器只保留 running-prompt 计数；
  - 生产装配保持 `{ reportRunningPromptCount: false }`，不再存在“传了 port 就启用”的隐式开关。
- 删除 `packages/desktop/src/host/taskRealtimeBridge.ts` 与 `packages/desktop/test/taskRealtimeBridge.test.ts`：
  Host 不再创建 bridge，该文件没有生产消费者。
- 删除 `packages/services/src/session/sessionRealtimePort.ts` 及其 `@zcode/services` 导出：
  接口只被 bridge 使用。
- `packages/desktop/src/main/taskRealtimeBus.ts` **保留**：
  `SessionRouteAnnounce` / `SessionMessageSendRequested` / `SessionMessageDeliver` 仍是窗口 Host 的实时跨 Host 路径。
  其 lease / stream mirror / owner-command 分支在 Host 退役后没有生产者，属于待波次 3 删除的 inert 状态；
  本次不删 `TaskRealtimeBus` 类本身，避免同时改动 main IPC 的 workspace-key 同步与 session route。

### 0.3 本次验证

| 检查                                              | 结果                                                                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host 属性审计                                     | `host/index.ts` 对 `taskRealtimePort`、`activeSessionRealtimePort`、`createTaskRealtimeBridgeForHostInit`、`mirrorRemotePrompt`、`acquireTaskRunLease`、`publishStreamOp` 零命中（守卫测试覆盖）。 |
| 删除文件                                          | `host/taskRealtimeBridge.ts`、`test/taskRealtimeBridge.test.ts`、`services/session/sessionRealtimePort.ts` 不存在（守卫测试覆盖）。                                                                |
| 保留 continuous 路径                              | session route 单测：host-b `SessionRouteAnnounce` → host-a `SessionMessageSendRequested` → host-b `SessionMessageDeliver` → 结果回 host-a。                                                        |
| `pnpm exec tsc -b packages/desktop/tsconfig.json` | 本改动无新增错误；工作树里仍有与本次改动无关的既有错误（`botsService.ts`、`zcodeAgentService.ts`、`telemetryCore.ts`，来自并行改动）。                                                             |
| Vitest                                            | `hostOwnerLeaseRetired.test.ts` + `taskRealtimeBus.test.ts` + `hostRemoteStartupIntegration.test.ts`：3 文件 23 用例通过。                                                                         |

### 0.4 仍未完成（R09 剩余）

1. `TaskRealtimeBus` 的 lease / stream mirror / owner-command 分支与 shared `task-realtime` schema 仍在树上。
   删除它们需要 §6 的 owner 回答（旧 mobile bundle / 第三方 relay 是否仍依赖 wire frame）与一个发布周期的零流量证据；
   在拿到证据前保留 schema、删除生产与状态机是允许的下限。
2. 未新增 mobile owner-command E2E：该路径已被删除，不需要再为不存在的路由做门槛；若恢复，必须先新增该 E2E。
3. §2 的 F1–F13 是 2026-11-11 的历史快照，行号与部分事实已被本节取代；保留用于说明当时的判断依据。

### 0.5 复现命令

```bash
pnpm exec tsc -b packages/desktop/tsconfig.json --pretty false
pnpm exec vitest run packages/desktop/test/hostOwnerLeaseRetired.test.ts \
  packages/desktop/test/taskRealtimeBus.test.ts \
  packages/desktop/test/hostRemoteStartupIntegration.test.ts
```

## 1. （历史）2026-11-11 决策摘要

1. **不接线**：`activeSessionRealtimePort` 虽然被创建（`packages/desktop/src/host/index.ts:3731`），但从未传给唯一消费者
   `createReportingRemoteZCodeTaskService`（`:3983-3991` 只传了 `reportRunningPromptCount: false`）。不要为了“让代码看起来一致”
   而注入它；注入会把一条从未验证过的镜像读路径变成生产路径。
2. **当前行为定性**：owner/lease/mirror 链路是**死链/被取代的链**，不是“条件开启”。
   没有 feature flag、环境变量或设置项控制它；唯一的开关是“是否传 port”，而生产装配从不传。
3. **现在执行 Option A**：把“owner/lease 是必需路由层”的文档表述改成“legacy wire 兼容、非当前数据路径”，并加一个守卫测试，
   防止有人在没有 owner-command 消费者的情况下重新注入 port。文档改动与守卫代码**不在本次写入范围**，列为后续动作（§5）。
4. **波次 3 执行 Option C**：随 `docs/v4-refactor/11-deletion-plan.md:147` 一起删除 owner/lease/mirror 层，
   但必须先满足 §6 的证据条件（旧 mobile bundle / bot / 第三方 relay 不再依赖 `task-stream-mirror-batch` 与 owner-command）。
5. **R09 状态 = NOT complete**：产品决策未做，代码未接线、未删除。`docs/research/2026-11-11-zcode-wide-competitive-research.md:246`
   要求的 P0 收口条件（“在树里没有声明却从不传递的属性”）目前仍不满足，只被本记录显式承认。

## 2. 确认事实（FACT，均按当前检出源码核对）

### 2.1 端口从未注入，镜像分支不可达

| #   | 事实                                                                                                                           | 证据                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 唯一生产消费者是 `createReportingRemoteZCodeTaskService`，全仓只有一处调用                                                     | `packages/desktop/src/host/index.ts:3985`（`rg` 全仓仅此一处）                                                                    |
| F2  | 该调用只传 `{ reportRunningPromptCount: false }`，没有 `taskRealtimePort`，也没有 `materializePromptAttachments`               | `packages/desktop/src/host/index.ts:3983-3991`                                                                                    |
| F3  | 因此 `shouldWrapSendPrompt` 为 `false`，`sendPrompt` 直接原样返回，包装器不生效                                                | `packages/desktop/src/host/index.ts:1572-1578`                                                                                    |
| F4  | 包装器内的 `mirrorRemotePrompt(...)` 调用因此不可达                                                                            | `packages/desktop/src/host/index.ts:1614-1619`（调用点），`:1418-1492`（函数体）                                                  |
| F5  | 即使包装器生效，`mirrorRemotePrompt` 也会在缺少 port 时提前 `return`                                                           | `packages/desktop/src/host/index.ts:1428-1432`                                                                                    |
| F6  | `activeSessionRealtimePort` 只有声明、赋值、两处 dispose，没有任何读取者（除 dispose 判空）                                    | 声明 `:1857`；赋值 `:3731`；dispose `:2794-2797`、`:2890-2893`；全部引用见 `rg -n activeSessionRealtimePort packages/desktop/src` |
| F7  | 代码注释声称“由窗口 Host 内的 remote facade 接管 lease 和 stream mirror”，但 desktop 侧没有第二个 `acquireTaskRunLease` 调用点 | 注释 `packages/desktop/src/host/index.ts:1487-1489`；`rg -n acquireTaskRunLease packages` 仅命中包装器 `:1442` 与接口/实现定义    |

链路的实际形态（事件顺序）：

```text
Host init-local
  └─ host/index.ts:3731  activeSessionRealtimePort = createTaskRealtimeBridgeForHostInit(msg, parentPort)
        └─ 存入模块变量；除 dispose 外无人读取            ← 断点 1
createLocalServices -> IZCodeTaskService
  └─ host/index.ts:3985 createReportingRemoteZCodeTaskService(service, { reportRunningPromptCount: false })
        └─ options.taskRealtimePort === undefined        ← 断点 2（包装器整体失效）
sendPrompt (renderer/bot)
  └─ 直接调用底层 service，不 acquire lease、不 publishStreamOp
        └─ TaskRealtimeBus 无 lease，stream op 被丢弃      ← 断点 3
```

### 2.2 Bridge 被创建，但没有任何消费者

| #   | 事实                                                                                                                                                                                        | 证据                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| F8  | `createTaskRealtimeBridgeForHostInit` 只在 `InitLocal` + `hostId` 时返回 bridge，否则 `null`                                                                                                | `packages/desktop/src/host/taskRealtimeBridge.ts:29-45`                                                                                          |
| F9  | bridge 实现 `publish`、`acquireTaskRunLease`、`releaseTaskRunLease`、`publishStreamOp`、`requestOwnerCommand`、`onDidReceiveEvent`、`onDidReceiveOwnerCommand`、`publishOwnerCommandResult` | `packages/desktop/src/host/taskRealtimeBridge.ts:147-240`                                                                                        |
| F10 | `requestOwnerCommand` / `onDidReceiveOwnerCommand` / `publishOwnerCommandResult` 在 `packages/**/src` 中**零生产调用方**，只出现在定义与接口声明                                            | `packages/desktop/src/host/taskRealtimeBridge.ts:194,221,232`；`packages/services/src/session/sessionRealtimePort.ts:24-43`                      |
| F11 | `onDidReceiveEvent` 同样零订阅方（主进程/服务/renderer 均无 `onDidReceiveEvent(` 调用）                                                                                                     | `packages/desktop/src/host/taskRealtimeBridge.ts:210`；`rg -n "onDidReceiveEvent\(" packages` 仅命中定义                                         |
| F12 | bridge 的默认 `deliveryKind` 是 `desktop_window`（`relay_bridge` 仅存在于 shared schema）                                                                                                   | `packages/desktop/src/host/taskRealtimeBridge.ts:149`；`packages/shared/src/task-realtime.ts:78`；`rg -n relay_bridge packages/**/src` 仅 schema |
| F13 | bridge 收到 `TaskRealtimeDeliver` 只会分发给本地 listener 集合；在 F10/F11 前提下该集合为空                                                                                                 | `packages/desktop/src/host/taskRealtimeBridge.ts:129-142`                                                                                        |

### 2.3 `TaskRealtimeBus` 状态机完整，但无生产者

| #   | 事实                                                                                                                                                                                                        | 证据                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------- | ----------------- | --------------------------------------------------------------- | -------- | ----------------------------------------------------- |
| F14 | main 进程总是构造 bus，并注册内存诊断                                                                                                                                                                       | `packages/desktop/src/main/index.ts:580-583`                                                                                                                                                         |
| F15 | 每个窗口 Host 都注册到 bus（`taskRealtime` 只要非空就注册）                                                                                                                                                 | `packages/desktop/src/main/desktopHostProcess.ts:599-607,634-643`                                                                                                                                    |
| F16 | 窗口装配只传 `workspaceKeys` 和 `onHostId`，未传 `deliveryKind`                                                                                                                                             | `packages/desktop/src/main/index.ts:1934-1939`                                                                                                                                                       |
| F17 | bus 的消息分发覆盖 `TaskRealtimePublish`、`TaskRunLeaseAcquire`、`TaskStreamOpPublish`、`TaskOwnerCommandRequest/Result`                                                                                    | `packages/desktop/src/main/taskRealtimeBus.ts:250-283`                                                                                                                                               |
| F18 | stream op 只有在存在匹配 lease（同 host、同 runId）时才会进入 batch；否则静默丢弃                                                                                                                           | `packages/desktop/src/main/taskRealtimeBus.ts:395-403`                                                                                                                                               |
| F19 | batch 只在 terminal 时删除（`streamBatches.delete` 仅两处）                                                                                                                                                 | `packages/desktop/src/main/taskRealtimeBus.ts:520-522,544-546`；`releaseLease` 只 flush 不删 `:366-380`                                                                                              |
| F20 | owner-command 路由（request → deliver → result）实现完整                                                                                                                                                    | `packages/desktop/src/main/taskRealtimeBus.ts:850-925`                                                                                                                                               |
| F21 | session 路由（`SessionRouteAnnounce` / `SessionMessageSendRequested`）也有实现，但目标侧 `deliverSessionMessage` 在 adapter 中是 `unsupported(...)`，会以 `ZCODE_AGENT_UNSUPPORTED_LEGACY_TASK_METHOD` 失败 | host 侧发布 `packages/desktop/src/host/index.ts:1336-1371,3955-3960`；bus `:286-293,927-1006`；adapter `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:2102-2110`；错误构造 `:300-305` |
| F22 | 没有任何 feature flag / env 开关控制上链路                                                                                                                                                                  | `rg -n "taskRealtimeBusEnabled                                                                                                                                                                       | enableTaskRealtimeBus | realtimeMirrorEnabled | ownerLeaseEnabled | TASK*REALTIME" packages/\*\*/src` → 无命中；`rg -n "ZCODE*(TASK | REALTIME | MIRROR)" packages/desktop/src/host/index.ts` → 无命中 |

结论：F1–F22 合并后，owner/lease/mirror 不是“条件开启的能力”，而是一条**装配期断开、由 V4 取代**的遗留链。

### 2.4 手机真实链路是 V4 conversation topics（不是 mirror batch）

| #   | 事实                                                                                                            | 证据                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- | ------------ | ----------------------------------------- |
| F23 | Web/手机入口使用 `@zcode/ui` 的 `Root`，没有自己的 task-stream 订阅代码                                         | `packages/web/src/main.tsx:15-27`；`rg -n "onDynamicStreamEvent                                                   | taskStream | StreamMirror | subscribeTask" packages/web/src` → 无命中 |
| F24 | 主区会话由 `V4WorkspaceChatArea` 承载，内部通过 `createAgentConversationTransport` + `SessionDataLayer` 取数    | `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:2629`；`packages/ui/src/v4/V4ConversationContext.tsx:165-175` |
| F25 | 订阅按 topic 发起：`acquire(sessionId)` → `conversationTopic(sessionId)` → `store.connect()`                    | `packages/ui/src/v4/sessionDataLayer.ts:76-98`                                                                    |
| F26 | transport 的 subscribe 走 `agentService.subscribeConversationV4(...)`，并用 subscriptionId 绑定 topic           | `packages/ui/src/v4/agentConversationTransport.ts:188-247`（`:207` 为 subscribe 调用）                            |
| F27 | 手机 attachment 由 `webRemoteControlSharedHostAttachments` 建立，可信注入 `clientMode: "web-remote-replayable"` | 本地 Host `packages/desktop/src/main/webRemoteControlSharedHostAttachments.ts:76-104`；远端 Host `:107-149`       |

即：手机侧的“实时”由 V4 topic 的 initial/online/recovery 与 snapshot 语义承担；`task_stream_mirror_batch` 不是它的数据来源。

### 2.5 Bots 仍有 legacy 读路径，但不是 mirror batch

| #   | 事实                                                                                                       | 证据                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F28 | bots 订阅 `onDynamicTaskEvent`，`deliveryKind: "bot-channel-continuous"`                                   | `packages/services/src/bots/botsService.ts:5969-5991`                                                                                                     |
| F29 | 该调用进入 adapter 的 deprecated 旧订阅面（`session/subscribe` + `session/event` + `state.updated`）       | 注释 `packages/services/src/zcode-agent/zcodeAgent.ts:872-878`；实现 `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:3119-3155`             |
| F30 | `"bot-channel-continuous"` 被映射为 `desktop-continuous`（非 replayable）                                  | `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:3501-3505`                                                                                  |
| F31 | bots **防御性**处理 `task_stream_mirror_batch`，但生产端从不产生该事件（F18/F1）                           | `packages/services/src/bots/botsService.ts:5377-5393`                                                                                                     |
| F32 | `task_stream_mirror_batch` 的生产者只有 bus 的 batch 逻辑；schema 侧保留 `TaskStreamMirrorBatchEvent` 定义 | `packages/desktop/src/main/taskRealtimeBus.ts:471-523`；`packages/shared/src/task-realtime-core.ts:276-289`；`packages/shared/src/task-realtime.ts:63-64` |

**关键推论（HYPOTHESIS，需 §6 验证）**：bots 今天能工作，靠的是 adapter 的 legacy `session/subscribe` 读路径，而不是 owner/lease/mirror。
因此 Option C 的删除顺序必须保留 adapter 读路径，直到 bots 迁到 V4 投影（与 `docs/v4-refactor/11-deletion-plan.md:151` 的“最后删”一致）。

### 2.6 文档与代码冲突（确认的矛盾，不是解释）

| #   | 文档断言                                                                                             | 代码事实                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| F33 | “Host owner/lease 负责路由”                                                                          | `AGENTS.md:69`；无生产 lease（F1–F7）                                                           |
| F34 | “保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断”                    | `AGENTS.md:70`；边界判断存在但未被任何调用路径触发（F7/F18）                                    |
| F35 | “owner/lease/owner command 仍负责运行中 task 单 owner、跨 host 路由、阻塞请求响应、stale run 防护”   | `docs/agents/runtime-boundaries.md:58`（另见 `:50,55`）；owner-command 零订阅方（F10）          |
| F36 | “`TaskRealtimeBus` 继续承担 owner lease、stale-run 与跨 host 命令路由”                               | `docs/web-remote-control/task-realtime-sync.md:5-7,19`；bus 存在但无 lease 生产者（F18）        |
| F37 | owner command 必须携带 `workspacePath`/`workspaceKey`/`taskId`/`runId`，main 按 lease 拒绝 stale run | `docs/web-remote-control/task-realtime-sync.md:133-135`；实现存在（F20），却无调用方（F10）     |
| F38 | “owner / lease / stale-run: 只负责跨 host 命令和阻塞请求路由”，且“不能…删除”                         | `docs/v4-refactor/01-topology.md:122-124`；同上                                                 |
| F39 | “保留 task-realtime owner-command schema 是为了旧 relay 兼容与 wire contract 完整性”                 | `docs/specs/workspace-hook-trust.md:2585-2586`；这条是**与代码一致的**：schema 确实只剩兼容用途 |
| F40 | 波次 3 计划“删 `taskRealtimeBus.ts`，owner/lease/mirror 整层消灭”                                    | `docs/v4-refactor/11-deletion-plan.md:143-152`（行 147）；与 F33–F38 的“必须保留”表述冲突       |

## 3. 假设与未知

以下条目**未**由本次静态核对证实，不得当作事实引用：

- **H1**：`taskRealtimePort` 是某次重构中“有意关掉”（Z05 §7 Q1 的候选解释），而不是遗漏。
  证据缺口：没有 `git log -S` 结果；没有任何开关或注释说明“临时禁用”。
- **H2**：外部 relay / 旧 mobile bundle 仍可能发送或期待 owner-command 帧（wire 兼容）。
  证据缺口：外部部署与历史 bundle 不在仓库内；`workspace-hook-trust.md:2585-2586` 只说“为兼容保留 schema”，未给流量证据。
- **H3**：生产环境从未出现 `[task-realtime] task run lease acquired`。
  证据缺口：未读生产日志；该日志由 `taskRealtimeBus.ts:348-353` 输出，可作为零流量判据。
- **H4**：两个 web-remote E2E fixture 指向的正式 spec 路径不存在（只有 manual-review/pending 版本），
  因此这两条链路当前没有 gating E2E。证据：`packages/desktop/test/e2e/fixtures/cases/auth-config/web-remote-control-session-events.json:4`
  与 `web-remote-control-auth-gate.json:4` 写的是 `./test/e2e/*.test.ts`，而 `packages/desktop/test/e2e/*web-remote*` 只找到
  `manual-review/pending/web-remote-control-session-events.test.ts` 与 `manual-review/pending/web-remote-control-auth-gate.test.ts`。
  待 `node scripts/check-e2e-fixtures.mjs` 判定（本次未运行）。
- **H5**：`SessionMessageSendRequested` 跨 Host 路径今天是否还有真实调用方。目标侧是 `unsupported`，所以即使有调用也必然失败；
  但调用源可能只存在于旧 bot 部署中，仓库内无法证明。

## 4. 选项

### Option A：保持禁用 + 文档/守卫（现在执行）

**动作**

1. 文档对齐：把 `AGENTS.md:69-70`、`docs/agents/runtime-boundaries.md:55-58`、`docs/web-remote-control/task-realtime-sync.md:5-7,19,121-135`、
   `docs/v4-refactor/01-topology.md:122-124` 改成“owner/lease/owner-command 是 legacy wire 兼容层，非当前数据路径；
   V4 conversation topic 是权威读路径”。保留 `workspace-hook-trust.md:2585-2586` 的兼容说明。
2. 加守卫测试（建议位置：`packages/desktop/test/` 下新文件）：断言 `createReportingRemoteZCodeTaskService`
   在只传 `{ reportRunningPromptCount: false }` 时不包装 `sendPrompt`；并断言一旦传入 `taskRealtimePort`，
   必须同时存在 `onDidReceiveOwnerCommand` 订阅方，否则测试失败。
3. 在 `ActiveSessionRealtimePort` 变量上补一行注释指向本记录（避免下一个人“顺手接上”）。

**风险**

- 文档与代码仍然“两层皮”，只是被标注为 legacy；若 owner 决定长期保留 wire 兼容，需要每轮复核。
- 守卫测试绑定实现细节（proxy 行为），重构时需同步更新。

**验收测试**

| 检查                  | 命令                                                                                                        | 通过标准                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 现有 owner 状态机单测 | `pnpm --filter @zcode/desktop exec vitest run test/taskRealtimeBus.test.ts test/taskRealtimeBridge.test.ts` | 全绿（两文件既有 `describe`/`it` 用例，未改动）                   |
| 守卫测试              | 新增文件后同一 vitest 命令                                                                                  | 注入 port 无消费者时失败；现状通过                                |
| 全仓属性审计          | `rg -n "taskRealtimePort" packages --glob '!**/dist/**' --glob '!**/out/**' --glob '!**/.e2e-cache/**'`     | 命中仅：类型声明、包装器内读取、bridge 返回类型；**无**生产注入点 |
| 类型/静态门禁         | `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`                                          | 无新增失败                                                        |

### Option B：最小接线（**不推荐**，仅在 owner 确认镜像仍是必需时）

**动作**：在 `packages/desktop/src/host/index.ts:3985` 把 `activeSessionRealtimePort` 传入，并实现 owner-command 消费者
（`stop_generation`、`respond_permission`、`respond_elicitation`、`respond_workspace_hook_review`、`enqueue/promote/cancel_task_command`，
见 `packages/services/src/session/sessionRealtimePort.ts:24-36`）。

**风险（按严重度）**

1. **双流**：包装器会在 `sendPrompt` 期间额外订阅 `onDynamicStreamEvent` 并 `publishStreamOp`（`host/index.ts:1468-1482`），
   而 V4 UI 已从 conversation topic 取同一份内容（F24–F26）。没有既存去重契约，重复渲染与投影乱序是首要风险。
   注意 `taskRealtimeBus.ts:529-531` 的注释假设“有 realtime port 时 owner direct stream 会被关闭”，该假设在 V4 下没有代码支撑。
2. **lease 竞争**：bots 使用 `bot-channel-continuous`（F28），镜像 lease 以 `runId` 为键（`taskRealtimeBus.ts:321-331`），
   多端同时 send 时可能 `owned_by_other_host` 而静默退回 direct stream，行为随窗口时序漂移。
3. **恢复语义错配**：desktop-continuous 与 web-remote-replayable 的 gap/snapshot 恢复必须分开验证（`AGENTS.md:67`），
   但 `mirrorRemotePrompt` 本身没有 deliveryKind 参数。
4. **生命周期**：仅有 `finally` 释放（`host/index.ts:1486-1490`）；若 `beginWorkspaceTask` 失败或 Host 重启，
   batch 可能残留（见 `docs/analysis/memory-leak-audit-2026-09-03.md:59-63`）。

**验收测试（全部为门槛，缺一不可）**

- 新 E2E：mobile attachment（`web-remote-replayable`）在 mirror 开启后收到 batch，且 stop/permission 到达 owner；
  并断言同一 assistant 文本在桌面与手机各只出现一次。
- `pnpm --filter @zcode/desktop exec vitest run test/taskRealtimeBus.test.ts test/taskRealtimeBridge.test.ts` 全绿。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 30 分钟 soak：`streamBatches.size` 在 run 结束后归零（`collectMemoryDiagnostics`，`taskRealtimeBus.ts:357-364`）。

### Option C：波次 3 退役（推荐，在波次 3 执行）

**动作**（按删除顺序）

1. 先确认 §6 的流量证据；再发布一个“owner-command 与 `task_stream_mirror_batch` 停止生产”的兼容声明。
2. 删除 `mirrorRemotePrompt`、`prepareRemotePromptParams` 的 port 参数、`createReportingRemoteZCodeTaskService` 的
   `taskRealtimePort`/`materializePromptAttachments` 选项（若无其他使用者），以及 `createTaskRealtimeBridgeForHostInit` 与
   `activeSessionRealtimePort`（`packages/desktop/src/host/index.ts:1418-1492,1572-1578,1857,3731,3983-3991`）。
3. 删除 `packages/desktop/src/main/taskRealtimeBus.ts` 的 owner/lease/mirror/owner-command 状态，保留或迁移 session 路由
   （见 F21：目标侧当前 `unsupported`，需先决定该能力是删还是接到 V4）。
4. 删除 `packages/shared/src/task-realtime.ts` 与 `task-realtime-core.ts` 中对应 schema，并同步
   `docs/v4-refactor/11-deletion-plan.md:147`、`docs/web-remote-control/task-realtime-sync.md`、`docs/agents/runtime-boundaries.md`、`AGENTS.md:69-70`。
5. **不要**同批删除 adapter 的 legacy 读路径：`zcodeTaskServiceAdapter.onDynamicTaskEvent` 仍是 bots 的投影源
   （F28–F30），必须等 bots 迁到 V4 后才删（`docs/v4-refactor/11-deletion-plan.md:151`）。

**风险**

- 旧 mobile bundle / 第三方 relay 依赖 owner-command schema 时会出现 undefined behavior（H2）。缓解：先发 deprecation 声明，
  观察一个发布周期；或保留 schema-only 兼容层，只删生产与状态机（注意 `workspace-hook-trust.md:2585-2586` 已为此留了口径）。
- session 路由可能与 bot-project-runtime 的跨 Host 语义相关（`packages/services/src/bot-project-runtime/CONTRACT.md:9`）。
  删除前需要单独确认该 contract 的“移除 main Bot 消息分支不移除 TaskRealtimeBus owner/lease”是否仍被要求。

**验收测试**

- 删除后 `rg -w` 全仓零命中：`taskRealtimePort`、`acquireTaskRunLease`、`publishStreamOp`、`TaskOwnerCommandRequest`、
  `task_stream_mirror_batch`（排除 dist/out/e2e-cache）。
- `pnpm --filter @zcode/desktop exec vitest run test/taskRealtimeBus.test.ts test/taskRealtimeBridge.test.ts`：
  文件同步删除，套件不再存在（或保留 session 路由子集的新测试）。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 全绿。
- 一个发布周期内生产日志无 `[task-realtime] task run lease acquired` 与 owner-command 失败记录。

## 5. 建议与阶段计划

```text
现在（本记录）
  └─ Option A：不接线 + 文档标注 legacy + 守卫测试
        └─ 不满足 R09 的“删除或接线”收口，仅解除“假象”

波次 3（协议重写后）
  └─ 先取 §6 证据
        ├─ 有旧客户端依赖  -> 保留 schema-only 兼容层，删生产/状态机
        └─ 无依赖          -> Option C 全量删除（含 schema、桥、bus 状态）
```

- **现在不要做**：注入 port、补 owner-command 消费者、删除 bus 或 bridge。
- **现在可以做**：文档对齐（§4 A1）与守卫测试（§4 A2）。两者都在本记录的写入范围之外，需另行排期。
- 本记录不覆盖：lease 模型重设计、relay 协议改动（同 R09 的 out of scope 声明，`docs/research/2026-11-11-zcode-wide-competitive-research.md:243`）。

## 6. 需要 owner 回答的问题（原文）

> **Do any supported clients still rely on `task-stream-mirror-batch` / owner-command (older mobile bundles, bots, third-party relays), or are V4 conversation topics authoritative for all?**

中文对照：是否存在仍依赖 `task-stream-mirror-batch` / owner-command 的受支持客户端（旧手机 bundle、bots、第三方 relay），
还是 V4 conversation topic 对所有端都是权威读路径？

这个答案直接决定 Option C 是“连 schema 一起删”还是“只删生产与状态机、保留 wire 兼容”。

## 7. 缺失证据与必跑命令（需要有 shell 的 owner 执行）

本次环境 `Bash` 不可用（`spawn /bin/zsh EAGAIN`，两次探测均失败），所有命令**均未运行**。

### 7.1 历史归因（H1）

```bash
git log -S taskRealtimePort --oneline -- packages/desktop/src/host/index.ts
git log -S createReportingRemoteZCodeTaskService --oneline -- packages/desktop/src/host/index.ts
git log -S activeSessionRealtimePort --oneline -- packages/desktop/src/host/index.ts
```

判据：找到注入被移除（或从未加入）的提交，确认是“有意关闭”还是“重构遗漏”。

### 7.2 零流量证据（H3，决定 Option C 能否直接删）

```bash
rg -n "task run lease acquired|\[task-realtime\]" <desktop-main-log>
rg -n "task-realtime" <desktop-main-log> | wc -l
```

判据：一个发布周期内 lease acquire / owner-command 记录为 0。

### 7.3 外部兼容面（H2，仓库内无法证明）

```bash
rg -n "task-stream-mirror-batch|task_stream_mirror_batch|owner-command|ownerCommand" \
  --glob '!**/dist/**' --glob '!**/out/**' --glob '!**/.e2e-cache/**' --glob '!**/node_modules/**'
```

判据：除 schema、bridge、bus、docs 外无其他命中；第三方 relay 的实现需在仓库外单独取证。

### 7.4 全仓属性审计（R09 的 P0 收口条件）

```bash
rg -n "taskRealtimePort" packages --glob '!**/dist/**' --glob '!**/out/**' --glob '!**/.e2e-cache/**'
rg -n "onDidReceiveOwnerCommand|requestOwnerCommand|publishOwnerCommandResult" packages/**/src
```

判据：要么有生产注入 + 消费者，要么 0 引用（本记录选择后者作为目标，但尚未执行）。

### 7.5 手机 attachment / mobile owner 的 E2E

现状：`packages/desktop/test/e2e/manual-review/pending/web-remote-control-session-events.test.ts`
只覆盖 OAuth 凭据完成事件（`:26-27,124`），**不覆盖** mirror batch 或 owner-command。
先验证 fixture 漂移（H4）：

```bash
node packages/desktop/scripts/check-e2e-fixtures.mjs --spec ./test/e2e/web-remote-control-session-events.test.ts
node packages/desktop/scripts/check-e2e-fixtures.mjs --spec ./test/e2e/web-remote-control-auth-gate.test.ts
```

若确认缺失，需新增/转正一个覆盖以下场景的 E2E：

```bash
pnpm --filter @zcode/desktop test:e2e:serial -- --spec <new-mobile-owner-mirror-spec>
```

场景判据（Option B 的前置门槛）：手机 attachment（`web-remote-replayable`）收到 mirror 批次；`stop_generation` 与
`respond_permission` 到达 owner；桌面同一文本不重复。

### 7.6 统一门禁

```bash
pnpm --filter @zcode/desktop exec vitest run test/taskRealtimeBus.test.ts test/taskRealtimeBridge.test.ts
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

### 7.7 基线

```bash
node scripts/check-workspace-freshness.mjs
```

本次未运行（Bash 不可用），因此所有结论仅代表**当前检出源码**的静态事实，不代表基线干净。

## 8. R09 状态（2026-11-11 历史；被 §0 取代）

> 以下是实施前的记录。当前状态见 §0：Host 死链已删除，R09 的 Host 侧收口完成；
> 剩余仅为 `TaskRealtimeBus` inert 分支与 shared schema 的波次 3 删除。

**R09 = NOT complete（历史）。**

- 未接线：`activeSessionRealtimePort` 仍未传入 `createReportingRemoteZCodeTaskService`。
- 未删除：`taskRealtimeBus.ts`、`taskRealtimeBridge.ts`、`sessionRealtimePort.ts` 与 shared schema 全部保留。
- 未改文档：§2.6 的冲突表述仍在树上。
- 唯一交付：本决策记录，把“死链 + 无 flag + 与文档冲突”写成可复核的事实，并给出 A/B/C 与证据门槛。

收口需要两件事：

1. Owner 回答 §6 的问题（决定 wire 兼容窗口）。
2. Owner 批准 Option A 的文档/守卫改动，或批准波次 3 提前执行 Option C。

在此之前，任何“顺手把 port 接上”的改动都属于越权变更，应被拒绝。
