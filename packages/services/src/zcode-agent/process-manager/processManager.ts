/**
 * process-manager/processManager.ts: Публичный класс менеджера процессов.
 *
 * Наследник `ZCodeAgentProcessManagerBase` добавляет только spawn-оркестрацию
 * (`startClient`): резолвинг команды, admission-барьеры, spawn, публикация
 * lifecycle/runtime identity и подписка на exit/timeout/close.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { GEN_UI_OUTPUT_DIRECTORY, GEN_UI_OUTPUT_ROOT_ENV } from "@zcode/shared/node";
import {
  parseZCodeProcessDiagnostic,
  ZCODE_AGENT_LIFECYCLE_LOG_MARKER,
  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
} from "@zcode/shared/process-diagnostic";
import {
  ZCODE_AGENT_PROVIDER,
  ZCODE_RUNTIME_ENV_KEY,
  resolveZCodeRuntimeEnv,
  sanitizeZCodeRuntimeEnv,
} from "@zcode/shared";
import { getAppConfigDir } from "#src/paths.js";
import { buildAgentWorkspaceIdentityEnv } from "#src/runtime-tools/agentProxyEnv.js";
import { shouldSpawnInDetachedProcessGroup } from "#src/process/processTreeTerminator.js";
import { localRuntimeNetworkCapture } from "#src/zcode-agent/localRuntimeNetworkCapture.js";
import { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "#src/zcode-agent/zcodeStdioTransport.js";
import { ZCodeAgentProcessManagerBase } from "./lifecycleBase.js";
import {
  buildZCodeAgentSpawnPreflight,
  wrapZCodeAgentCommandWithStdioTapDevProxy,
} from "./commandResolver.js";
import { buildE2EAgentCoverageEnv } from "./coverageEnv.js";
import { createAgentStderrTail, redactAgentDiagnostic } from "./diagnostics.js";
import { debugLog, errorLog, log, warnLog } from "./logging.js";
import type { ManagedZCodeAgentProcess, ZCodeAgentRuntimeIdentity } from "./types.js";

export class ZCodeAgentProcessManager extends ZCodeAgentProcessManagerBase {
  protected async startClient(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
    },
    workspaceKey: string,
    startGeneration: number,
    admissionSignal: AbortSignal,
  ): Promise<ZCodeProtocolClient> {
    const startStartedAt = Date.now();
    const resolveCommandStartedAt = Date.now();
    const command = await this.commandResolver({
      ...params,
      ...(this.presentationSurface ? { presentationSurface: this.presentationSurface } : {}),
      workspaceKey,
    });
    const resolveCommandDurationMs = Date.now() - resolveCommandStartedAt;
    if (!command) {
      throw new Error(
        "ZCode agent server command is not configured. Set ZCODE_AGENT_SERVER_COMMAND before integration.",
      );
    }
    if (admissionSignal.aborted) {
      throw admissionSignal.reason ?? new Error("ZCode agent process start was cancelled.");
    }
    const effectiveCommand = wrapZCodeAgentCommandWithStdioTapDevProxy(command, workspaceKey);
    log("ZCode agent command resolved", {
      workspaceKey,
      command: command.command,
      effectiveCommand: effectiveCommand.command,
      resolveCommandDurationMs,
    });

    // Helper recovery 可能在 command resolve 期间开始；先等待一次，确保 env 解析使用
    // recovery 后的 broker 凭据，而不是把旧状态带到 spawn 边界。
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });

    // 设置页代理等运行时 env 在 process.env 之后合入（覆盖继承的同名 shell 变量），
    // 但仍让 command.env（部署特定）保持最高优先级。
    const spawnEnv = (await this.resolveSpawnEnv?.({ ...params, workspaceKey })) ?? {};
    if (this.disposed) {
      // app 正在关闭时，启动中的 warmup 可能刚完成 command/env resolve。
      // 这时继续 spawn 会绕过 disposeAllAndWait 的快照，重新制造一个无人托管的 agent 进程。
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      // 切模型会重启单个 workspace。旧启动请求如果在重启后才恢复，
      // 不能继续 spawn 并写回进程池，否则新配置会被旧 agent 覆盖。
      throw new Error("ZCode agent process start was cancelled.");
    }
    // cwd 探测也让出事件循环，必须放在最终 admission 与销毁/代际检查之前。
    const spawnPreflight = await buildZCodeAgentSpawnPreflight(
      effectiveCommand,
      params.workspacePath,
      this.spawnFallbackCwd,
    );
    admissionSignal.throwIfAborted();
    // env resolve 本身是异步的，恢复屏障可能在这段时间重新关闭；必须在 spawn 前
    // 再等待并复查代际，不能只依赖第一次 admission。
    await this.waitForSpawnAdmission?.({ ...params, workspaceKey, signal: admissionSignal });
    if (this.disposed) {
      throw new Error("ZCode agent process manager is disposed.");
    }
    if ((this.restartGenerationByWorkspaceKey.get(workspaceKey) ?? 0) !== startGeneration) {
      throw new Error("ZCode agent process start was cancelled.");
    }
    // app 以本地开发方式启动时，让 agent 子进程也带上 ZCODE_RUNTIME_ENV=development；
    // 不再传 NODE_ENV，避免用户 shell/runtime 变量影响 ZCode 运行模式或泄漏到 Bash 工具。
    const runtimeEnv = resolveZCodeRuntimeEnv(process.env);
    log("ZCode agent spawn preflight", {
      workspaceKey,
      spawnPreflight,
    });
    const spawnRequestedAt = Date.now();
    const child = spawn(effectiveCommand.command, spawnPreflight.args, {
      cwd: spawnPreflight.cwd,
      // agent 可能再派生实际 runtime/MCP 子进程。POSIX 下让 wrapper 进入独立进程组，
      // 关闭时才能按进程树整体回收；Windows 保持非 detached，交给 taskkill /T 处理。
      detached: shouldSpawnInDetachedProcessGroup(),
      env: {
        ...sanitizeZCodeRuntimeEnv(process.env),
        [ZCODE_RUNTIME_ENV_KEY]: runtimeEnv,
        ...spawnEnv,
        ...effectiveCommand.env,
        // 生成文件根目录由执行端 Host 唯一决定，保证 Agent 写入与 Host 读取授权一致。
        [GEN_UI_OUTPUT_ROOT_ENV]: join(getAppConfigDir(), GEN_UI_OUTPUT_DIRECTORY),
        // 身份/隔离语义使用 workspaceIdentity；cwd 继续使用 workspacePath。
        ...buildAgentWorkspaceIdentityEnv(params.workspaceIdentity),
        ...buildE2EAgentCoverageEnv(),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const startedAt = Date.now();
    const stderrTail = createAgentStderrTail();
    const transport = new ZCodeStdioTransport(child, {
      onStderrLine: (line) => {
        const diagnostic = parseZCodeProcessDiagnostic(line);
        if (diagnostic && typeof child.pid === "number") {
          // 根因：只保存 exit tail 会漏掉存活 runtime 的异常；此旁路不依赖 debug 开关。
          // 身份绑定创建时的 child，不能查当前 workspace，避免重启后的迟到事件串进程。
          this.reportProcessLifecycle((reporter) =>
            reporter.onException?.({
              pid: child.pid!,
              provider: ZCODE_AGENT_PROVIDER,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: params.workspacePath,
              runtimeGeneration,
              runtimeInstanceId,
              diagnostic: {
                ...diagnostic,
                // 脱敏占位符可能比原文长，必须再次限长，避免 IPC schema 拒绝合法异常。
                name: redactAgentDiagnostic(diagnostic.name).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS,
                ),
                message: redactAgentDiagnostic(diagnostic.message).slice(
                  0,
                  ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS,
                ),
                ...(diagnostic.stack !== undefined
                  ? {
                      stack: redactAgentDiagnostic(diagnostic.stack).slice(
                        0,
                        ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS,
                      ),
                    }
                  : {}),
              },
            }),
          );
          return;
        }
        stderrTail.append(line);
        debugLog(line);
      },
      ownedProcessStartedAtMs: spawnRequestedAt,
      // POSIX 下 child 由本 manager 以 detached=true 启动，pid 同时就是 Host
      // 拥有的独立 PGID；异常 root exit 后 cleanup 仍可按组回收同组后代。
      ...(process.platform !== "win32" && child.pid ? { ownedProcessGroupId: child.pid } : {}),
    });
    const client = new ZCodeProtocolClient(transport, {
      requireStorageStartup: effectiveCommand.supportsStorageStartup,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    if (child.pid) {
      const unregisterNetworkCapture = localRuntimeNetworkCapture.register(client, child.pid);
      child.once("close", unregisterNetworkCapture);
    }
    // Agent 进程重启后，Host 仍需要 runtime identity 区分新旧订阅和运行命令。
    // Provider Registry 由新 Worker 从所属 Environment 的 Config 重建，不再由 UI 重新下发。
    const runtimeGeneration = (this.runtimeGenerationByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
    this.runtimeGenerationByWorkspaceKey.set(workspaceKey, runtimeGeneration);
    // 生命周期事件关联只需要本次 runtime 的不透明身份，不能复用包含 workspaceKey 的协议 identity。
    const runtimeInstanceId = `agent-${randomUUID()}`;
    const runtimeIdentity: ZCodeAgentRuntimeIdentity = {
      generation: runtimeGeneration,
      identity: this.lane
        ? `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}:${this.lane}`
        : `${workspaceKey}:${runtimeGeneration}:${child.pid ?? "unknown"}`,
      ...(typeof child.pid === "number" ? { processId: child.pid } : {}),
      ...(this.lane ? { lane: this.lane } : {}),
      workspaceKey,
    };
    const exitDiagnostics = Promise.withResolvers<void>();
    const managed: ManagedZCodeAgentProcess = {
      child,
      client,
      exited: false,
      exitDiagnosticsCompleted: exitDiagnostics.promise,
      readyReported: false,
      runtimeIdentity,
      runtimeInstanceId,
      spawned: false,
      startedAt,
      workspace: {
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      },
    };
    this.processesByWorkspaceKey.set(workspaceKey, managed);
    this.ownedProcesses.add(managed);
    const publishStorage = () => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) return;
      if (client.storageStartup.isWaiting) this.clearIdleTimer(managed);
      else if (
        client.storageStartup.snapshot?.phase === "ready" &&
        client.pendingOperationRequestCount === 0
      ) {
        this.scheduleIdleReclaim(workspaceKey, managed);
      }
      this.storageStartupEmitter.fire({
        workspaceKey,
        snapshot: { generation: runtimeGeneration, state: client.storageStartup.snapshot ?? null },
      });
    };
    client.storageStartup.onDidChange(publishStorage);
    publishStorage();
    if (this.idleTimeoutMs) {
      client.onPendingRequestsDrained(() => this.scheduleIdleReclaim(workspaceKey, managed));
    }
    child.once("spawn", () => {
      managed.spawned = true;
      // Node spawn() 会先返回 ChildProcess，再异步报告 cwd/command ENOENT。
      // 旧代码在确认 spawn 成功前就发布 runtimeRestarted，订阅方随即重连并再次触发
      // 启动，最终形成失败启动 -> 假重启 -> 重连的自激风暴。只有 spawn 事件才表示
      // 新 CLI 运行时真实存在，可以安全通知 v4 订阅方重订。
      if (runtimeGeneration > 1 && this.processesByWorkspaceKey.get(workspaceKey) === managed) {
        this.runtimeRestartedEmitter.fire({ workspaceKey, runtimeIdentity });
      }
      if (this.processesByWorkspaceKey.get(workspaceKey) === managed) {
        this.availableRuntimeIdentityByWorkspaceKey.set(workspaceKey, runtimeIdentity.identity);
        this.runtimeLifecycleEmitter.fire({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          workspaceKey,
          runtimeIdentity,
          state: "available",
        });
      }
      if (typeof child.pid === "number") {
        this.reportProcessLifecycle((reporter) =>
          reporter.onSpawn({
            pid: child.pid!,
            provider: ZCODE_AGENT_PROVIDER,
            ...(this.lane ? { lane: this.lane } : {}),
            workspacePath: params.workspacePath,
            command: effectiveCommand.command,
            args: effectiveCommand.args ?? [],
            startedAt,
            runtimeGeneration,
            runtimeInstanceId,
          }),
        );
      }
      this.reportRuntimeReady(managed);
      log("ZCode agent process started", {
        workspaceKey,
        command: effectiveCommand.command,
        cwd: spawnPreflight.cwd,
        pid: child.pid,
        durationMs: Date.now() - startStartedAt,
      });
    });
    child.once("error", (error) => {
      errorLog(
        `ZCode agent process error${this.processLifecycleReporter?.onError ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
        {
          workspaceKey,
          pid: child.pid,
          runtimeIdentity: runtimeIdentity.identity,
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
          spawnPreflight,
        },
      );
      const errno = error as NodeJS.ErrnoException;
      this.reportProcessLifecycle((reporter) =>
        reporter.onError?.({
          pid: typeof child.pid === "number" ? child.pid : null,
          provider: ZCODE_AGENT_PROVIDER,
          ...(this.lane ? { lane: this.lane } : {}),
          workspacePath: params.workspacePath,
          command: effectiveCommand.command,
          args: effectiveCommand.args ?? [],
          errorName: error.name || "Error",
          ...(typeof errno.code === "string" ? { errorCode: errno.code } : {}),
          errorMessage: error.message,
          ...(error.stack ? { errorStack: error.stack } : {}),
          runtimeGeneration,
          runtimeInstanceId,
          occurredAt: Date.now(),
        }),
      );
      if (child.pid == null) {
        exitDiagnostics.resolve();
        this.ownedProcesses.delete(managed);
      }
    });
    child.once("exit", async (code, signal) => {
      try {
        managed.exited = true;
        this.clearIdleTimer(managed);
        const endedAt = Date.now();
        const terminationKind = managed.terminationIntent?.kind ?? "unexpected";
        // 协议解析/stream 故障会先触发 protocol-close，再由 Host 用 SIGTERM
        // 回收仍存活的进程。若只透传主动 termination intent，desktop 只能看到最终信号，
        // 无法区分协议故障与受控退出；保留首次 cleanup 原因作为结构化根因。
        const terminationReason = managed.terminationIntent?.reason ?? managed.firstCleanupReason;
        // 协议已立即失效，但 exit 先于 stderr EOF；保留旧 runtime 闭包身份收齐最后诊断。
        await transport.waitForStderrDrain();
        const stderr = stderrTail.snapshot();
        const exitContext = {
          workspaceKey,
          pid: child.pid,
          runtimeIdentity: runtimeIdentity.identity,
          code,
          signal,
          terminationKind,
          terminationReason,
        };
        // 之前日志只有新的 "process started"，缺少旧 pid 的退出轨迹。
        // agent native crash 后 UI 只会看到 protocol close/Session is not active，无法判断是崩溃还是主动重启。
        log("ZCode agent process exited", exitContext);
        if (terminationKind === "unexpected") {
          // Agent 顶层异常只写 stderr 并以非零 code 退出；stderr 过去仅走开发态
          // debug，生产日志只剩 code=1，无法还原异常。不能只按非零 code 判断：signal crash
          // 和长期运行的 Agent 自行 exit 0 同样是非预期退出。
          // 已有独立生命周期事件，显式标记包装日志，避免 Electron 将其再计为 JS 异常。
          errorLog(
            `ZCode agent process exited unexpectedly${this.processLifecycleReporter ? ` ${ZCODE_AGENT_LIFECYCLE_LOG_MARKER}` : ""}`,
            {
              ...exitContext,
              stderr,
            },
          );
        }
        if (typeof child.pid === "number") {
          this.reportProcessLifecycle((reporter) =>
            reporter.onExit({
              pid: child.pid!,
              provider: ZCODE_AGENT_PROVIDER,
              ...(this.lane ? { lane: this.lane } : {}),
              workspacePath: params.workspacePath,
              exitCode: code,
              signal,
              endedAt,
              terminationKind,
              runtimeReady: managed.readyAt != null,
              ...(terminationReason ? { terminationReason } : {}),
              runtimeGeneration,
              runtimeInstanceId,
              uptimeMs: Math.max(0, endedAt - startedAt),
              stderrLineCount: stderr.lineCount,
              ...(terminationKind === "unexpected" && stderr.tail.length > 0
                ? { stderrTail: stderr.tail }
                : {}),
            }),
          );
        }
      } finally {
        exitDiagnostics.resolve();
      }
    });
    client.onRequestTimeout((event) => {
      if (this.processesByWorkspaceKey.get(workspaceKey) !== managed) {
        return;
      }
      if (event.method === "workspace/cancelGenerateText") {
        warnLog(
          "ZCode agent cancel notification timed out; keeping client (best-effort control plane)",
          {
            workspaceKey,
            method: event.method,
            requestId: event.requestId,
            timeoutMs: event.timeoutMs,
            pid: child.pid,
          },
        );
        return;
      }
      warnLog("ZCode agent request timed out; disposing stale protocol client", {
        workspaceKey,
        method: event.method,
        requestId: event.requestId,
        timeoutMs: event.timeoutMs,
        pid: child.pid,
      });
      this.processesByWorkspaceKey.delete(workspaceKey);
      this.reportRuntimeUnavailable(managed);
      // timeout 说明协议请求/响应链路已经不可信。旧实现只 reject 当前请求，
      // 但 child 仍未 exit，后续同 workspace 会继续复用坏 client 并反复超时。
      // 这里主动回收进程树，让下一次 getClient 重新拉起干净的 app-server。
      void this.cleanupManagedProcessWithRetry(
        managed,
        "request-timeout",
        "request-timeout",
        "request timeout",
      ).catch(() => undefined);
    });
    client.onClose(() => {
      const wasActiveClient = this.processesByWorkspaceKey.get(workspaceKey) === managed;
      log("ZCode agent protocol client closed", {
        workspaceKey,
        pid: child.pid,
        runtimeIdentity: runtimeIdentity.identity,
        wasActiveClient,
      });
      if (wasActiveClient) {
        this.processesByWorkspaceKey.delete(workspaceKey);
      }
      this.reportRuntimeUnavailable(managed);
      if (this.ownedProcesses.has(managed)) {
        // 根 child 的 exit 不等于同组 MCP 后代已退出。即使 protocol close
        // 来自根进程退出，也必须按原进程组完成幂等回收后才能释放 Host 所有权。
        void this.cleanupManagedProcessWithRetry(
          managed,
          "protocol-close",
          "protocol-close",
          "protocol close",
        ).catch(() => undefined);
      }
    });
    return client;
  }
}
