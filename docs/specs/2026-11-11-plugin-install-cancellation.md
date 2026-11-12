# Plugin install cancellation from the UI (QW10)

| 字段     | 值                                                                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 已实施（UI 路径 + CLI NDJSON 传输旁路；§6 阻塞已修复。本次未运行 vitest/typecheck，见 §6「未验证」）                                                                                                                                                      |
| 日期     | 2026-11-11                                                                                                                                                                                                                                                |
| 来源     | `docs/research/2026-11-11-zcode-wide-competitive-research.md` R22 / QW10                                                                                                                                                                                  |
| 适用范围 | `packages/ui/src/store/pluginManagementStore*.ts`、`packages/ui/src/settings/PluginStoreCard.tsx`、`packages/ui/src/settings/PluginStorePage.tsx`、`packages/ui/src/i18n/locales/**`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts` |
| 主要对象 | `PluginManagementStore.installPlugin`、`cancelInstall`、`PluginStoreInstallButton`、`shouldBypassProcessingQueue`                                                                                                                                         |

## 1. 问题与现状证据

**FACT（修改前）.** 取消能力在协议与服务层已经存在，但 UI 从不使用：

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts:1019-1045`：
  `plugins/install` 在带 `operationId` 时注册 `AbortController`；
  `plugins/cancelOperation` 按同一 id `abort()` 并返回 `{ cancelled: boolean }`。
- `packages/services/src/zcode-agent/zcodeAgentService.ts:5898-5906`：
  `cancelPluginOperation` 通过同一协议往返；`packages/services/src/plugins/pluginManagement.ts:74-76`
  已把方法暴露给 UI service。
- `packages/ui/src/settings/PluginStoreCard.tsx:187-226`（修改前）：安装中只渲染
  `disabled` 的「Installing…」胶囊，没有取消入口。
- `packages/ui/src/store/pluginManagementStore.ts:308-327`（修改前）：
  `installPlugin` 只生成 UI 内 `activeOperations.id`，不向 `installPlugin` RPC 传 `operationId`，
  因此 UI 无法定位远端操作。
- 适配器确实消费 abort signal：`apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts:213-223,818-860`
  在下载/git/解压边界检查并在取消时抛 `AbortError`；安装失败路径回滚已激活目录
  （同文件 `installMarketplacePlugin` 的 catch/rollback）。

## 2. 目标与非目标

### 2.1 目标

1. `installPlugin` 每次调用生成唯一 `operationId`，同时传给服务 RPC 和
   `activeOperations` 条目（`remoteOperationId`）。
2. 安装中的卡片/详情提供 Cancel；点击后调用现有
   `cancelPluginOperation({ operationId })`，不新增 backend 协议。
3. 取消请求只把条目标记为 `cancelling`；在底层 install promise 真正结束前
   保持「Cancelling…」并禁用重复取消，不伪造已完成/已取消。
4. 当底层以取消结果收口（CLI 将 `AbortError` 投影为 error diagnostic）时：
   - 不把取消映射成用户可见错误；
   - 移除 pending 条目；
   - 重新加载插件投影，确认未安装或保留原有安装。
5. 若服务回答 `cancelled: false`（操作已结束/不可定位）或取消 RPC 失败：
   清除 `cancelling`，保留安装的最终结果，并由 UI 提示可能无法取消。

### 2.2 非目标

- 不取消 restoreBuiltin / uninstall / update：协议层未给这些方法包 `operationId`，
  UI 不展示无法兑现的取消按钮。
- 不新增取消状态持久化或后台 operation registry；取消能力只覆盖当前窗口内存里的
  在途安装。
- CLI 侧只新增传输层控制面旁路（§6）；不新增协议方法，不改 `server.ts` 的
  `AbortController` 注册/取消实现，也不改变 install/uninstall 的串行准入。

## 3. 状态所有权与事件顺序

- **唯一所有者**：`pluginManagementStore` 拥有 `activeOperations` 与
  `cancelling` 标志；`runWorkspaceOperation` 是唯一写入终态的地方。
- `cancelInstall` 只修改 `cancelling` 并调用服务；不直接移除条目、不直接写 `error`。
- 条目的移除、投影刷新、错误清理由原 install promise 的 `finally/catch` 完成。

```text
installPlugin
  → begin entry { id, remoteOperationId }
  → service.installPlugin({ operationId })
cancelInstall
  → entry.cancelling = true
  → service.cancelPluginOperation({ operationId })
  → cancelled:false / RPC error → entry.cancelling = false
  → cancelled:true → keep cancelling:true
install settles
  → if entry.cancelling && error/diagnostic:
       suppress error, refresh projection, notify, remove entry
  → else: existing success/failure behavior
```

