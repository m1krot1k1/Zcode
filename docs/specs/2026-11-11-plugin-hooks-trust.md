# Plugin Hooks Trust Gate（第三方插件 Hook 默认不可执行）

| 字段     | 值                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 已实施（adapters 层 gate + trust store + 回归测试）                                                                                                                                         |
| 日期     | 2026-11-11                                                                                                                                                                                  |
| 适用范围 | ZCode CLI plugin loader（`apps/zcode-cli/packages/adapters/src/plugins`）                                                                                                                   |
| 主要对象 | 插件 manifest / `hooks/hooks.json` 声明的 Hook                                                                                                                                              |
| 安全基线 | 默认拒绝、显式信任、身份 + 定义内容绑定、撤销立即生效、损坏即 fail closed                                                                                                                   |
| 关联     | `docs/hooks-runtime-contract.md`；`docs/specs/workspace-hook-trust.md`；`docs/claude-code-marketplace-plugin-compat.md`；`docs/research/2026-11-11-zcode-wide-competitive-research.md` §R02 |

## 1. 问题与现状

`apps/zcode-cli/packages/adapters/src/plugins/index.ts` 的 `canRunPluginHooks()` 无条件
`return true`，并把该结果同时用于：

1. 生成 `PluginLoadOutcome.hooks`（bootstrap 将其并入 `HooksRuntimeConfig.events` 后由
   core HookRunner 执行）；
2. 生成 `PluginMetadata.hookDetails[].runnable`（设置页展示）。

因此「安装一个第三方 marketplace 插件」等价于「允许其任意 shell/process 命令在
SessionStart / PreToolUse 等事件执行」。research §R02 与
`docs/claude-code-marketplace-plugin-compat.md` 都要求第三方 Hook 先经过显式信任，
当前实现放弃了该边界。

同时，`plugins.dirs` 是 merged RuntimeConfig 的一部分，workspace/project 配置可以注入
本地插件目录（`inline` 候选）。如果只区分 `official` 与 `cache`，project-scope 仍可借
`inline` 获得隐式执行权。本规格将 `inline` 也视为第三方。

## 2. 目标

1. first-party（随应用发布的 official 插件与 official marketplace 安装产物）Hook 行为
   完全不变，无需信任即可执行。
2. 其他来源（第三方 marketplace 的 `cache` 安装、`inline` 本地目录）Hook 默认
   `runnable:false`，且不进入 `PluginLoadOutcome.hooks`。
3. 用户显式信任后同一插件的 Hook 才能进入可执行集合。
4. 信任绑定稳定身份：`pluginId + version + hook definition digest`。任一变化都使旧记录
   失效（fail closed），必须重新信任。
5. 信任可撤销；撤销后下一次 discovery 立即不再注册 Hook。
6. project-scope 与手工 `plugins.dirs` 注册不产生隐式信任。
7. 信任存储不包含命令文本、环境变量或凭据；日志/诊断不新增敏感输出。
8. 损坏、不可读或版本不匹配的 trust store 一律按「无信任记录」处理。

## 3. 非目标

1. 不引入 OS 级 sandbox，不改变 Hook 执行器、超时、输出上限或 matcher 语义。
2. 不改变 workspace/project Hook 的 Trust 机制（见 `workspace-hook-trust.md`）。
3. 不改变 MCP/Skill/Command 的既有信任策略。
4. 不实现信任 UI/协议命令（见 §8 未完成项）；本规格只定义 adapters 层的事实与 API。
5. 不校验 Hook 引用脚本、二进制或依赖内容。

## 4. 信任身份与 Digest

### 4.1 First-party 判定

```text
firstParty =
  loaded.source === "official"
  OR isOfficialMarketplaceId(loaded.marketplace)
```

`isOfficialMarketplaceId` 来自 `@zcode/contracts`，覆盖 `zcode-plugins-official` 与
`claude-plugins-official`。`inline` 明确不是 first-party。

### 4.2 Definition digest

从本次 discovery 解析出的全部 `PluginHookDetail`（不是文件字节）构造 canonical 数组：

