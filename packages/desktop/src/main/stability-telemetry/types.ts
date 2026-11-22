export type StabilityLifecycleScene = "cold_start" | "runtime" | "app_quit" | "update_install";

export type StabilityWindowScene = "main" | "process_monitor" | "other";

export type StabilityCrashKind = "native" | "js" | "oom";

export type StabilityCrashScope =
  | "app_native_process"
  | "main_window_renderer"
  | "auxiliary_window_renderer"
  | "embedded_webview"
  | "host"
  | "child";

export type StabilityCrashCause =
  | "oom"
  | "process_crashed"
  | "abnormal_exit"
  | "launch_failed"
  | "integrity_failure"
  | "native_crash"
  | "unknown";

export interface StabilityCrashClassification {
  crashKind: StabilityCrashKind;
  crashScope: StabilityCrashScope;
  crashCause: StabilityCrashCause;
}

export type StabilityProcessRole =
  | "main"
  | "renderer"
  | "gpu"
  | "utility"
  | "agent"
  | "host"
  | "child"
  | "unknown";

export type AgentCrashPhase = "startup" | "runtime" | "unknown";
export type AgentTerminationClass = "exit_zero" | "exit_nonzero" | "signal" | "unknown";
export type AgentDiagnosticClass = "oom" | "sqlite" | "errno" | "generic" | "none";

export interface AgentCrashDiagnostic {
  errorName: string;
  errorCode: string;
  errorMessage: string;
  errorStack: string;
  errorFingerprint: string;
  diagnosticClass: AgentDiagnosticClass;
}

export interface StabilityLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface UnresponsiveWatchState {
  windowId: number;
  webContentsId: number;
  windowScene: StabilityWindowScene;
  startedAt: number;
  anrReported: boolean;
  freezeReported: boolean;
  crashReported: boolean;
  pollTimer: ReturnType<typeof setTimeout> | null;
}

export interface RenderProcessGoneInput {
  reason: string;
  exitCode: number;
  webContentsType: string;
  windowScene?: StabilityWindowScene;
}

export interface ChildProcessGoneInput {
  type: string;
  reason: string;
  exitCode: number;
  serviceName?: string;
  name: string;
}
