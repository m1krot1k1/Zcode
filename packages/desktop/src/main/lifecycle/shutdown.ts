import { app, BrowserWindow, dialog, nativeImage } from "electron";
import { ZCODE_ENV, type Locale } from "@zcode/shared";
import { logger } from "../logger.js";
import { resolveBundledGlmBinaryPath } from "../desktopRuntimeEnv.js";
import { listRegisteredHostAgentProcessIds } from "../resourceManagerWindow.js";
import {
  findWindowsProcessesReferencingResourceMarkers,
  probeWindowsPackagedResourceWritable,
  resolveWindowsPackagedResourceLockMarkers,
  runWindowsUpdateProcessCleanup,
  snapshotWindowsPackagedResources,
  WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
} from "../windowsInstallResourceLocks.js";

const WINDOWS_AGENT_FORCE_KILL_TIMEOUT_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(ms, 0));
    timer.unref?.();
  });
}

async function execWithTimeout(
  file: string,
  args: string[],
  timeoutMs: number,
  spawnOptions: { windowsHide?: boolean; encoding?: BufferEncoding } = {},
): Promise<{
  timedOut: boolean;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
}> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = execFile(file, args, {
      windowsHide: spawnOptions.windowsHide,
      encoding: spawnOptions.encoding,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        // 进程可能已自行退出，忽略
      }
    }, timeoutMs);
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, code, signal });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, error: error.message });
    });
  });
}

async function forceTerminateWindowsAgentProcesses(pids: number[]): Promise<
  Array<{
    pid: number;
    timedOut: boolean;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: string;
  }>
> {
  const uniquePids = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  return Promise.all(
    uniquePids.map((pid) =>
      execWithTimeout(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        WINDOWS_AGENT_FORCE_KILL_TIMEOUT_MS,
        {
          windowsHide: true,
        },
      ).then((result) => ({ pid, ...result })),
    ),
  );
}

function logWindowsPackagedResourceSnapshot(stage: string) {
  logger.info(
    `[auto-update] Windows packaged resources snapshot (${stage}): ${JSON.stringify(
      snapshotWindowsPackagedResources(process.resourcesPath),
    )}`,
  );
}

function logWindowsPackagedResourceWritableProbe(stage: string) {
  const probes = probeWindowsPackagedResourceWritable(process.resourcesPath);
  const failed = probes.filter((probe) => probe.exists && !probe.writable);
  logger.info(
    `[auto-update] Windows packaged resources writable probe (${stage}): ${JSON.stringify(probes)}`,
  );
  if (failed.length > 0) {
    logger.warn(
      `[auto-update] Windows packaged resource dirs are not writable (${stage}): ${JSON.stringify(
        failed,
      )}`,
    );
  }
}

export function logWindowsBundledRuntimeIntegrityDiagnostic(): void {
  if (process.platform !== "win32" || !app.isPackaged) {
    return;
  }

  const binaryPaths = {
    glm: resolveBundledGlmBinaryPath(),
  };
  const missingProviders = Object.entries(binaryPaths)
    .filter(([, binaryPath]) => !binaryPath)
    .map(([provider]) => provider);
  if (missingProviders.length === 0) {
    return;
  }

  // bundled runtime 缺失不一定影响用户当前 provider，启动阶段只静默落日志。
  // 这样既能在下次用户日志里确认安装资源是否已损坏，也不会因为未使用的 provider 缺失打断启动。
  logger.warn(
    `[startup] Windows bundled runtime missing providers: ${missingProviders.join(", ")} resources=${JSON.stringify(
      snapshotWindowsPackagedResources(process.resourcesPath),
    )}`,
  );
}

