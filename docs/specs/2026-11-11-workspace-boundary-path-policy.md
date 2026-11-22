# Workspace boundary path policy contract (strict | ask | allow)

| 字段     | 值                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 已实施（path-policy 决策层 + 契约回归）；config / executor 接线为后续任务                                                                 |
| 日期     | 2026-11-11                                                                                                                                |
| 上级规范 | [`docs/specs/2026-11-11-workspace-boundary.md`](./2026-11-11-workspace-boundary.md)：产品背景、模式定义、ask 审批契约与接线范围以该文为准 |
| 本文职责 | 固定 path-policy 的公共契约、判定顺序、默认值与回归测试矩阵；不重复上级规范的产品论证                                                     |
| 适用范围 | `apps/zcode-cli/packages/core/src/tool/path-policy.ts`                                                                                    |
| 回归测试 | `apps/zcode-cli/packages/core/tests/path-policy-workspace-boundary.test.ts`                                                               |
| 安全基线 | 显式模式、realpath containment、无法证明即拒绝、单一判定路径                                                                              |

## 1. 默认模式决策

**默认 `allow`（兼容默认），本任务不改变默认值。** 依据上级规范 §3.1：

1. `strict` 立即生效，不需要额外接线；`ask` 需要真实审批端口。
2. 既有回归（`apps/zcode-cli/packages/core/tests/file-tool-port.test.ts`）固定了 file tools
   可以访问 workspace 外路径；当前还没有 executor / permission-flow 接线。若把默认改成
   `ask`，所有未接端口的调用点会立刻变成 `PermissionEscalation`。
3. 目标默认（`read = allow`、`write = ask`）记录在上级规范；切换必须与接线任务同一提交，
   不能只改这一层。
4. `allow` 且未提供审计回调时走快速路径：不产生任何文件系统调用，返回值和副作用与改动前一致。

## 2. 公共契约

```ts
export type WorkspaceBoundaryMode = "strict" | "ask" | "allow";
export type ToolPathOperation = "read" | "write" | "execute";
export type WorkspaceBoundaryEscapeKind =
  | "lexical"
  | "symlink"
  | "dangling_symlink"
  | "unresolvable";

interface ToolWorkspacePathOptions {
  inputPath: string;
  workingDirectory: string; // 必须绝对路径
  workspaceRoot: string; // 必须绝对路径；它是边界，不是解析基准
  operation: ToolPathOperation;
  workspaceBoundary?: WorkspaceBoundaryMode; // 缺省 allow
  workspaceBoundaryApproval?: WorkspaceBoundaryApprovalPort; // 仅 ask
  auditWorkspaceBoundary?: (event: WorkspaceBoundaryAuditEvent) => void;
}
```

- `resolveWorkspacePath` 返回**词法归一后的绝对路径**；边界判定只决定该路径能否返回。
- `resolveToolWorkingDirectory(inputCwd, options)` 在没有显式 cwd 时，把默认 cwd 送进同一个
  判定，避免“cwd 由调用方注入即可绕过”；`allow` 默认下返回值与旧实现一致。
- 返回值不变量：`resolvedPath` 已折叠 `..`，adapter 打开的就是这个字符串。调用方不得另外
  使用模型原始输入执行，否则会出现“词法判 `/ws/x`、内核经软链后应用 `..`”的分歧
  （上级规范 §9）。
- 错误类型：
  - `strict` 越界 / `ask` 拒绝 → `CoreErrorType.PermissionDenied`（`recoverable: true`）；
  - `ask` 无审批端口 → `CoreErrorType.PermissionEscalation`（`recoverable: true`）；
  - 非法模式或非绝对目录 → `CoreErrorType.ConfigurationError`（`recoverable: false`）。
  - context 带 `workspaceBoundary`、`escapeKind`、`operation`、`requestedPath`、
    `resolvedPath`、`workspaceRoot`，能解析时附 `physicalPath` / `physicalWorkspaceRoot`。

## 3. 判定顺序（单一实现）

