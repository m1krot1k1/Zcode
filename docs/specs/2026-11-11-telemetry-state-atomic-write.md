# Telemetry state 原子写入（QW12）

- 状态：已实施（spec + code + unit 用例已添加；本次环境未能执行 vitest/typecheck，见 §5）
- 日期：2026-11-11
- 来源：[`docs/research/2026-11-11-zcode-wide-competitive-research.md`](../research/2026-11-11-zcode-wide-competitive-research.md)
  `| QW12 |` 与 `#### R14` / R9（telemetry perf/reliability partial）
- 适用范围：`packages/services/src/telemetry/telemetryCore.ts`、`packages/services/test/telemetryAtomicState.test.ts`

## 1. 问题

`writeTelemetryState` 直接用 `writeFile` 覆盖已有 `telemetry-state.json`：

```ts
// 修改前
await mkdir(dirname(telemetryStateFile), { recursive: true });
await writeFile(telemetryStateFile, JSON.stringify(state, null, 2), "utf-8");
```

证据：`packages/services/src/telemetry/telemetryCore.ts:162-166`（修改前）。

进程崩溃、断电或写入被中断时，目标文件可能是截断/半写的 JSON。`readTelemetryState`
在解析失败时返回 `{}`（修改前 `:152-160`），随后 `ensureDeviceMidInLockedState` 会生成新的
`deviceMid`（修改前 `:286-301`）。后果是设备身份变化：`X-Device-Mid` 漂移，Start Plan/计费
和反馈归因把同一台机器当成新设备。

同一仓库中 CLI 与 Desktop 的同类写入已经是 temp+rename：

- `apps/zcode-cli/packages/adapters/src/device/cli-device-mid.ts:104-121`
- `packages/desktop/src/main/desktopDeviceMid.ts:61-67`

只有 services Core 这条共享写路径仍是原地覆盖。

## 2. 决策

### 2.1 唯一所有者与唯一写路径

`telemetry-state.json` 的所有写入都由 `writeTelemetryState` 完成，调用方必须已持有
`telemetry-state.lock`（`withTelemetryStateLock`，修改前位于 `:226-273`）。本次不新增写入口、
不改变锁协议，也不改变 state 的 JSON 字段。

### 2.2 事件顺序

```text
acquire telemetry-state.lock
  → read state (兼容旧文件/损坏文件)
  → merge 本次字段
  → mkdir state 所在目录
  → stat 目标文件，记录现有 mode（不存在则用默认 mode）
  → open 同目录唯一临时文件 "wx"（pid + 时间 + random）
  → write JSON
  → handle.sync()（rename 前 flush 文件内容）
  → close
  → rename(temp, state)
  → release lock
任一步失败：close + unlink(temp) → 释放锁 → 原样抛错
```

不变量：

- 读者只会看到旧的完整文件或新的完整文件，不会看到半截 JSON。
- rename 之前崩溃：旧文件保持完整，`deviceMid` 不变。
- rename 之后崩溃：新文件已 flush，内容完整。
- 临时文件与目标文件在同一目录，避免 Windows 跨卷 rename 失败。
- rename 替换现有文件在 Windows 上可能被杀毒/索引服务短暂占用
  （`EPERM`/`EBUSY`/`EACCES`）；只对这三类错误做有界重试，其他错误原样抛出，
  不用超时或吞错掩盖真实权限问题。
- 权限保留：目标文件已存在时沿用其 `mode & 0o777`（POSIX，open 后 chmod 以绕过 umask）；
  文件不存在时沿用原先 `writeFile` 的默认 mode 语义（`0o666` 经 umask）。Windows 上
  mode 不生效，跳过 chmod。
- 失败清理：任何失败都删除本次临时文件；`open(..., "wx")` 抛 `EEXIST`（同名活动临时
  文件属于其他进程）时不删除该文件。不扫描/删除其他进程可能正在使用的 `.tmp`，
  避免并发进程互相删文件。

### 2.3 接口与兼容性

- `writeTelemetryState` 仍是模块内部 `async function`，无公共 API 变化。
- 失败语义不变：写失败仍向调用方抛错；`ensureTelemetryDeviceMid` 仍保留
  进程内 fallback UUID 与缓存清理行为（修改前 `:312-334`）。
- `telemetry-state.json` 格式不变；Desktop / CLI 仍读同一个 `deviceMid` 字段。

## 3. 验收场景

| #   | 场景                                                           | 期望                                                                |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| A1  | 已有 state（含其他字段、mode 0600）缺 `deviceMid`，调用 ensure | 最终 JSON 同时含旧字段与 `deviceMid`；mode 仍为 0600；目录无 `.tmp` |
| A2  | 注入 rename 失败                                               | Promise 拒绝；原 state 内容不变且仍是合法 JSON；目录无 `.tmp`       |
| A3  | 连续多次 daily-active 写入时并行读取                           | 每次读取都能 `JSON.parse`；观察到的 `deviceMid` 始终只有一个值      |
| A4  | 新文件首次写入                                                 | 文件内容合法 JSON；不残留 `.tmp`                                    |

测试文件：`packages/services/test/telemetryAtomicState.test.ts`。

## 4. 明确不做

- 不改变 state 字段、锁文件协议、stale-lock 回收策略。
- 不修改 CLI/Desktop 各自的同步 writer（它们已使用 temp+rename）。
- 不增加目录 fsync：rename 前已 flush 文件；崩溃时最坏留下旧的完整文件，
  身份不丢失，因此不需要把目录元数据持久化纳入本项。
- 不清理硬崩溃遗留的历史 `.tmp`（读取方不匹配 `.tmp` 名称，遗留文件无害）。
- 不保留 `telemetry-state.json` 若为符号链接的链接身份：rename 会替换链接本身。
  CLI 侧写入早已是同语义；该场景不在支持范围内。

## 5. 验证方式

```text
pnpm vitest run packages/services/test/telemetryAtomicState.test.ts
pnpm vitest run packages/services/test/telemetryDeviceMid.test.ts packages/services/test/telemetryService.test.ts
pnpm typecheck
```

本次实现时 shell 启动持续返回 `spawn /bin/zsh EAGAIN`（一次 freshness 检查 + 一次重试
均失败），因此上述命令均为 not_run；未经执行验证。需要由具备可用 shell 的负责人
重跑，并确认 A1–A4 与既有 telemetry 用例全绿。