```text
[event, matcher|null, type, command,
 process: args[], enabled|null, timeoutMs|null,
 command: async|null, shell|null, timeout|null, timeoutMs|null, enabled|null]
```

按解析顺序（event 键顺序 + matcher 顺序 + hook 顺序）序列化为：

```json
{ "hookTrustVersion": 1, "pluginId": "...", "version": "...", "hooks": [ ... ] }
```

再计算 SHA-256 hex。显式排除：

- `runnable`（评估结果，不是定义）；
- `sourcePath`（绝对安装路径随机器变化）；
- `statusMessage`（仅展示，不影响执行）；
- 任何 runtime-only provenance（`plugin`）。

`enabled` 是插件自带内容（不是用户配置开关），因此进入 digest：插件更新把休眠 Hook
打开时同样必须重新信任。

`version` 使用 `manifest.version ?? "0.0.0"`（与 loader 既有 `DEFAULT_VERSION` 一致）。
版本或任一 Hook 执行字段变化都会改变 digest，旧记录因此不再命中。

## 5. 信任存储

### 5.1 位置与格式

```text
<pluginStorageRoot>/security/plugin-hook-trust-v1.json
```

`pluginStorageRoot` 即 `discoverPlugins` 的 `storageRoot`（bootstrap 传入
`<cli storage>/plugins`）。文件格式：

```ts
interface PluginHookTrustStoreFile {
  schemaVersion: 1;
  records: PluginHookTrustRecord[];
}

interface PluginHookTrustRecord {
  decision: "trusted";
  definitionDigest: string; // sha256 hex
  digestAlgorithm: "sha256";
  grantedAt: string;
  pluginId: string;
  version: string;
}
```

约束：

- 目录 `0700`、文件 `0600`（尽力而为，失败不阻断读取）；
- 写入使用现有 `writeFileAtomically`（temp + rename），并持有 `<file>.lock` 排他锁；
- 同一 `pluginId` 只保留一条当前记录（grant 覆盖）；
- revoke 改写时遇到损坏 store 按空集合处理，仍原子写入；
- 不写入 command / args / env / 凭据；digest 为单向哈希。

### 5.2 单一所有者与单一写入路径

`apps/zcode-cli/packages/adapters/src/plugins/plugin-hook-trust.ts` 是唯一 owner：

- `loadPluginHookTrustState()`：只读，返回 `missing | ok | corrupt`；
- `evaluatePluginHookTrust()`：纯函数判定，不写状态；
- `grantPluginHookTrust()` / `revokePluginHookTrust()`：唯一写入 API（内部唯一 mutate+lock 路径）；
- `computePluginHookDefinitionDigest()`：与评估共享同一 canonical 公式。

`index.ts` 的 discovery 只读取一次 state 并把结果传给 gate，不缓存第二份信任状态，也不
在 UI/CLI 层重复判定。

## 6. 执行门禁

```text
loadPlugin
  -> listPluginHookSources / parsePluginHookEvents   (得到全部 details + events)
  -> computePluginHookDefinitionDigest
  -> evaluatePluginHookTrust(firstParty, records)
  -> hooksRunnable = firstParty || exact record match || details.length === 0
  -> details[*].runnable = hooksRunnable
  -> outcome.hooks = hooksRunnable ? events : {}     (enabled 时)
```

- gate 必须在 `resolveEnabledComponents` 之前完成；未信任时不得把 matcher 数组交给
  bootstrap/core，也不得创建外部进程。
- 插件 `enabled:false` 的既有行为不变（仍返回空 component events）。
- `hookDetails` 始终保留完整定义供设置页只读展示，只是 `runnable:false`。
- 不依赖超时、重试或 UI 自律来实现拒绝。

## 7. 行为矩阵

| 来源                                         | 无记录 | 匹配记录 | 记录版本/定义不匹配 | revoke 后 |
| -------------------------------------------- | ------ | -------- | ------------------- | --------- |
| official（bundled / `official` marketplace） | 运行   | 运行     | 运行                | 运行      |
| 第三方 marketplace（`cache`）                | 阻止   | 运行     | 阻止                | 阻止      |
| `inline`（含 project `plugins.dirs`）        | 阻止   | 运行     | 阻止                | 阻止      |
| store 缺失 / 损坏 / schema 不符              | 阻止   | 阻止     | 阻止                | 阻止      |

