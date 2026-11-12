# Permission hard deny + approval timeout（R05）

- 状态：已实施（硬拒绝优先级、broker 超时语义、配置键 `permission.approvalTimeoutMs`、启动投影）
- 日期：2026-11-11
- 来源：`docs/research/2026-11-11-zcode-wide-competitive-research.md` §R05、QW2、QW3
- 适用范围：`apps/zcode-cli/packages/contracts/src/config`、
  `apps/zcode-cli/packages/adapters/src/config`、`apps/zcode-cli/packages/core/src/permission`、
  `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`
- 主要对象：`PermissionService.checkPermission`、`ManualPermissionBroker.requestPermission`、
  `AgentRuntimeConfig.permissionTimeoutMs`、`ConfigKey.PermissionApprovalTimeout`
- 安全基线：deny 压过 allow/ask；模式不能解除用户硬禁用；悬空审批必须有界收口

## 1. 问题与现状证据

**FACT（修改前）.** `yolo` / `guarded` 的放行分支位于硬拒绝之前：

- `apps/zcode-cli/packages/core/src/permission/service.ts:169-171`：`mode === "yolo" || mode === "guarded"`
  直接返回 `allow`，其后的 `rule.disallowedTools`（:182-189）与 `rule.project.deny`（:191-198）
  永远不可达；
- 既有回归测试把该行为当契约固定：`apps/zcode-cli/packages/core/tests/permission-service.test.ts:937-966`
  （"lets yolo bypass disallowed tool rules"）期望 `allow` / `mode.yolo`；
- 结果是用户配置的 `permission.disallowedTools` 和项目 deny 规则可以被一次模式切换绕过，
  与其“硬禁用”的命名和数据模型不符。

**FACT（修改前）.** 审批超时只有调用方显式传正数时才生效：

- `apps/zcode-cli/packages/core/src/permission/broker.ts:108-126`：`timeoutMs !== undefined`
  就 `setTimeout(..., timeoutMs)`，因此 `0` 会立即超时，而不是 research 要求的“0 = 无超时”；
- `apps/zcode-cli/packages/core/src/runtime/types.ts:149` 已有 `permissionTimeoutMs?: number`，
  `core/src/runtime/helpers/runtime-tools.ts:242` 已把它传给 `ToolExecutor`，
  `core/src/tool/executor/permission-request.ts:73` 已把它传给 broker；
- 但 `permission.approvalTimeoutMs` 这个配置键在 `RuntimeConfig` / `ConfigKey` / 配置
  schema 中都不存在（全仓库 `rg approvalTimeoutMs` 仅命中 research 文档），
  因此配置文件无法设定默认 300000，也无法显式关闭。

**FACT（本次变更前）.** 该配置键的三个落地位置均缺失：`ConfigKey` 无
`PermissionApprovalTimeout`、`RuntimeConfig.permission` 无 `approvalTimeoutMs`、
`ZCodeConfigFileSchema.permission` 不识别该键，`resolveAppRuntimeConfig` 只读会话值。
本次变更落在六处：

- `apps/zcode-cli/packages/contracts/src/config/index.ts`
- `apps/zcode-cli/packages/adapters/src/config/schema.ts`
- `apps/zcode-cli/packages/adapters/src/config/index.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`
- `apps/zcode-cli/packages/adapters/tests/config.test.ts`
- `apps/zcode-cli/packages/bootstrap/tests/runtime-config.test.ts`

## 2. 目标与非目标

### 2.1 目标

1. `disallowedTools` 与项目 `deny` 规则在任何 `yolo` / `guarded` 放行分支之前判定；
   命中即 `deny`，与模式、Plan、工具预览无关。
2. 硬拒绝保持在最前（位于模式迁移、交互确认与 Plan 判定之前），
   压过 Plan 的只读放行与 Guarded 的 user-once 确认。
3. broker 的 `timeoutMs` 语义：正数 = 超时上限；`0`（及负值/非有限值） = 不设超时；
   未设置 = 不设超时。超时仍以 `CoreErrorType.PermissionTimeout` 收口并清理 pending。
