# Workspace boundary: strict | ask | allow

| 字段     | 值                                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态     | 已实施（path-policy 决策层）；config / executor 接线为后续任务                                                                                                                                          |
| 日期     | 2026-11-11                                                                                                                                                                                              |
| 来源     | `docs/research/2026-11-11-zcode-wide-competitive-research.md` R03；`docs/research/partials/2026-11-11-zcode-08-tools-providers.md` R-02；`docs/research/partials/2026-11-11-zcode-12-security-trust.md` |
| 适用范围 | `apps/zcode-cli/packages/core/src/tool/path-policy.ts` 及其调用方（Read/Write/Edit/Glob/Grep/Bash cwd）                                                                                                 |
| 主要对象 | `resolveWorkspacePath`、`resolveToolWorkingDirectory`、`workspaceBoundary` 选项                                                                                                                         |
| 安全基线 | 显式模式、realpath 后判定、越界不可静默通过、fail closed                                                                                                                                                |
| 关联文档 | `docs/specs/workspace-hook-trust.md`（同类“未信任不得执行”的准入思路）                                                                                                                                  |

## 1. 问题与现状证据

当前 `resolveWorkspacePath` 只做词法解析，**刻意不拦截** workspace 之外的路径：

- `apps/zcode-cli/packages/core/src/tool/path-policy.ts:32-39` 返回 `resolvedPath`，注释说明
  “Current release intentionally does not hard-block paths outside workspaceRoot”。
- 该行为被测试固定：`apps/zcode-cli/packages/core/tests/file-tool-port.test.ts:420-492`
  （Read/Write/Glob/Grep 均可访问 workspace 外路径）。
- 权限判定不看路径落点：`apps/zcode-cli/packages/core/src/permission/service.ts:117-200`
  只按工具名、模式与规则判定。

因此一次 prompt injection 就可能把 `~/.ssh/id_rsa` 或
`~/.zcode/v2/credentials.json` 变成 Read 的输入，或把文件写到 workspace 之外。

## 2. 词汇与判定对象

| 名称                    | 定义                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `workspaceRoot`         | 调用方声明的 workspace 根（绝对路径）。它是边界，不是解析基准。                            |
| `workingDirectory`      | 相对路径的解析基准（通常是会话 cwd）。                                                     |
| `resolvedPath`（词法）  | `isAbsolute(input) ? normalize(input) : resolve(workingDirectory, input)`，即当前返回值。  |
| `physicalPath`（物理）  | 对 `resolvedPath` 做 realpath 后的真实落点（不存在的尾段保留在已存在祖先的真实路径之后）。 |
| `physicalWorkspaceRoot` | 对 `workspaceRoot` 做 realpath 后的真实根。                                                |

工具展示、cwd、read-state 仍然使用 `resolvedPath`；`physicalPath` **只用于越界判定**，
不替换返回值，避免用户可见路径变成 `/private/...` 之类的软链落点。

## 3. 三个模式

| 模式     | 越界时的行为                                                                                                                                                                                 | 返回                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `strict` | 拒绝。抛 `CoreErrorType.PermissionDenied`，`recoverable: true`，context 带模式、越界类型与两个物理路径。                                                                                     | 不返回越界路径            |
| `ask`    | 进入审批：调用注入的 `WorkspaceBoundaryApprovalPort.decide(request)`；仅当返回 `allow` 才继续（上报 `approve` 审计）。没有审批端口时抛 `CoreErrorType.PermissionEscalation`（fail closed）。 | 批准后返回 `resolvedPath` |
| `allow`  | 允许，并上报一条 `workspace_boundary.escape`（`action: "allow"`）审计事件；便于事后发现越界访问。                                                                                            | 返回 `resolvedPath`       |

公共约束：

