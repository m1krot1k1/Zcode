import armsRum from "@arms/rum-electron";
import type {
  HostAgentProcessErrorResponse,
  HostAgentProcessExceptionResponse,
  HostAgentProcessExitedResponse,
  HostAgentProcessReadyResponse,
  HostAgentProcessSpawnedResponse,
} from "@zcode/shared";
import {
  classifyAgentCrashPhase,
  classifyAgentTermination,
  createAgentCrashFingerprint,
  parseAgentSpawnDiagnostic,
  parseAgentStderrDiagnostic,
  sanitizeAgentCrashDetail,
} from "./agentDiagnostics.js";
import {
  AGENT_EXCEPTION_DEDUP_CAPACITY,
  WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE,
} from "./constants.js";
import {
  getStabilityGlobalContext,
  getStabilityLifecycleScene,
  normalizeOsCategory,
  reportStabilityCustom,
  stringifyProperties,
} from "./eventReporter.js";
import type { StabilityLogger } from "./types.js";

const reportedAgentExceptions = new Set<string>();

export function reportAgentProcessExceptionToArms(
  event: HostAgentProcessExceptionResponse,
  logger: StabilityLogger,
): void {
  const globalContext = getStabilityGlobalContext();
  if (!globalContext) return;
  const key = `${event.runtimeInstanceId}:${event.diagnostic.errorId}`;
  if (reportedAgentExceptions.has(key)) return;
  const diagnostic = event.diagnostic;
  const name = sanitizeAgentCrashDetail(diagnostic.name, event.workspacePath);
  const message = sanitizeAgentCrashDetail(diagnostic.message, event.workspacePath);
  const stack =
    diagnostic.stack === undefined
      ? undefined
      : sanitizeAgentCrashDetail(diagnostic.stack, event.workspacePath);
  try {
    // 根因：Electron collector 只监听自身进程，CLI 异常必须携带原始栈显式发送，
    // 不能先转成 console.error 包装字符串，也不能等待进程退出后再上报。
    armsRum.sendEvent({
      event_type: "exception",
      type: "error",
      source: diagnostic.kind,
      name,
      message,
      ...(stack === undefined ? {} : { stack }),
      timestamp: diagnostic.occurredAt,
      properties: stringifyProperties({
        process_role: "agent",
        process_error_kind: diagnostic.kind,
        process_error_origin: diagnostic.origin,
        error_id: diagnostic.errorId,
        runtime_instance_id: event.runtimeInstanceId,
        runtime_generation: event.runtimeGeneration,
        provider: event.provider,
        lane: event.lane,
        error_fingerprint: createAgentCrashFingerprint([
          name,
          message,
          stack?.split(/\r?\n/).find((line) => line.trim().startsWith("at ")) ?? "",
        ]),
        app_version: globalContext.appVersion,
        arms_env: globalContext.armsEnv,
        device_mid: globalContext.deviceMid,
        platform: normalizeOsCategory(globalContext.platform),
      }),
    });
    reportedAgentExceptions.add(key);
    if (reportedAgentExceptions.size > AGENT_EXCEPTION_DEDUP_CAPACITY) {
      reportedAgentExceptions.delete(reportedAgentExceptions.values().next().value!);
    }
  } catch (error) {
    // SDK 失败不能影响 Host 消息处理；未成功提交的事件不进入去重集合。
    logger.warn("[stability] Agent exception report failed", error);
  }
}

export function reportAgentProcessStartToArms(
  event: HostAgentProcessSpawnedResponse,
  logger: StabilityLogger,
): void {
  reportStabilityCustom("perf_agent_start", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
  });
  logger.info("[stability] perf_agent_start reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    runtimeInstanceId: event.runtimeInstanceId,
  });
}

export function reportAgentProcessReadyToArms(
  event: HostAgentProcessReadyResponse,
  logger: StabilityLogger,
): void {
  reportStabilityCustom("perf_agent_ready", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    startup_duration_ms: event.startupDurationMs,
  });
  logger.info("[stability] perf_agent_ready reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    runtimeInstanceId: event.runtimeInstanceId,
    startupDurationMs: event.startupDurationMs,
  });
}