竞态规则：

- 取消确认后 install 仍成功（abort 与持久化竞态）：以成功投影为准，不显示
  cancelled；条目正常移除。
- `initialize` 切换 workspace / scope 会清空 `activeOperations`；旧条目的取消请求
  找不到目标时返回 false，不写新上下文状态。
- 取消应答晚于安装收口：`cancelling` 只回写仍在 `activeOperations` 里的 id，
  不留下幽灵状态。

### 3.1 请求态与确认态必须分开

- `cancelRequestOperationIds`：已发出取消 RPC、尚未收到应答。UI 保持
  “Installing…”，只禁用重复取消。
- `cancellingOperationIds`：CLI 应答 `cancelled: true`，底层 abort 已送达。
  UI 显示 “Cancelling…”，直到安装 promise 收口。
- CLI 应答 `cancelled: false` 或 RPC 失败：清除请求态，安装按真实结果收口，
  页面提示 `settings.plugins.store.cancelInstallFailed`。

这个拆分避免把“请求已排队/尚未送达”显示成“已经取消”。静默收口只在同一
operation 上确实发出过取消请求（请求态或确认态存在）时生效；CLI 因进程退出等
原因自行中止时，仍以 install 诊断如实显示。

## 4. 接口

`pluginManagementStore` 新增：

```ts
cancelInstall(
  pluginName: string,
  marketplace: string,
  pluginService: IPluginManagementService,
): Promise<boolean>;
```

返回 `true` 表示服务已确认至少一个同插件安装被 abort；返回 `false` 表示没有可取消
在途安装、服务回答 `cancelled:false`，或取消 RPC 失败（此时 UI 显示本地化提示）。

`PluginStoreActions` 新增可选 `onCancelInstall(item)`；`activeOperations` 条目新增
`remoteOperationId?`；actions 新增 `cancelRequestOperationIds` 与
`cancellingOperationIds`（仅安装条目携带）。

i18n keys（三个目录）：

- `settings.plugins.store.cancelInstall`
- `settings.plugins.store.cancelling`
- `settings.plugins.store.cancelInstallFailed`

## 5. 验收场景

1. `installPlugin` RPC 收到的 `operationId` 与 `activeOperations` 条目的
   `remoteOperationId` 相同且非空。
2. 点击 Cancel 时 `cancelPluginOperation` 收到同一 id；取消确认后条目为
   `cancelling: true`。
3. 安装以取消 diagnostic 收口后：`activeOperations` 清空、`error === null`、
   插件投影重新加载（未安装）。
4. 取消 RPC 失败或 `cancelled:false`：`cancelling` 清除，安装仍可正常成功/失败。
5. 取消确认后安装成功：返回安装成功投影，不显示 cancelled。
6. 安装中 UI 显示 `Installing…` 与 Cancel；取消应答确认前显示 `Installing…`
   且 Cancel 禁用；`cancelling` 时显示 `Cancelling…` 且 Cancel 禁用；
   restorable 安装不显示 Cancel。
7. 新 key 在 `en-US` / `zh-CN` / `ru-RU` 均存在且非空。
8. CLI 传输层：install handler 挂起时，`plugins/cancelOperation` 仍能进入 server
   handler 并命中同一 `operationId` 的 `AbortController`；`plugins/uninstall` 等
   破坏性操作仍排在 install 之后（见 §6）。

## 6. 传输层旁路（已修复）

**修复前 FACT.** `plugins/cancelOperation` 无法在 install 进行中到达 server：

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts:250-265`（修复前）：
  普通请求进入 `this.processing` 串行链，并 `await handleMessage`；
  `transport.ts:293-303`（修复前）的 `shouldBypassProcessingQueue` 只旁路
  `sessionStop`、`workspaceCancelGenerateText` 和 MCP App 并发方法，**不含**
  `zcodeProtocolMethods.pluginsCancelOperation`。
- 因此取消请求排在 in-flight install 之后；install handler 返回后
  `withPluginOperationSignal` 已在 `finally` 删除 controller
  （`server.ts:1019-1035`），随后的取消只能得到 `cancelled: false`
  （`server.ts:1037-1045`）。
- UI 侧 5s 取消超时（`packages/services/src/zcode-agent/zcodeAgentService.ts:420`）
  会先把取消 RPC 判为失败，而安装进程仍在继续。

**修复.**
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts:293-308`
的 `shouldBypassProcessingQueue` 现包含
`message.method === zcodeProtocolMethods.pluginsCancelOperation`
（常量定义见 `packages/shared/src/zcode-protocol/index.ts:4702`，不硬编码字符串）。
旁路仍复用既有控制面通道：`lastQueuedMessageStarted.then(...)`，与
`sessionStop` 相同——只等前序请求真正被 handler 接收，不等它执行完成。
`plugins/install`、`plugins/uninstall`、`plugins/update` 等破坏性操作不在旁路集合内，
仍按 `this.processing` 串行准入，因此取消不会重排它们。