```text
input → 绝对路径校验 → 词法解析（折叠 ..） → allow 快速路径?
      → 词法 containment ──否──→ escapeKind = lexical
              │是
              ▼
      workspaceRoot realpath（必须可解析，否则 unresolvable）
              │
              ▼
      目标 realpath（最深已存在祖先 + 不存在的尾段）
              │
              ▼
      物理 containment ──否──→ escapeKind = symlink
              │是
              ▼
          contained
```

1. 词法包含用 `relative(root, candidate)`，不手写 `startsWith(root + sep)`；`/ws2` 不属于
   `/ws`，跨盘符不包含。
2. 目标不存在时，从目标向上找到第一个可 realpath 的祖先，再把缺失尾段拼回真实祖先之后；
   因此 workspace 内新建文件 / 目录正常通过。
3. 软链自身无法 realpath（目标缺失、成环 `ELOOP`）→ `dangling_symlink`；存在但不可解析
   （`EACCES` 等）→ `unresolvable`；workspace root 无法解析 → `unresolvable`。
4. 判定实现只有一处（`applyWorkspaceBoundary` / `evaluatePhysicalContainment` /
   `resolvePhysicalPath`），handler 不得另写检查。

## 4. 模式行为

| escapeKind       | strict             | ask                                     | allow       |
| ---------------- | ------------------ | --------------------------------------- | ----------- |
| lexical          | `PermissionDenied` | 审批端口；无端口 `PermissionEscalation` | 放行 + 审计 |
| symlink          | `PermissionDenied` | 同上                                    | 同上        |
| dangling_symlink | `PermissionDenied` | 同上                                    | 同上        |
| unresolvable     | `PermissionDenied` | 同上                                    | 同上        |

contained（含边界自身）在三种模式下都直接返回，不审批、不审计。

## 5. ask：复用既有审批面

`WorkspaceBoundaryApprovalPort.decide(request)` 必须是同步的：调用方先在既有 permission
broker / 确认窗取得用户决定，再把结果交给端口。path-policy 不弹窗、不等待、不用超时或
默认值兜底。

- 返回 `{ decision: "allow" }` → 继续执行并上报 `action: "approve"`。
- 返回其它值（含 `deny`）→ `PermissionDenied`，reason 取端口提供的 `reason`。
- 端口抛错或返回畸形值（`undefined` / 缺字段）→ `PermissionDenied`，不能发散成 `TypeError`。
- 没有端口 → `PermissionEscalation`，不静默放行。
- 决定只对本次调用有效，不缓存、不写会话规则；跨调用复用走既有
  `suggestedPermissionUpdates`。

## 6. allow 与审计

`auditWorkspaceBoundary` 每次越界调用一次，`action` 为 `allow | approve | deny`，并带
`mode`、`configured`（显式传值还是兼容默认）、`operation`、原始 / 归一路径、
`escapeKind`、`platform`、可选 `reason` 与物理路径。回调抛错被吞掉，不改变判定、不阻断
执行、不重试。审计不记录文件内容或凭据。

## 7. 跨平台

