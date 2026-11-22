# Source Server 冷启动等待合同

## 问题

`zcode serve --daemon` 在 service manager 或 detached fallback 启动 Supervisor 后，只等 10 秒 persisted `ready`。Supervisor 自己允许 Core 用 `CORE_READY_TIMEOUT_MS`（15 秒）完成启动，因此 10–15 秒之间的健康冷启动会被 CLI 提前判为失败：

```text
[source-server:daemon] Starting Source Server
Timed out waiting for Server ready
```

SSH 连接本身已经建立，终端也能登录；失败点是远端 Supervisor 还没写完 `ready`。

## 状态所有权

- Supervisor 唯一写入 `run/status.json`，状态依次为 `starting` → `ready`，或进入 `crash-loop-stopped`。
- CLI 只读 persisted 状态，不根据进程存在、端口探测或固定 sleep 推断 ready。
- Desktop / Host 只展示 CLI 结果，不另建远端 server 状态。

## 合同

- `DAEMON_READY_WAIT_TIMEOUT_MS = CORE_READY_TIMEOUT_MS + 10_000`，外层等待必须长于 Supervisor 的 Core 启动预算，并给 service 注册留出时间。
- 等待 `ready` 时，如果 persisted 状态在新 baseline 之后进入 `crash-loop-stopped`，立即失败并带上 `lastExitReason`，不继续空等。
- 超时错误包含最后观察到的 `state`、`lastExitReason` 和 `status.json` 路径；`lastExitReason` 压缩空白并截断，避免把多行 stderr 直接塞进 UI。
- CLI 不主动 kill 远端 Supervisor；正常运行的 Server 不因等待预算变化被重启。

## 事件顺序

```text
CLI: read status baseline
CLI: register service ──fallback──> fork supervisor
CLI: poll status every 100ms
Supervisor: starting -> launch core
Core: ready -> Supervisor: status ready
CLI: observe ready -> attach
```

失败路径：

```text
Supervisor: crash -> crash-loop-stopped(lastExitReason)
CLI: observe crash-loop-stopped -> error with reason
```

## 验收

- 冷启动在 10–25 秒内完成时，`serve --daemon` 返回 `ready`，不再报超时。
- Core 持续崩溃并耗尽 crash budget 时，CLI 错误包含 `crash-loop-stopped` 和 `lastExitReason`。
- 已 ready 的 Server 不会被新的等待逻辑停止或替换。
- `daemonRegistration.test.ts` 覆盖等待预算与 crash-loop 诊断。

## 不在范围

- 自动清理远端 stale Supervisor；восстановление stale lock при переиспользовании PID описано в [source-server-lock-owner.md](2026-11-18-source-server-lock-owner.md).
- UI 侧连接总超时、手机 relay 恢复链路。
