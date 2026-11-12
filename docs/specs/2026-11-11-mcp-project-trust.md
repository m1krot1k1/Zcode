# Project-scope MCP: untrusted by default + digest-bound approval

| 字段     | 值                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 已实施（bootstrap app + zcode-protocol）；Desktop 设置页显式审批 UX 与 remote relay 为后续任务                                                                                                                |
| 日期     | 2026-11-11                                                                                                                                                                                                    |
| 来源     | `docs/research/2026-11-11-zcode-wide-competitive-research.md`；`docs/research/partials/2026-11-11-zcode-09-context-memory-skills-mcp.md` R-02；`docs/research/partials/2026-11-11-zcode-12-security-trust.md` |
| 适用范围 | `apps/zcode-cli/packages/bootstrap/src/app`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol`                                                                                                           |
| 主要对象 | `resolveAppRuntimeConfig`、`listMcpServers`（`mcp/list`）、`ZCodeApp.connectMcpServer`、project-scope MCP 定义 digest                                                                                         |
| 安全基线 | project-scope 默认拒绝、显式授权、按定义 digest 失效、密钥不入日志/错误、fail closed                                                                                                                          |
| 关联文档 | `docs/specs/workspace-hook-trust.md`（同类「未信任不得执行」准入）、`docs/specs/workspace-hook-trust-persistent-only.md`                                                                                      |

> 实现位置说明：规格 §4 的示意图文件名 `bootstrap/app/mcp-project-trust.ts` /
> `mcp-project-trust-store.ts` 是设计意图，实际落地为
> `bootstrap/src/app/runtime-config.ts` 内的同职责纯函数与 store
> （`computeMcpServerDefinitionDigest`、`resolveUntrustedProjectMcpServers`、
> `readMcpProjectTrustRecords`、`grantMcpProjectTrust`）。未另建平行的 trust 模块，
> 避免同一职责出现两个 owner。

## 1. 问题与现状证据

### 1.1 修改前行为（根因证据）

**FACT（修改前）.** project-scope MCP server 默认 trusted 并自动连接：

- `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:116-121`（修改前）创建空的
  `untrustedProjectMcpServers = new Set()`，注释明确写着「product decision: project MCP trusted by
  default and auto-connected」；
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts:74-76`（修改前）在 `mcp/list`
  路径上重复同样的空集合；
- 结果：`runtimeConfig.mcp.servers`（runtime-config.ts:173-177，修改前）包含 workspace 配置里的
  stdio server，`core/src/runtime/methods/mcp.ts:53-80` 在 session 初始化时直接
  `connectConfiguredServers`，即执行仓库中的任意 `command`。

修改后：上述两处改为调用 `resolveUntrustedProjectMcpServers()`，未获 approval 的 project-scope
server 不再进入 `runtimeConfig.mcp.servers`，也不再进入 `mcp/list` 的 connect 集合。

**FACT.** 未信任状态的投影与文案早已存在，但没有数据来源：

- `apps/zcode-cli/packages/bootstrap/src/mcp-config.ts:202-217`：
  `getConfiguredServerStatus()` 返回 `untrusted`，`getConfiguredServerError()` 返回固定文案
  `Project MCP server requires explicit connection before use.`；
- `packages/ui/src/store/mcpStoreStatusList.ts:36-42` 已把 `untrusted` 映射到设置页；
- 但 `untrustedServerNames` 始终为空集，`omitMcpServers()`（mcp-config.ts:95-114）从未真正过滤
  project server。

**FACT.** scope 归属已有单一事实源，不需要新建判定：

- `apps/zcode-cli/packages/adapters/src/config/config-factory.ts:372-398`
  `resolveEffectiveMcpServers()` 按 system → project → user → env → cli 合并，并产出
  `sources[name] = "system" | "project" | "user" | "env" | "cli"`；
- `apps/zcode-cli/packages/adapters/src/config/project-config.adapter.ts:100-114` 收集 project 文件中的
  server 名；
- `ConfigResult.sources.mcp.serverSources` 是「最终生效定义来自哪一层」的权威标签；user 覆盖
  project 后标签变 `user`，这正是需要的 scope 语义。

**FACT.** 显式连接入口已存在：`apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts:386-398`
`connectMcpServer(name)` 直接 `mcpPort.connectServer(...)`，没有授权检查。CLI `/mcp connect`
（`apps/zcode-cli/packages/cli/src/command-center/handlers/mcp.ts:29-55`）走的就是它。

**FACT.** 用户域安全存储已有先例与路径约定：
`apps/zcode-cli/packages/adapters/src/storage/workspace-hook-trust-store.ts:130-142` 使用
`<storage.dir>/security/…`、0600、temp+rename 原子写、解析失败 fail closed。本规格沿用同一
位置约定，但不复用 Hook 记录 schema（Hook record 要求 `hookDeclarationDigest`/`eventAtGrant`
等 Hook 专属字段）。

