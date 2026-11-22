import { STABILITY_ANR_THRESHOLD_MS, STABILITY_FREEZE_THRESHOLD_MS } from "./constants.js";
import type {
  ChildProcessGoneInput,
  RenderProcessGoneInput,
  StabilityCrashCause,
  StabilityCrashClassification,
  StabilityCrashKind,
  StabilityProcessRole,
} from "./types.js";

export function mapExitReasonToCrashKind(reason: string): StabilityCrashKind {
  // Electron 的 renderer/child gone 回调共用这组退出原因，OOM 不能因进程来源不同而被归为 native。
  return reason === "oom" || reason === "memory-eviction" ? "oom" : "native";
}

export function mapExitReasonToCrashCause(reason: string): StabilityCrashCause {
  switch (reason) {
    case "oom":
    // Electron 41 将 Chromium 的内存压力驱逐单独命名；它与 oom 一样表示进程因内存
    // 压力退出，不能落入 native/unknown，否则 OOM 指标会被低估。
    case "memory-eviction":
      return "oom";
    case "crashed":
      return "process_crashed";
    case "abnormal":
    case "abnormal-exit":
      return "abnormal_exit";
    case "launch-failed":
      return "launch_failed";
    case "integrity-failure":
      return "integrity_failure";
    default:
      return "unknown";
  }
}

export function classifyRenderProcessCrash(
  input: RenderProcessGoneInput,
): StabilityCrashClassification | null {
  if (input.reason === "killed" || input.reason === "clean-exit") {
    return null;
  }
  return {
    crashKind: mapExitReasonToCrashKind(input.reason),
    crashScope:
      input.webContentsType === "webview"
        ? "embedded_webview"
        : input.windowScene === undefined || input.windowScene === "main"
          ? "main_window_renderer"
          : "auxiliary_window_renderer",
    crashCause: mapExitReasonToCrashCause(input.reason),
  };
}

export function mapChildProcessGoneToProcessRole(
  type: string,
  processName?: string,
): StabilityProcessRole {
  return mapChildProcessGoneToProcessRoleWithName(type, processName);
}

export function mapChildProcessGoneToProcessRoleWithName(
  type: string,
  processName?: string,
): StabilityProcessRole {
  if (processName?.startsWith("zcode-host")) {
    return "host";
  }
  if (processName?.startsWith("zcode-agent")) {
    return "agent";
  }
  switch (type) {
    case "GPU":
      return "gpu";
    case "Utility":
      return "utility";
    default:
      return "child";
  }
}

export function shouldReportChildProcessGoneAsCrash(input: ChildProcessGoneInput): boolean {
  if (input.reason === "killed" || input.reason === "clean-exit") {
    return false;
  }

  const role = mapChildProcessGoneToProcessRoleWithName(input.type, input.name);
  if (role === "gpu") {
    return false;
  }

  // Bugfix: RUM 里 Video Capture / Network Service / Audio Service 等 Chromium Utility
  // 子进程会被系统自动重建，不会让 ZCode 主窗口或会话不可用；它们只能作为可恢复退出记录，
  // 不能进入 perf_crash，否则会把 crash-free 指标按“非真实崩溃”拉低。
  if (role === "utility") {
    return false;
  }

  return true;
}

export function shouldReportAnr(elapsedMs: number, anrReported: boolean): boolean {
  return !anrReported && elapsedMs >= STABILITY_ANR_THRESHOLD_MS;
}

export function shouldReportFreeze(
  elapsedMs: number,
  freezeReported: boolean,
  crashReported: boolean,
): boolean {
  return !freezeReported && !crashReported && elapsedMs >= STABILITY_FREEZE_THRESHOLD_MS;
}