export async function prepareWindowsProcessesForUpdateInstall(): Promise<void> {
  const trackedAgentCount = listRegisteredHostAgentProcessIds().length;

  logger.info(`[auto-update] preparing Windows update install: trackedAgent=${trackedAgentCount}`);
  logWindowsPackagedResourceSnapshot("before-dispose");

  const resourceLockMarkers = resolveWindowsPackagedResourceLockMarkers(process.resourcesPath);
  // prepareAppQuit 已经用同一屏障回收每窗口唯一 Host，并在 7.5 秒强杀、
  // 9 秒收口；Windows 专项阶段不能再追加一轮等待，也不能用退出前记录的 Host/Agent PID
  // 强杀，因为 PID 可能已经复用。这里只清理实时扫描仍引用随包资源的 runtime 进程，
  // 当前 main/renderer 的最终退出交给 updater 与 NSIS。
  const cleanup = await runWindowsUpdateProcessCleanup({
    resourceLockMarkers,
    lockReleaseGraceMs: WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS,
    scan: findWindowsProcessesReferencingResourceMarkers,
    terminate: forceTerminateWindowsAgentProcesses,
    delay,
  });

  logger.info(
    `[auto-update] Windows resource lock scan: matches=${cleanup.initialLockProcesses.length} trackedAgent=${trackedAgentCount} details=${JSON.stringify(
      cleanup.initialLockProcesses,
    )}`,
  );
  for (const error of cleanup.errors) {
    logger.warn(`[auto-update] Windows process cleanup degraded: ${error}`);
  }

  if (cleanup.terminationPids.length === 0) {
    logWindowsPackagedResourceWritableProbe("no-lock-processes");
    return;
  }

  // 少量 Windows 用户更新后安装目录里的 bundled agent 文件会缺失。
  // 根因通常是 NSIS 覆盖 resources/glm 等目录时，旧 agent/helper 进程或杀软触发的残留进程仍持有句柄；
  // 只杀 host 上报过的 agent pid 会漏掉未登记或已经脱离登记的后代。这里在更新前按命令行再扫描一次安装资源路径，
  // 对仍引用随包资源的进程树做强制清理，降低半更新导致环境损坏的概率。
  logger.info(
    `[auto-update] Windows taskkill results: ${JSON.stringify(cleanup.terminationResults)}`,
  );
  logger.info(
    `[auto-update] Windows resource lock release grace elapsed: ${WINDOWS_UPDATE_LOCK_RELEASE_GRACE_MS}ms`,
  );

  if (cleanup.remainingLockProcesses.length > 0) {
    logger.warn(
      `[auto-update] Windows resource lock processes still alive after taskkill: ${JSON.stringify(
        cleanup.remainingLockProcesses,
      )}`,
    );
  }
  logWindowsPackagedResourceWritableProbe("after-taskkill");
}

export interface ShutdownSupportOptions {
  iconPath: string;
  getApplicationLocale: () => Locale;
  getApplicationWindows: () => BrowserWindow[];
  getRunningAgentSessionCount: () => number;
}

export interface ShutdownSupport {
  shouldConfirmAppQuit: () => boolean;
  confirmAppQuit: (originWindow?: BrowserWindow | null) => boolean;
}

export function createShutdownSupport(options: ShutdownSupportOptions): ShutdownSupport {
  function shouldConfirmAppQuit() {
    // 开发环境里的普通会话经常需要重启 Electron，只在 production 下拦截，避免打断调试。
    return ZCODE_ENV === "production" && options.getRunningAgentSessionCount() > 0;
  }

  function confirmAppQuit(originWindow?: BrowserWindow | null) {
    if (!shouldConfirmAppQuit()) {
      logger.info(`[app-quit] quit confirmation skipped in ${ZCODE_ENV}`);
      return true;
    }

    const isZh = options.getApplicationLocale() === "zh-CN";
    const runningAgentSessionCount = options.getRunningAgentSessionCount();
    const detailLines = [
      runningAgentSessionCount > 0
        ? isZh
          ? `正在进行的会话：${runningAgentSessionCount} 个，退出后会被中断。`
          : `In-progress sessions: ${runningAgentSessionCount}. They will be interrupted after quitting.`
        : null,
    ].filter((line): line is string => line !== null);
    const targetWindow =
      originWindow && !originWindow.isDestroyed()
        ? originWindow
        : (BrowserWindow.getFocusedWindow() ?? options.getApplicationWindows()[0] ?? null);
    const dialogOptions = {
      type: "question" as const,
      buttons: isZh ? ["退出", "取消"] : ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: isZh ? "退出确认" : "Confirm Quit",
      message: isZh ? "确认退出 Z Code?" : "Quit Z Code?",
      detail: detailLines.join("\n"),
      icon: nativeImage.createFromPath(options.iconPath),
    };

    const result = targetWindow
      ? dialog.showMessageBoxSync(targetWindow, dialogOptions)
      : dialog.showMessageBoxSync(dialogOptions);
    return result === 0;
  }

  return { shouldConfirmAppQuit, confirmAppQuit };
}