## 2. 目标与非目标

### 2.1 目标

1. workspace/project 配置提供的 MCP server 默认 untrusted：不进入
   `runtimeConfig.mcp.servers`，不被 `mcp/list` connect 路径自动连接。
2. 用户显式连接（approve）后，仅对**当次 server 定义 digest** 生效。
3. 定义的任何执行语义字段变化（command/args/env/cwd/url/headers/oauth/transport/timeout…）
   自动使旧 approval 失效。
4. user scope、env、cli、plugin、builtin server 行为保持不变（继续 auto-connect）。
5. 授权持久化在用户域，按 `workspace identity + server name + definition digest` 匹配；
   不能被其他项目或其他 server 复用。
6. 未授权/失效时的状态与错误稳定、可本地化，且绝不包含命令、URL、env 或 header 值。

### 2.2 非目标

1. 不改 Desktop 设置页的交互（本批次没有可用的前端审批 UI；UI 仍把 `untrusted` 呈现为
   unknown + 固定文案）。
2. 不新增 ZCode Protocol 的 wire 字段（`zcodeProtocolMcpServerSchema` 不携带 scope/approval，
   见 §7 已知边界）。
3. 不校验 MCP server 引用的二进制、npm 包或脚本内容（供应链完整性）。
4. 不改变 OAuth 模型、remote relay、pool/lease 语义。
5. 不把 approval 写入 workspace 仓库配置，防止项目自我授权。

## 3. 术语

| 名称                             | 定义                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------- |
| project-scope MCP server         | 最终生效定义来自 `ConfigResult.sources.mcp.serverSources[name] === "project"` 的 server。                  |
| user-scope MCP server            | 生效定义为 `user` / `env` / `cli`，或者由 protocol `mcpServers`/plugin/builtin 显式提供且不在 project 层。 |
| 定义 digest (`definitionDigest`) | 对归一化后的 server 定义做 versioned canonical serialization 后的 SHA-256（见 §5）。                       |
| approval record                  | 用户域安全存储中的一条记录：`workspaceIdentity + serverName + definitionDigest`。                          |
| trust identity                   | `workspaceIdentity?.trim()                                                                                 |     | workspacePath`（与 AGENTS.md 的 workspace identity key 一致）。 |
| untrusted set                    | Runtime/协议层本次投影中「未获 approval 的 project-scope server 名集合」。                                 |

## 4. 状态所有者与事件顺序

```text
ConfigFactory (adapters)                 唯一 scope 权威：sources.mcp.serverSources
        │
        ▼
bootstrap/app/mcp-project-trust.ts       纯函数：digest、untrusted 计算
        │
        ├── bootstrap/app/mcp-project-trust-store.ts  唯一 approval 写者（user 域文件）
        │        ▲
        │        │ 显式 connectMcpServer(name) 时 grant
        │
        ▼
resolveAppRuntimeConfig / mcp/list       读取 approval → 过滤 runtime 集合 → 投影 untrusted 状态
        │
        ▼
AgentRuntime / McpPort                   只看到已授权集合
```

事件顺序（显式授权）：

```text
用户/ZCodeApp.connectMcpServer(name)
  -> 读取当前 configuredMcpServers[name]（内存快照）
  -> 该 server 是否 project-scope 且当前 untrusted?
       否 -> 直接 connect
       是 -> 计算 definitionDigest
           -> 原子写入 approval record（workspaceIdentity + name + digest）
           -> 从本 session untrusted set 移除 name
           -> mcpPort.connectServer(name, 当前快照 config)
```

- 授权绑定的是**内存中的当前定义**，与随后 connect 使用的是同一个 `config` 对象，避免
  TOCTOU（不存在「读 A、批准 A、连接 B」）。
- 写 approval 失败 → 不连接，向调用方返回稳定错误；不降级为「临时放行」。
- 重复 approve 同一定义是幂等 upsert（同 key 覆盖 `grantedAt`）。
- 定义变化后旧 record 保留用于审计，但不再匹配；server 重新变回 untrusted。

## 5. 定义 digest（canonical）

`computeMcpServerDefinitionDigest(config)`，算法恒定 `sha256`，`digestVersion = 1`。

进入 digest 的字段（全部来自 `McpServerConfig`，见
`apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts:17-104`）：

1. `type`（stdio / http / sse，即 transport）；
2. stdio：`command`、有序 `args`、`cwd`、`env`（按 key 排序的完整键值）；
3. http/sse：`url`、`headers`（按 key 排序）；
4. `oauth`：`type`、`clientId`、`clientSecret`、`clientName`、`redirectPath`、`scope`；
5. `auth`：`type`、`provider`；
6. `timeoutMs`、`alwaysLoad`、`isolation`、`protocolVersion`；
7. 宿主注入的 `official` 归属（`pluginId`、`mcpKey`、`source`，若存在）。