4. 保持单一判定路径：`checkPermission` 只保留一处硬拒绝实现，`checkAlwaysAsk` 不再
   重复判定 deny/deny-rules，避免两条顺序不同的路径漂移。
5. 配置键 `permission.approvalTimeoutMs`（默认 300000，`0` = 无超时）经
   `RuntimeConfig` -> `ConfigPort` -> `resolveAppRuntimeConfig` 投影到
   `AgentRuntimeConfig.permissionTimeoutMs`，避免悬空审批无限等待且允许显式关闭。

### 2.2 非目标

1. 不新增 `auto` 模式语义；`auto` 仍以 `mode.auto.unimplemented` 拒绝。
2. 不改变 `requiresUserInteraction` 的既有语义（仍要求用户交互，硬拒绝优先）。
3. 不改变 `PermissionRequest` / `PreToolUse` hook 的覆盖边界（hook 不能抹掉
   `alwaysAsk` 与 `deny`）。
4. 不引入新的风险策略、重试策略或 UI 文案。
5. 不把 `approvalTimeoutMs` 暴露到 wire protocol：`packages/shared` 的协议 schema 与
   `session/create` 参数不变。该超时是产品可见的调节钮，需要单独的产品签字；
   本变更只覆盖 CLI 本地配置文件与启动投影。

## 3. 规则与优先级

`PermissionService.checkPermission` 的目标顺序（从上到下，先命中先返回）：

```text
1. hard deny
     a. permission.disallowedTools（含 subagent alias 展开）
     b. project rules.deny
2. plan mode transition（EnterPlanMode allow / 非法 ExitPlanMode deny）
3. requiresUserInteraction -> ask
4. guarded + toolCapability.userApprovalRule -> ask (approvalMode: "user-once")
5. alwaysAsk -> checkAlwaysAsk（auto 保护 + 会话规则；不再重复 deny）
6. yolo / guarded -> allow（mode.yolo）
7. auto -> deny（mode.auto.unimplemented）
8. project rules.ask -> ask
9. channel reply / plan / project allow / preapproved / allowedTools / edit / build ...
```

关键不变量：

- 第 1 步是唯一硬拒绝入口；原第 169-198 行的重复判定删除，避免出现两条顺序不同的路径。
- `EnterPlanMode` 也在硬拒绝之后：用户显式禁用的模式切换工具同样不可执行；非法
  `ExitPlanMode` 仍由第 2 步的 `mode.plan.exitOnly` 拒绝。
- 第 1 步位于 `requiresUserInteraction` 与 `userApprovalRule` 之前：deny 压过 ask，
  不能退化成“弹窗点一下就能跑”。
- 第 1 步位于 Plan 的 readOnly allow 之前：项目 deny 与 disallowedTools 在 Plan 下同样生效
  （既有测试 `does not let explicit session capability bypass plan-mode deny or ask rules` 保持）。
- `allowedTools`、项目 `allow` 规则、`PreToolUse` allow 都不能覆盖第 1 步。

## 4. Approval timeout

### 4.1 Broker 语义

`ManualPermissionBroker.requestPermission(request, options)`：

| `options.timeoutMs` | 行为                                             |
| ------------------- | ------------------------------------------------ |
| `undefined`         | 不设超时，等待显式 resolve / reject / abort      |
| `> 0`               | 到点以 `PermissionTimeout` reject 并清理 pending |
| `0` / 负数 / 非有限 | 不设超时（“显式关闭”）                           |

非有限值（`NaN` / `Infinity`）按“未提供有效上限”处理，不能排出一个永不触发或立即触发的 timer。
超时与 abort 的竞速保持现状：先 settle 者生效，随后 `cleanup()` 清掉另一条路径。

### 4.2 配置键与启动默认值

配置键为 `permission.approvalTimeoutMs`（单位毫秒）。落地位置：

- `contracts/src/config/index.ts`：`ConfigKey.PermissionApprovalTimeout`、`ConfigValue`
  映射为 `number`、`RuntimeConfig.permission.approvalTimeoutMs: number`、
  `DefaultRuntimeConfig.permission.approvalTimeoutMs = 300_000`。
