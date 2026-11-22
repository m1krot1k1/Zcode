import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import type { CrashCapturePaths } from "../desktopCrashCapture.js";
import { registerCrashEventMonitor as registerBaseCrashEventMonitor } from "../desktopCrashCapture.js";
import {
  classifyRenderProcessCrash,
  mapChildProcessGoneToProcessRoleWithName,
  mapExitReasonToCrashCause,
  mapExitReasonToCrashKind,
  shouldReportChildProcessGoneAsCrash,
} from "./crashClassification.js";
import { reportStabilityCustom } from "./eventReporter.js";
import type {
  RenderProcessGoneInput,
  StabilityCrashClassification,
  StabilityLogger,
} from "./types.js";
import {
  attachWebContentsStabilityWatch,
  markWebContentsCrash,
  resolveRegisteredWindowScene,
  resolveWindowScene,
} from "./windowStability.js";

function reportPerfCrash(
  classification: StabilityCrashClassification,
  logger: StabilityLogger,
  properties: Record<string, string | number | boolean | undefined>,
  win?: BrowserWindow | null,
): void {
  const crashProperties = {
    crash_id: randomUUID(),
    crash_kind: classification.crashKind,
    crash_scope: classification.crashScope,
    crash_cause: classification.crashCause,
    crash_source: "electron_callback",
    ...properties,
  };
  // Bugfix: 旧实现按 crash_kind 做五分钟去重，会吞掉同类但不同进程的真实事故。
  // Electron 的 gone 回调本身就是单次事故边界，这里每个回调只上报一次。
  reportStabilityCustom("perf_crash", crashProperties, resolveWindowScene(win));
  logger.error("[stability] perf_crash reported", crashProperties);
}

function reportPerfProcessExit(
  logger: StabilityLogger,
  properties: Record<string, string | number | boolean | undefined>,
  win?: BrowserWindow | null,
): void {
  reportStabilityCustom("perf_process_exit", properties, resolveWindowScene(win));
  // Bug 原因：perf_process_exit 同时承载受控退出和可恢复的 helper 异常退出。
  // 旧实现统一使用 error，导致正常生命周期被 ARMS console collector 误计为异常。
  const logLevel = properties.exit_kind === "normal" ? "info" : "warn";
  logger[logLevel]("[stability] perf_process_exit reported", properties);
}

export function registerDesktopStabilityMonitors(
  logger: StabilityLogger,
  crashPaths: CrashCapturePaths,
): void {
  registerBaseCrashEventMonitor(logger, crashPaths, {
    onRenderProcessGone: (webContents, details) => {
      markWebContentsCrash(webContents.id);
      const win = BrowserWindow.fromWebContents(webContents);
      const input: RenderProcessGoneInput = {
        reason: details.reason,
        exitCode: details.exitCode,
        webContentsType: webContents.getType(),
        // 必须使用崩溃 WebContents 自身所属窗口；回退到当前焦点窗会把辅助窗误判成主业务窗。
        windowScene: resolveRegisteredWindowScene(win),
      };
      const classification = classifyRenderProcessCrash(input);
      if (classification) {
        reportPerfCrash(
          classification,
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: "renderer",
            web_contents_type: webContents.getType(),
            web_contents_id: webContents.id,
            window_id: win?.id,
          },
          win,
        );
      } else {
        reportPerfProcessExit(
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: "renderer",
            exit_kind: "normal",
            web_contents_id: webContents.id,
          },
          win,
        );
      }
    },
    onChildProcessGone: (details) => {
      // 修复原因：Electron 将 utilityProcess.fork() 的自定义标识放在 serviceName，
      // name 只表示 Chromium Utility 服务名（如 Network Service）。只读 name 会把
      // Host 归为 utility，导致 Host 异常退出走 recoverable_child_crash 而不是 perf_crash。
      const processName = details.serviceName?.trim() || details.name?.trim() || "";
      const role = mapChildProcessGoneToProcessRoleWithName(details.type, processName);
      if (details.reason === "killed" || details.reason === "clean-exit") {
        reportPerfProcessExit(logger, {
          exit_code: details.exitCode,
          exit_reason: details.reason,
          process_role: role,
          exit_kind: "normal",
          process_type: details.type,
          process_name: processName,
        });
      } else if (!shouldReportChildProcessGoneAsCrash({ ...details, name: processName })) {
        reportPerfProcessExit(logger, {
          exit_code: details.exitCode,
          exit_reason: details.reason,
          process_role: role,
          exit_kind: "recoverable_child_crash",
          process_type: details.type,
          process_name: processName,
        });
      } else {
        reportPerfCrash(
          {
            crashKind: mapExitReasonToCrashKind(details.reason),
            crashScope: role === "host" ? "host" : "child",
            crashCause: mapExitReasonToCrashCause(details.reason),
          },
          logger,
          {
            exit_code: details.exitCode,
            exit_reason: details.reason,
            process_role: role,
            process_type: details.type,
            process_name: processName,
          },
        );
      }
    },
    onBrowserWindowCreated: (win) => {
      attachWebContentsStabilityWatch(win, win.webContents, logger);
    },
  });
}