1. **边界本身允许**：`resolvedPath === workspaceRoot` 视为包含。
2. 越界判定只有一处实现：`evaluateWorkspaceBoundary`。所有 handler 继续只调用
   `resolveWorkspacePath` / `resolveToolWorkingDirectory`，不新增第二套检查。
3. `ask` 的审批决定是**调用方已经取得的用户决定**（见 §6），path-policy 不自己弹窗、
   不阻塞等待、不用超时兜底。
4. 审计是观察面：`auditWorkspaceBoundary` 抛错不改变安全判定结果，也不阻断工具执行。

### 3.1 默认值

未传 `workspaceBoundary` 时取 `allow`（legacy-compatible），理由：

- 研究建议的目标默认是 `read = allow`、`write = ask`
  （`docs/research/2026-11-11-zcode-wide-competitive-research.md:177`，
  `docs/research/partials/2026-11-11-zcode-08-tools-providers.md:324`）。
- 但 `ask` 只有在 executor / permission-flow 接好真实审批端口后才有意义。在本任务范围内
  若把 write 默认改成 `ask`，所有没有审批端口的调用点都会立即变成
  `PermissionEscalation` 失败：`file-tool-port.test.ts:420-492` 固定了“外部 write 当前允许”
  的兼容行为，subagent 访问 sibling repo 的既有场景也会被打断。
- 因此本层保持 `allow` 作为**兼容默认**，并把“read=allow / write=ask”记录为目标默认，
  由接线任务在具备审批能力后切换。调用方一旦显式传 `strict` 即立刻生效（零额外接线）。

`allow` 默认且未配置审计回调时走快速路径：不做任何文件系统调用，行为与改动前完全一致。

## 4. containment 算法

```
input ──► 词法解析 ──► 词法包含? ──否──► escapeKind = lexical（拒绝/审批/放行）
                            │是
                            ▼
                  目标 realpath（最深已存在祖先 + 不存在尾段）
                            │
                  ┌─────────┴──────────┐
            悬空软链                无法解析（EACCES/ELOOP/ENOTDIR…）
            escapeKind=dangling_symlink   escapeKind=unresolvable
                            │
                            ▼
                  workspaceRoot realpath ──失败──► escapeKind=unresolvable
                            │
                            ▼
                  relative(physicalRoot, physicalPath) 包含?
                            │
                 ┌──────────┴──────────┐
               是                      否
          contained               escapeKind=symlink
```

规则细节：

1. **先词法后物理**。判定输入是**解析后的**路径：`resolve()`/`normalize()` 已经折叠
   `..`，所以“离开 root 且没有回到 root 内”的 `..` 片段会得到 root 之外的
   `resolvedPath`，立即判越界，`escapeKind = "lexical"`。例如 `../outside/secret.txt`
   被拒绝；`dir/../inside.txt` 与 `../ws/inside.txt` 归一后仍在 root 内，不属于越界。
   纯词法越界不再做物理探测。
2. **物理判定必须 realpath**。workspace 内一个指向外部的软链（含软链链、Windows junction）
   在词法层通过，在物理层被识别为 `symlink` 越界。
3. **不存在的路径安全处理**：从目标向上找到第一个已存在祖先做 realpath，再把不存在的尾段
   拼回真实祖先之后。因此“在 workspace 内新建文件/新建目录”正常放行。
4. **悬空软链 fail closed**：目标自身是软链但 `realpath` 失败（目标不存在，或成环 `ELOOP`）
   时无法证明落点，`escapeKind = "dangling_symlink"`，`strict`/`ask` 拒绝。否则写操作会穿过
   悬空软链创建 workspace 之外的字节。
5. **无法解析 fail closed**：`EACCES`、workspace root 不存在或不可解析等无法证明包含的
   情况一律判越界（`escapeKind = "unresolvable"`）。`ENOTDIR` 在向上寻找已存在祖先时按
   “该段不存在”处理，最终落点仍由真实祖先的 realpath 决定。