- `adapters/src/config/schema.ts`：`permissionSchema` 接受
  `approvalTimeoutMs: z.number().finite().nonnegative().optional()`；schema 保持非 strict，
  未知兄弟键继续忽略。
- `adapters/src/config/index.ts`：`ConfigStore.merge` 用 `!== undefined` 保留显式 0；
  `getAll()` 读键；`getDefaultValue` 返回 300000。
- `bootstrap/src/app/runtime-config.ts`：投影到 `AgentRuntimeConfig.permissionTimeoutMs`。

优先级（高到低）：

```text
options.runtimeConfig.permissionTimeoutMs   （显式会话值，0 = 关闭）
        > configResult.config.permission.approvalTimeoutMs   （配置文件 / project / env / cli 覆盖）
        > DEFAULT_PERMISSION_APPROVAL_TIMEOUT_MS = 300_000
```

实现上是一个单一投影函数
`resolvePermissionApprovalTimeoutMs(sessionValue, configuredValue)`，两个入参都显式声明为
`number | undefined`，函数体是一次 `??` 链：会话值 > 配置文件值 > 300000。
参数类型必须显式宽化：`RuntimeConfig.permission.approvalTimeoutMs` 在 contracts 里是必填
`number`，直接在调用点写 `session ?? config ?? 300000` 会被 TS2869（右侧不可达）拒绝；
而运行时手工装配的 ConfigResult 仍可能不带该键。
`??` 只跳过 `null`/`undefined`，因此显式 `0` 在三层中的任何一层都会原样保留，
并在 broker 处按 §4.1 解释为“不设超时”。

取值约定：

- `> 0` 且有限：审批等待上限（毫秒）。
- `0`：显式关闭超时，broker 不排 timer。
- 负数 / 非有限：配置文件层直接拒绝（整份配置 `loaded:false`，`config` 为空）；
  broker 侧仍按“无超时”处理，两层语义不冲突：配置层拒绝非法输入，运行时不再出现该值。
- 缺省：`DefaultRuntimeConfig` 与启动兜底都是 300000。

消费链不变（`core/src/runtime/helpers/runtime-tools.ts:242` → `ToolExecutorImpl` →
`permission-request.ts:73` → broker），本键只补配置入口与投影，不新增判定路径。

非目标：不新增 protocol 字段。`permissionTimeoutMs` 仍只由 host 内部装配写入，
`session/create` 的 wire 参数与 `packages/shared` 协议 schema 不变。

## 5. 状态所有者与事件顺序

```text
user/project config ──> ConfigFactory (唯一 scope/默认值权威)
                              │
                              ▼
PermissionService.checkPermission   纯策略判定（deny > ask > allow）
                              │
                              ▼
ToolExecutor.requestPermissionResponse  唯一审批发起方
                              │  timeoutMs = deps.permissionTimeoutMs
                              ▼
ManualPermissionBroker / protocol broker   唯一 pending 收口方
        │ resolve | reject | abort | timeout
        ▼
PermissionDecisionResult / ToolExecutionResult
```

- 超时只由 broker 的 timer 触发，不引入第二个 watchdog。
- `timeoutMs` 每个请求独立，不跨请求共享状态；同一 `requestId` 重复请求仍被拒绝。
- 超时后 late response 必须按未命中处理（pending 已删除），不改变已收口的结果。

## 6. 验收场景（回归测试）