边界需要如实说明：该屏障表达的是「handler 已进入」，不是「AbortController 已注册」。
真实 server 在 `handleRequest` 中先 `await acquireOperation` 再 `dispatchRequest`，
controller 在 `withPluginOperationSignal` 内、调用 adapter 之前同步注册
（`server.ts:681`、`server.ts:1019-1035`）。因此取消能否命中取决于 install 先完成
controller 注册；本次 transport 回归只验证传输层放行与排队，不验证 server 内部时序。

**事件顺序（修复后）：**

```text
UI: plugins/install { operationId }
  → transport: 普通请求进入串行队列，await handleMessage
  → server: withPluginOperationSignal 注册 AbortController(op)
  → handler 占用队列（下载/解压）
UI: plugins/cancelOperation { operationId }
  → transport: shouldBypassProcessingQueue → 等 lastQueuedMessageStarted 后直接 handleMessage
  → server: cancelPluginOperation 命中 controller，abort()，返回 cancelled:true
  → install 侧 signal.aborted，adapter 抛 AbortError
  → server: withPluginOperationSignal finally 删除 controller
  → transport: 串行队列推进到后续普通请求
```

幂等/边界：

- 取消只按 `operationId` 定位，重复取消在 controller 已删除后返回
  `cancelled:false`，不产生副作用。
- 取消与 install 收口竞态时，以 `AbortController` 是否仍在 map 中为唯一判据；
  transport 不缓存取消状态，不新增第二条写入路径。
- 旁路仅限有 `id` 且 `method` 匹配的请求；通知与 response 走各自的既有分支。
- 取消无法中止 uninstall/update/restoreBuiltin：这些方法不注册 `operationId`，
  `cancelPluginOperation` 找不到 controller 即返回 `cancelled:false`，因此旁路取消
  不会改变它们的执行结果或顺序。
- 沿用既有控制面语义：旁路请求仍要等 `lastQueuedMessageStarted` 真正开始。若取消
  到达前已有另一个普通请求（如 uninstall）排在 install 之后，取消会先等该请求开始，
  这可能晚于 install 收口，从而得到 `cancelled:false`。UI 的取消超时与
  `cancelled:false` 提示仍覆盖该残余情形。

**验收用例（transport 回归）：**
`apps/zcode-cli/packages/bootstrap/tests/zcode-protocol-transport.test.ts:746-862`

1. install handler 挂起时，`plugins/cancelOperation` 在 install 仍 parked 的情况下
   到达 handler，且 `installActive === true`（说明 handler 仍在进行中）。
2. `plugins/uninstall` 不旁路：再推进一轮宏任务（`setImmediate`）后 handler 仍未被
   调用，直到 install 结束才按 `install → cancel → uninstall` 顺序执行。
3. 取消应答 `{ operationId, cancelled: true }` 实际写回 output。

宿主 UI 侧不需要随该修复再次改动：UI 早已如实发起协议请求。

**未验证.** 本次执行环境 Bash 不可用（`spawn /bin/zsh EAGAIN`），
未实际运行该用例与 `pnpm typecheck`；上述结论基于源码阅读。

## 7. 验证

- `vitest`：`packages/ui/test/pluginInstallCancellation.test.ts`（传播、状态复位、错误/竞态）；
  `packages/ui/test/pluginManagementStore.test.ts`（既有并发/上下文测试）；
  `packages/ui/test/intlProviderLocalePreference.test.ts`（key 存在与目录一致性）。
- `vitest`（CLI 传输）：`apps/zcode-cli/packages/bootstrap/tests/zcode-protocol-transport.test.ts`
  — `lets plugins/cancelOperation bypass a parked install while uninstall queues`。
- `pnpm typecheck`（本次环境 Bash 不可用，未执行，见 §6「未验证」）。
- 未覆盖：真实 Electron + CLI 进程的端到端取消（需桌面 E2E 环境）；本次也未执行
  bootstrap 包的 vitest 与 `pnpm typecheck`（shell 不可用），§6 的修复结论来自源码阅读。