6. **前缀陷阱**：用 `relative(root, candidate)` 判定，`/ws2` 不属于 `/ws`；跨盘符时
   `relative` 返回绝对路径也判不包含。
7. **root 自身是软链**：两侧都 realpath，`/tmp -> /private/tmp` 这类映射不会把 workspace 内
   文件误判为越界。

### 4.1 平台差异

| 平台    | 处理                                                                                                                                                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows | 复用 `normalizeToolPathForComparison`：Git Bash `/c/...` 归一为盘符、统一盘符大小写、剥离 `\\?\` 扩展前缀；`path.win32.relative` 大小写不敏感，跨盘符判不包含。junction 与 symlink 同样经 `realpath` 暴露。 |
| macOS   | `realpath` 返回磁盘上的真实大小写，已存在路径两侧一致；APFS 可为大小写敏感卷，因此**不**对比较做全路径小写折叠，避免在敏感卷上把两个不同文件当成一个。                                                      |
| Linux   | 大小写敏感，`path.posix.relative` 直接比较；软链按真实落点判定。                                                                                                                                            |
| 分隔符  | 判定使用平台 path API 的 `relative`，不手写 `startsWith(root + sep)`。                                                                                                                                      |

## 5. 审计事件

`auditWorkspaceBoundary(event)` 在每次越界（允许、批准、拒绝）时收到一条：

```ts
interface WorkspaceBoundaryAuditEvent {
  event: "workspace_boundary.escape";
  action: "allow" | "approve" | "deny";
  mode: "strict" | "ask" | "allow";
  configured: boolean; // 模式来自显式配置还是兼容默认
  operation: "read" | "write" | "execute";
  requestedPath: string; // 模型原始输入
  resolvedPath: string; // 词法解析结果
  workspaceRoot: string;
  physicalPath?: string; // 能解析出物理落点时才存在
  physicalWorkspaceRoot?: string;
  escapeKind: "lexical" | "symlink" | "dangling_symlink" | "unresolvable";
  platform: NodeJS.Platform;
  reason?: string; // 拒绝原因 / 审批端口给出的原因
}
```

不记录文件内容、凭据或用户数据；`requestedPath` 是模型自己提交的路径。

## 6. ask 审批契约

```ts
interface WorkspaceBoundaryApprovalPort {
  decide(request: WorkspaceBoundaryApprovalRequest): {
    decision: "allow" | "deny";
    reason?: string;
  };
}
```

请求包含 `operation`、`requestedPath`、`resolvedPath`、`physicalPath?`、
`workspaceRoot`、`physicalWorkspaceRoot?`、`escapeKind` 以及一行 `summary`（确认窗的 path
preview，例如 `Tool path "../outside.txt" resolves to "/x/outside.txt" outside workspace
"/x/ws"; workspaceBoundary=ask, escapeKind=lexical`）。

约定：

- `decide` 必须是**同步**的：调用方先通过 permission broker / 确认窗取得用户决定
  （或在 headless 场景显式配置为 deny），再把结果交给本端口。本层不做异步等待。
- 端口返回 `allow` → 继续执行并上报 `approve`；返回其它值（含 `deny`）→
  抛 `PermissionDenied`，reason 取端口提供的 `reason`。
- 端口抛错同样按拒绝收口（`PermissionDenied`）：ask 模式不能因为审批实现故障而放行。
- 没有端口 → `PermissionEscalation`（`recoverable: true`）。**不会**静默放行，也不会用
  超时或默认允许来掩盖缺失的接线。
- 审批只针对**本次调用**，不缓存、不写会话规则；跨调用复用必须走既有
  `suggestedPermissionUpdates` 机制。

## 7. 接线契约（本任务范围外）

本 spec 交付决策层；以下接线属于后续任务，未在本任务内修改：

1. `RuntimeConfig` / 项目配置新增 `workspaceBoundary?: "strict" | "ask" | "allow"`（含 schema
   校验与非法值 fail closed）。
2. `ToolExecutionContext` 透传 `workspaceBoundary`、审批端口与审计回调。
3. Read/Write/Edit/ApplyPatch/Glob/Grep/Bash 在调用 `resolveWorkspacePath` /
   `resolveToolWorkingDirectory` 时传入上述字段。
4. executor 在 `resolvePermissionCapability` 或权限流中把越界判定变成真实 permission request，
   使 `ask` 拥有用户可见的确认窗（当前 `PermissionEscalation` 仅是 fail-closed 信号）。

在接线完成前：默认 `allow` 保持全部既有行为；显式 `strict` 已可用并立即拒绝越界；
显式 `ask` 在无审批端口的调用点安全失败。

## 8. 非目标

- OS 级 sandbox（seatbelt / bwrap / restricted token）：R04。
- 远程 workspace 的路径语义：`workspaceIdentity` 与远端路径解析不在本 spec。
- Bash 命令内部的 `cat ../x`、解释器逃逸：本 spec 只约束 file tools 与 Bash cwd 的
  **初始路径解析**，不解析 shell 命令内容。
- 完整 TOCTOU 防护：见 §9。

## 9. TOCTOU（诚实边界）

`strict`/`ask` 的判定是**检查时刻**的判定：realpath 之后到 adapter 真正 `open`/`write`
之间，攻击者仍可把中间目录换成软链。要关闭这个窗口需要 adapter 层使用
`O_NOFOLLOW` / `openat` / 逐段 `lstat` 的原子打开方式，或在 OS sandbox 中运行。
本层不引入超时、不重试、不假装原子；窗口如实保留，后续由 adapter/OS sandbox 任务收口。

第二个已知边界是**调用方必须使用本函数返回的归一化路径**。`resolveWorkspacePath` 返回的
`resolvedPath` 已经把 `..` 折叠掉，adapter 打开的就是这一串，因此判定与内核解析一致。
如果某个调用方绕过返回值、把模型原始输入另行交给 adapter，就会出现
`/ws/link-to-outside-dir/../x` 这类“词法落在 `/ws/x`、内核却在软链后应用 `..`”的分歧。
当前所有 handler 都直接使用返回值；这条不变量必须保持，不能把原始输入另开一条执行路径。

## 10. 验收场景

单测（`apps/zcode-cli/packages/core/src/tool/path-policy.test.ts`，真实临时目录）：

1. `strict`：`..` 越界拒绝（`escapeKind = lexical`）；绝对路径越界拒绝；
   `dir/../inside.txt` 这类归一后仍在 root 内的 `..` 允许。
2. `strict`：workspace 内软链指向外部文件拒绝（`escapeKind = symlink`）；
   软链链越界拒绝；悬空软链越界拒绝；指向内部的软链允许。
3. `strict`：边界本身（`workspaceRoot`）允许；内部已存在文件与不存在的待写入文件允许。
4. `strict`：workspace root 自身是软链时，内部路径仍允许（macOS `/tmp` 场景）。
5. `allow`：越界允许并收到 `action: "allow"` 审计事件；未配置模式时保持兼容默认。
6. `ask`：越界调用审批端口（断言 path preview 与 `escapeKind`），批准后放行、拒绝后
   `PermissionDenied`；无审批端口时 `PermissionEscalation`；软链越界同样进入审批。
7. 相对路径与绝对路径解析到同一结果；`resolveToolWorkingDirectory` 同样受边界约束。
8. 纯函数平台用例：`win32` 跨盘符、前缀陷阱、大小写不敏感；`posix` 前缀陷阱。

## 11. 兼容性

- 既有调用点不传新选项 → 行为、返回值、系统调用次数与改动前一致。
- `strict` 只改变越界路径的结果；workspace 内路径（含边界自身）不受影响。
- Windows 既有测试不新增跳过；软链相关用例按仓库惯例 `skipIf(process.platform === "win32")`。