显式排除：

- `enabled`：启停是配置状态，不是执行内容；关闭再开启同一定义不需要重新授权
  （与 `docs/specs/workspace-hook-trust.md` §12.2 的 `configuredEnabled` 处理一致）；
- 对象 key 的原始顺序、JSON 空白与格式化（canonical 序列化自行排序）；
- 运行时凭据以外的进程环境（stdio 子进程的 sanitized env 由 adapter 注入，不属于 server 定义）。

digest 输出仅为小写十六进制字符串。实现禁止把 digest 输入（尤其是 env/header/oauth secret）
写进错误、日志或 approval 文件的任何展示字段。

## 6. Approval 存储

### 6.1 位置与格式

```text
<storage.dir>/security/mcp-project-trust-v1.json
```

`storage.dir` 来自已解析的 CLI 配置（`resolvePath(configResult.config.storage.dir)`），
不得在业务代码中硬编码 `$HOME`。文件权限 0600，目录递归创建；写入使用
temp + rename，解析失败一律 fail closed（视为无 approval，不抛出、不影响 user-scope server）。

```ts
interface McpProjectTrustStoreFile {
  schemaVersion: 1;
  records: Array<{
    workspaceIdentity: string;
    serverName: string;
    definitionDigest: string; // sha256 hex
    decision: "approved";
    grantedAt: string; // ISO-8601，仅审计
  }>;
}
```

约束：

- 记录不保存 command/args/env/url/headers/oauth 原文，只有 digest；
- 唯一键 `workspaceIdentity + serverName + definitionDigest`；
- 并发写通过进程内串行队列 + 读改写原子替换；
- 不做自动 GC（记录体积小；后续可独立设计清理策略）。

### 6.2 匹配规则

approval 成立当且仅当存在记录满足：

```text
record.workspaceIdentity === trustIdentity(current workspace)
AND record.serverName === effective server name
AND record.definitionDigest === computeMcpServerDefinitionDigest(current effective config)
AND record.decision === "approved"
```

因此：

- 同一 server 名在不同 workspace（本地路径或 remote identity）之间不共享；
- 同一 digest 在不同 server 名下不共享；
- 定义任意显著字段变化 → digest 不一致 → 未授权。

## 7. 强制执行点

### 7.1 App / Runtime 创建（`resolveAppRuntimeConfig`）

- 输入新增 `projectMcpTrust?: { workspaceIdentity: string; approvals: readonly McpProjectTrustRecord[] }`。
- 对 `configuredMcpServers` 中 `configResult.sources.mcp.serverSources[name] === "project"`
  的 server 计算 untrusted set（未命中 approval）。
- `untrustedProjectMcpServers` 返回该集合；`runtimeConfig.mcp.servers` 通过既有
  `omitMcpServers(configuredMcpServers, untrustedProjectMcpServers, cuaNames)` 排除。
- 未提供 `projectMcpTrust` 视为「零 approval」：project server 全部 untrusted（fail closed）。
- user/env/cli/plugin/builtin server 不受影响（标签不是 `project`）。

### 7.2 `mcp/list`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts`）

- 读取同一 approval store（同一 storage.dir、同一 trust identity =
  `params.workspace.workspaceIdentity?.trim() || params.workspace.workspacePath`）。
- `mode: "connect"`：`connectConfiguredServers` 只接收 `omitMcpServers(...)` 后的集合，
  project-scope 未授权 server 不启动。
- `mode: "status"`：不改变连接集合，只投影状态；未授权 server 由
  `listMcpServerStatuses` 返回 `status: "untrusted"`、`failureKind: "status_unavailable"` 和
  固定文案。
- OAuth pending 早退路径只返回 `mcpPort.status()`（已连接 server），因此必须再用
  `withUntrustedProjectStatuses()` 把缺失的未授权 project server 补投影为 `untrusted`，
  否则设置页会把这些行静默漏掉。
- store 读取失败/损坏 → 视为零 approval（fail closed），不使整个 `mcp/list` 报错。
- 宿主内建 server（`builtInMcpServers`，例如 `node_repl`）不进入判定：它们合并优先级最高，
  同名 project 条目已被覆盖，不能据此把宿主 server 判成 untrusted。

### 7.3 显式授权入口（`ZCodeApp.connectMcpServer`）

- `createSessionFacade` 新增可选依赖 `approveProjectMcpServer({ name, config })`；
  `create-app` 注入的实现写入 6.1 的 store（identity 来自 app 的 workspace identity）。
- server 在 untrusted set 中且提供 approve 回调 → 先写 approval，成功后从 set 移除并 connect。
- 在 untrusted set 中但没有 approve 回调（例如嵌入方只装配了 facade）→ 抛稳定错误，
  不连接（fail closed）。
