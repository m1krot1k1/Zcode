// 稳定性上报的公开入口：桌面主进程只从这里取用，内部按职责拆分到同目录模块。
// 拆分过程中保持导出名称、事件顺序与定时器语义不变。
export { STABILITY_ANR_THRESHOLD_MS, STABILITY_FREEZE_THRESHOLD_MS } from "./constants.js";

export {
  configureDesktopStabilityTelemetry,
  getStabilityLifecycleScene,
  notifyStabilityAppExit,
  notifyStabilityLifecycle,
} from "./eventReporter.js";

export {
  reportAgentProcessExceptionToArms,
  reportAgentProcessExitToArms,
  reportAgentProcessReadyToArms,
  reportAgentProcessSpawnErrorToArms,
  reportAgentProcessStartToArms,
} from "./agentProcessReports.js";

export {
  classifyRenderProcessCrash,
  mapChildProcessGoneToProcessRole,
  shouldReportAnr,
  shouldReportChildProcessGoneAsCrash,
  shouldReportFreeze,
} from "./crashClassification.js";

export { registerStabilityMainWindow } from "./windowStability.js";

export { reportPerfAppStart, scheduleReportPerfAppStartAfterMainViewReady } from "./appStart.js";

export { registerDesktopStabilityMonitors } from "./crashMonitors.js";