| ID    | 场景                                                                      | 位置                                     |
| ----- | ------------------------------------------------------------------------- | ---------------------------------------- |
| HD-01 | `yolo` + `disallowedTools:["Bash"]` -> `deny` / `rule.disallowedTools`    | `core/tests/permission-service.test.ts`  |
| HD-02 | `guarded` + `disallowedTools:["Bash"]` -> `deny` / `rule.disallowedTools` | 同上                                     |
| HD-03 | `yolo` + project `deny` -> `deny` / `rule.project.deny`                   | 同上                                     |
| HD-04 | `guarded` + project `deny` -> `deny` / `rule.project.deny`                | 同上                                     |
| HD-05 | Plan + project deny 仍 deny（既有用例保持）                               | 同上                                     |
| HD-06 | `alwaysAsk` 工具在 yolo 下仍 ask（既有用例保持）                          | 同上                                     |
| HD-07 | `allowedTools` 命中也不能覆盖 `disallowedTools`                           | 同上                                     |
| HD-08 | 硬拒绝压过 `EnterPlanMode` 的 `tool.plan.enter` allow                     | 同上                                     |
| AT-01 | broker `timeoutMs: 0`/负数/NaN/Infinity 不超时，可被 resolve              | `core/tests/permission-broker.test.ts`   |
| AT-02 | broker `timeoutMs: 1` 超时 -> `permission_timeout` 且 pending 清空        | 同上（既有用例）                         |
| AT-03 | broker abort 清理 pending（既有用例保持）                                 | 同上                                     |
| AT-04 | 无显式会话值时 runtime 默认 `permissionTimeoutMs = 300_000`               | `bootstrap/tests/runtime-config.test.ts` |
| AT-05 | 显式值（含 `0` = 关闭）透传不改写                                         | 同上                                     |
| AT-06 | executor + broker 链路：`permissionTimeoutMs: 0` 时不超时，仍可被 allow   | `core/tests/guarded-approval.test.ts`    |

配置键 `permission.approvalTimeoutMs` 的回归用例（本次新增）：

- AT-07 配置文件 `approvalTimeoutMs` 覆盖 300000 默认（`createConfig` → `config.permission`）。
- AT-08 配置文件 `approvalTimeoutMs: 0` 在 merge / `getAll` / `configPort.get` 中都保持 0。
- AT-09 未配置该键时 `createConfig` 返回 `300_000`（`DefaultRuntimeConfig` 兜底）。
- AT-10 配置 `approvalTimeoutMs: -1` 被 schema 拒绝，整份配置 `loaded:false`、`config` 为空。
- AT-11 schema 对该键是加法：未知兄弟键 `permission.futureKnob` 仍被忽略（不变成 strict）。
- AT-12 投影：配置文件值进入 `runtimeConfig.permissionTimeoutMs`。
- AT-13 投影：显式会话值压过配置文件值。
- AT-14 投影：配置 `0` 不被 `??` 右侧默认值吃掉。

AT-07~AT-11 位于 `adapters/tests/config.test.ts`，AT-12~AT-14 位于
`bootstrap/tests/runtime-config.test.ts`。

## 7. 已知阻塞（剩余）

剩余缺口只有两项，均不在本次写入范围：

- protocol 桥接层对 `timeoutMs: 0` 仍立即超时：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts:1139-1152`
  （经 `interaction-broker.ts` 的 `withInteractionRequestRecovery` 透传）。
- `approvalTimeoutMs` 未进入 wire protocol：`packages/shared` 协议 schema 与
  `session/create` 参数不变。这是产品可见调节钮，需要单独签字；属于 §2.2 明确非目标。

关于第一项：`ManualPermissionBroker` 已按 §4.1 把 `0`/负值/非有限值当作“无超时”。
但 Desktop/protocol 链路使用 `createProtocolInteractionBroker`，它把
`PermissionBrokerRequestOptions.timeoutMs` 原样透传给 `requestClient`，而
`server.ts` 的 `if (options?.timeoutMs !== undefined)` 会对 `0` 排一个 0ms timer 并立即
拒绝。因此在 protocol 会话里显式关闭超时（`0`）目前不会被遵守；默认 300000 与正数
行为一致。修复需要在上述文件把同一套“有限正数才启用”的判定复用到 `requestClient`
（或让 interaction-broker 归一化后再透传）。注意这条只影响 protocol 链路，CLI 本地
`ManualPermissionBroker` 已按 §4.1 生效。

配置键已落地：`DefaultRuntimeConfig.permission.approvalTimeoutMs = 300_000`，启动投影按
§4.2 的单一投影函数读取，配置文件因此可以覆盖默认值或显式关闭（`0`）。