- 不在 untrusted set 中 → 行为与今天一致。

### 7.4 授权后的工具可见性

`connectMcpServer` 只建立连接；runtime 侧工具注册由既有 `refreshMcpToolsIfChanged()`
（`core/src/runtime/methods/mcp.ts:203-241`）在下一个 turn 边界按 `toolListRevision` 增量刷新。
本规格不新增「连接即热注册」旁路。

### 7.5 不做的事

- `mcp/list` 的 connect 刷新**不能**隐式生成 approval；只有显式 connect 动作可以。
- 运行时 startup / resume / subagent 不得自动 approve。

## 8. 错误与可观测性

| 场景                   | 表现                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| 未授权 project server  | status `untrusted`；error 固定 `Project MCP server requires explicit connection before use.` |
| approval digest 不匹配 | 与未授权相同（不区分「曾经批准过」，避免泄露历史）                                           |
| approval store 损坏    | 视为零 approval；可选 `warn` 仅带路径与错误码，不带文件内容                                  |
| 显式连接缺少授权能力   | 抛错 `Project MCP server requires explicit approval before use: <name>`                      |
| 写入 approval 失败     | 抛错且不连接；日志只带 serverName 与 workspaceKey                                            |

禁止出现在错误/日志/文档示例中的内容：env 值、header 值、OAuth clientSecret、URL 查询串、
完整 command 行（digest 已足以定位定义）。

## 9. 决策记录

### D1. 为什么用 digest 而不是「按 server 名信任」

server 名是仓库可任意声明的字符串；克隆仓库后把 `command` 从 `npx safe` 换成
`bash -c curl|sh` 不应继承旧授权。digest 把授权绑定到执行语义。

### D2. 为什么复用 `serverSources` 而不是新增 scope 字段

`config-factory` 已在合并时算出「最终生效层」，新增字段会产生第二条判定路径且需要改
shared schema（越界）。project 标签天然排除被 user/env/cli 覆盖的同名 server。

### D3. 为什么 approval 存独立文件而不是复用 Hook Trust store

Hook store 的 record schema 强制 Hook 专属字段（`hookDeclarationDigest`、
`eventAtGrant`、`displayCommandAtGrant`），把 MCP 塞进去会污染 Hook 领域并用 Hook
语义解释 MCP 授权。两者共享的只有「user 域 security 目录 + 原子写 + fail closed」约定。

### D4. 为什么排除 `enabled`

关闭/开启不改变将执行的代码；把开关纳入 digest 会让纯 UI 操作使授权失效，制造无意义
重复审批。

### D5. 已知边界：protocol 显式 `mcpServers`

Desktop main 把 user + workspace 行合并后经 `session/create.mcpServers` 下发，wire 上没有
scope 标签。本实现仍以本地 `createConfig` 的 `serverSources` 判定：同名 project 文件条目
仍会被判定为 project 并默认 untrusted。若 Host 下发了本地配置中不存在的 server（例如远程
机器上的 workspace 配置在本地不可见），该条目标签缺失，按 user/protocol scope 处理
（保持旧行为）。要彻底消除该边界，需要在 protocol schema 增加 scope 字段并为旧 Host
做 additive 兼容——属于后续任务，不在本次写域内。

## 10. 验收场景（回归测试）

在 `apps/zcode-cli/packages/bootstrap/tests/mcp-project-trust.test.ts`（bootstrap 包的
`vitest tests` 入口，不在 `src/` 下，避免新增未被任何测试入口收集的文件）：

1. project-scope server 无 approval → 不在 `runtimeConfig.mcp.servers`，在
   `untrustedProjectMcpServers`；`configuredMcpServers` 仍保留完整配置。
2. 正确 approval（同 identity + 同 name + 同 digest）→ 进入 runtime 集合，不在 untrusted set。
3. digest 不匹配 → 仍 untrusted（negative）。
4. `command` / `args` / `env` / `url` 任一变化 → digest 变化、approval 失效（逐字段 negative）。
5. user-scope server 无 approval 仍 auto-connect（行为不变）。
6. 其他 workspaceIdentity 的 approval 不复用；同名不同 server 不匹配。
7. digest 为纯 hex，且不含 secret 子串；untrusted error 文案不含 secret。
8. `listMcpServerStatuses` 对 untrusted set 投影 `untrusted` + 固定文案。
9. `mcp/list` connect 路径不把未授权 project server 传给 `connectConfiguredServers`；
   命中 approval 时传入。
10. `connectMcpServer` 对 untrusted server 先落 approval 再连接；写入后本 session 状态转为
    非 untrusted。
11. `command` / `args` / `env` / `url` / `transport` 任一变化都在**消费侧**
    （`resolveUntrustedProjectMcpServers`）重新判定为 untrusted，而不只是 digest 单测变化
    （r01 补充的合并负例）。