export function reportAgentProcessExitToArms(
  event: HostAgentProcessExitedResponse,
  logger: StabilityLogger,
): void {
  if (event.terminationKind !== "unexpected") {
    return;
  }
  const isProtocolFailure = event.terminationReason === "protocol-close";
  if (
    !isProtocolFailure &&
    (event.exitCode === WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE || event.signal === "SIGTERM")
  ) {
    // Bug 根因：协议故障会先触发 protocol-close，再由 Host 回收仍存活的进程，
    // 因此最终也可能表现为 SIGTERM / Windows control-c exit code。只有缺少结构化
    // 协议根因时，裸退出签名才不足以证明 Agent 自身崩溃，应继续抑制误报。
    logger.debug?.("[stability] controlled Agent termination suppressed", {
      pid: event.pid,
      runtimeInstanceId: event.runtimeInstanceId,
      exitCode: event.exitCode,
      signal: event.signal,
    });
    return;
  }
  const lifecycleScene = getStabilityLifecycleScene();
  if (lifecycleScene === "app_quit" || lifecycleScene === "update_install") {
    // Bug 根因：Host 清理与 IPC 回传是异步的，perf_app_exit 之后仍可能晚到一个缺失
    // termination intent 的 Agent exit。应用退出是 main 持有的更高层事实，不能计入 runtime crash。
    logger.debug?.("[stability] late Agent exit suppressed during app shutdown", {
      pid: event.pid,
      runtimeInstanceId: event.runtimeInstanceId,
      lifecycleScene,
    });
    return;
  }
  const diagnostic = parseAgentStderrDiagnostic(event);
  reportStabilityCustom("perf_agent_crash", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    incident_kind: "unexpected_exit",
    provider: event.provider,
    exit_code: event.exitCode ?? "",
    signal: event.signal ?? "",
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    uptime_ms: event.uptimeMs,
    stderr_line_count: event.stderrLineCount,
    crash_phase: classifyAgentCrashPhase(event.runtimeReady),
    termination_class: classifyAgentTermination(event),
    termination_reason: event.terminationReason,
    diagnostic_class: diagnostic.diagnosticClass,
    error_name: diagnostic.errorName,
    error_code: diagnostic.errorCode,
    error_message: diagnostic.errorMessage,
    error_stack: diagnostic.errorStack,
    error_fingerprint: diagnostic.errorFingerprint,
  });
  // 上报成功属于观测日志，error 会被 console collector 再生成一条伪 JS 异常。
  logger.info("[stability] perf_agent_crash reported", {
    pid: event.pid,
    exitCode: event.exitCode,
    signal: event.signal,
    runtimeGeneration: event.runtimeGeneration,
    errorName: diagnostic.errorName,
    errorCode: diagnostic.errorCode,
    errorFingerprint: diagnostic.errorFingerprint,
  });
}

export function reportAgentProcessSpawnErrorToArms(
  event: HostAgentProcessErrorResponse,
  logger: StabilityLogger,
): void {
  const diagnostic = parseAgentSpawnDiagnostic(event);
  reportStabilityCustom("perf_agent_spawn_error", {
    process_role: "agent",
    // mcp-status 与 plugin lane 进程共用 cwd/command，只有 lane 能区分事件来源。
    ...(event.lane ? { lane: event.lane } : {}),
    incident_kind: "spawn_error",
    provider: event.provider,
    runtime_generation: event.runtimeGeneration,
    runtime_instance_id: event.runtimeInstanceId,
    diagnostic_class: diagnostic.diagnosticClass,
    error_name: diagnostic.errorName,
    error_code: diagnostic.errorCode,
    error_message: diagnostic.errorMessage,
    error_stack: diagnostic.errorStack,
    error_fingerprint: diagnostic.errorFingerprint,
  });
  logger.info("[stability] perf_agent_spawn_error reported", {
    pid: event.pid,
    runtimeGeneration: event.runtimeGeneration,
    errorName: diagnostic.errorName,
    errorCode: diagnostic.errorCode,
    errorFingerprint: diagnostic.errorFingerprint,
  });
}