阻止语义：`outcome.hooks` 不包含该事件；`hookDetails[].runnable === false`；不产生新
诊断码（避免契约改动和敏感命令进入诊断）。

## 8. 未完成项与迁移

- 本层已导出 grant/revoke/evaluate API 与 digest 计算，但仓库内尚无「安装后审核/信任」
  的 UI 或 CLI 命令；在接入之前，第三方与 inline 插件 Hook 将被阻止（fail closed）。
- `docs/claude-code-marketplace-plugin-compat.md` 仍写着 "inline 维持现有受信行为"，
  与本规格冲突；该文档不在本变更写入范围，需要后续同步。
- 已存在的 third-party Hook 用户会看到 `runnable:false`，需要产品化审核入口后才能恢复。

## 9. 验收测试

回归测试位于 `apps/zcode-cli/packages/adapters/src/plugins/plugin-hook-trust.test.ts`
（与 `src/mcp/appConnections.test.ts` 同属 co-located 约定）。当前 `apps/zcode-cli/packages/adapters`
的 `test` 脚本是 `vitest tests`，根 `vitest.config.ts` 的 unit project 只收集
`packages/*/test(s)/**` 与 `src/**/contract.test.ts`，因此该文件必须显式指定路径运行：

```bash
pnpm --filter @zcode/adapters exec vitest run src/plugins/plugin-hook-trust.test.ts
```

把它纳入默认 collection（移动到 `apps/zcode-cli/packages/adapters/tests/` 或扩展 include）
属于后续改动，本变更未修改该目录。

| ID    | 场景                                                                            |
| ----- | ------------------------------------------------------------------------------- |
| PT-01 | 第三方 marketplace Hook 无记录：`outcome.hooks === {}`，detail `runnable:false` |
| PT-02 | 显式 grant 后同一 discovery 注册 Hook，detail `runnable:true`                   |
| PT-03 | grant 后修改 `manifest.version`：记录失效，Hook 被阻止                          |
| PT-04 | grant 后修改 hook command：digest 变化，Hook 被阻止                             |
| PT-05 | revoke 后 Hook 再次被阻止                                                       |
| PT-06 | official 插件无记录直接运行（first-party 不回归）                               |
| PT-07 | official marketplace 安装产物无记录直接运行                                     |
| PT-08 | `inline`（project `plugins.dirs` 形态）无记录时阻止，grant 后运行               |
| PT-09 | trust store 损坏时 fail closed，不抛异常                                        |
| PT-10 | 阻止发生在注册前：details 存在但 events 不产生                                  |

### 9.1 已同步更新的既有断言

`apps/zcode-cli/packages/adapters/tests/plugins.test.ts` 原先按「inline / 第三方 hook 默认可执行」
断言，与 §6 的 gate 冲突；本变更已把这三处改成默认阻止：

- `loads Claude-compatible local plugin components`：inline 插件未信任，
  `outcome.hooks.SessionStart` 为 `undefined`，`hookDetails[0].runnable` 为 `false`。
- 同用例的 disabled 分支：`runnable` 从 `true` 改为 `false`（启停与信任是两个正交维度）。
- `blocks Marketplace cache hooks from third-party marketplaces until trusted`（原名
  `runs Marketplace cache hooks ...`）：默认阻止，grant 后才注册的行为由 PT-02 覆盖。
- `runs hooks from official Claude marketplace cache plugins when enabled` 保持不变：
  first-party 仍直接运行。

## 10. 安全与日志

- 不新增日志；现有 loader 诊断不包含 Hook 命令以外的新内容，也不读取 trust store 内容
  到日志。
- 错误信息只包含路径与固定原因，不含记录正文或命令。
- 读取失败按 corrupt 处理而不是抛错，避免把 trust store 故障升级为插件加载崩溃。