| 平台    | 处理                                                                                                                                                                                          |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | 复用 `normalizeToolPathForComparison`：Git Bash `/c/...` 归一为盘符、盘符大小写归一、剥离 `\\?\`；`path.win32.relative` 大小写不敏感、跨盘符判不包含；junction / symlink 经 `realpath` 暴露。 |
| macOS   | 两侧都 realpath，`/tmp → /private/tmp`、`/var → /private/var` 不会误判；不对比较做全路径小写折叠（APFS 可能大小写敏感）。                                                                     |
| Linux   | `path.posix.relative`，大小写敏感，软链按真实落点判定。                                                                                                                                       |
| 测试    | 软链用例在 Windows `skipIf`；平台矩阵纯函数显式传 platform，任意宿主一致。                                                                                                                    |

## 8. TOCTOU 与已知残留风险（诚实边界）

1. **检查时 vs 打开时**：realpath 判定到 adapter `open` / `write` 之间，攻击者仍可把中间
   目录替换成软链。关闭窗口需要 adapter 层 `O_NOFOLLOW` / `openat` / 逐段 `lstat`，或
   运行在 OS sandbox 中；本层不重试、不用超时假装原子（上级规范 §9）。
2. **必须使用返回值**：见 §2 的返回值不变量；另开原始输入执行等于绕过判定。
3. **词法 `..` 语义**：本层先折叠 `..` 再做 realpath。返回值就是交给内核的字符串，因此
   判定与执行一致；但 `/ws/link/../x` 按词法解释为 `/ws/x`，不是“先解软链再 `..`”的内核直觉。
4. **硬链接不可见**：realpath 只证明路径落点，不证明 inode 身份；workspace 外文件的硬链接
   放在 workspace 内会被视为 contained。
5. **不解析 shell 内容**：只约束 Bash 初始 cwd 的路径解析，不分析 `cat ../x` 等命令内容。
6. **unresolvable fail closed**：坏挂载、权限不足会拒绝合法路径，这是有意的安全取舍。

## 9. 回归测试矩阵

`apps/zcode-cli/packages/core/tests/path-policy-workspace-boundary.test.ts`（真实临时目录）。

注意仓库现状（已核对配置）：两个入口都不会收集 `src/` 旁的测试。
`apps/zcode-cli/vitest.config.ts:16-21` 的 `include` 只收 `packages/*/{test,tests}/**/*.test.ts`；
包内脚本 `apps/zcode-cli/packages/core/package.json:30` 是 `vitest tests`（只收 `tests/`）。
因此存量 `apps/zcode-cli/packages/core/src/tool/path-policy.test.ts` 只能显式按路径运行，
不能当作 CI 证据。本 spec 的契约回归全部放在 `tests/` 下，并把平台矩阵一并复制过来。

| 场景                                                   | 期望                                                                         | Windows                   |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------- |
| `../outside/secret.txt`                                | strict → `PermissionDenied`，`escapeKind=lexical`                            | 运行                      |
| 外部不存在的叶节点（绝对路径）                         | strict → `PermissionDenied`，`escapeKind=lexical`                            | 运行                      |
| 边界自身、已存在文件、内部缺失的嵌套文件               | strict 允许并原样返回                                                        | 运行                      |
| `dir/../inside.txt`                                    | strict 允许（归一后仍在内部）                                                | 运行                      |
| workspace root 不存在                                  | strict → `PermissionDenied`，`escapeKind=unresolvable`                       | 运行                      |
| 内部软链文件 → 外部                                    | strict → `PermissionDenied`，`escapeKind=symlink`                            | 跳过                      |
| 经软链目录访问外部不存在的叶节点                       | strict → `escapeKind=symlink`，`physicalPath` 落在外部                       | 跳过                      |
| 悬空软链                                               | strict → `escapeKind=dangling_symlink`                                       | 跳过                      |
| 内部软链 → 内部                                        | strict 允许                                                                  | 跳过                      |
| ask + 审批 allow / deny / 无端口 / 端口抛错 / 畸形返回 | `approve` / `PermissionDenied` / `PermissionEscalation` / `PermissionDenied` | 运行；软链进入审批跳过    |
| ask + contained                                        | 不调用审批端口                                                               | 运行                      |
| 默认缺省 / 显式 allow                                  | 越界放行；显式 allow + 审计得到 `action=allow`                               | 运行                      |
| 默认快速路径                                           | root 不可解析也不探测、不报错                                                | 运行                      |
| 非法模式                                               | `ConfigurationError`                                                         | 运行                      |
| `resolveToolWorkingDirectory`                          | 默认 cwd 受 strict 约束                                                      | 运行                      |
| 平台矩阵                                               | win32 大小写 / 前缀 / 跨盘符 / Git Bash 盘符别名；posix 前缀                 | 任意宿主（显式 platform） |

## 10. 兼容性与未接线项

- 老调用点不传新选项 → 返回值、系统调用次数与改动前一致。
- `strict` 只改变越界路径的结果；workspace 内路径（含边界自身）不受影响。
- 未完成（上级规范 §7）：`RuntimeConfig` schema、`ToolExecutionContext` 透传、各 handler
  显式传参、executor 把越界变成真实 permission request。在这些完成前默认必须保持 `allow`。
- 本任务不修改 `bash.ts` 或其他 handler。

## 11. 非目标

- OS 级 sandbox、远程 workspace identity、shell 命令内容解析、adapter 原子打开。
