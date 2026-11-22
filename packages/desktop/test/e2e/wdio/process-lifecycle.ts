import { stopRequestSecurityFixture } from "../helpers/request-security-edition/index.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import {
  listE2EProcessTreePids,
  buildWindowsTaskkillArgs,
} from "../helpers/e2e-process-cleanup.js";
import { createE2ERunnerFinalizationGuard } from "../helpers/e2e-runner-finalization-guard.js";
import { stopCodingPlanTeamMock } from "./mocks-coding-plan-team.js";
import { stopCodingPlanUpgradeE2EMock } from "./mocks-coding-plan-upgrade.js";
import {
  stopDynamicWorkflowConfigE2EMock,
  stopModelContextBudgetConfigE2EMock,
  stopPluginCdnZipFixture,
} from "./mocks-config.js";
import { stopUpstreamE2EHttp } from "./mocks-upstream.js";
import {
  E2E_ELECTRON_APP_QUIT_TIMEOUT_MS,
  E2E_ELECTRON_FORCE_KILL_GRACE_MS,
  E2E_HOME_DIR,
  E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS,
  E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS,
} from "./paths.js";
import {
  E2E_CHROMIUM_USER_DATA_ROOT_DIR,
  E2E_RUN_CACHE_DIR,
  E2E_RUN_ID,
  e2eReporter,
} from "./reporters.js";
import { wdioState } from "./state.js";

export const e2eRunnerFinalizationGuard = createE2ERunnerFinalizationGuard({
  onTimeout: forceFinalizeE2ERunnerFromGuard,
  timeoutMs: E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS,
});

export async function armCurrentElectronAppQuit(stage: string) {
  wdioState.currentE2EElectronAppPid = null;
  try {
    const result = (await browser.electron.execute((electron) => {
      const currentAppPid = process.pid;
      const appName = electron.app.getName();
      if (appName !== "ZCode E2E") {
        return {
          appName,
          appPid: currentAppPid,
          armedWindowCount: 0,
        };
      }

      const appWindows = electron.BrowserWindow.getAllWindows();
      let quitRequested = false;
      const requestQuitAfterDriverClose = () => {
        if (quitRequested || electron.BrowserWindow.getAllWindows().length > 0) {
          return;
        }
        quitRequested = true;
        electron.app.quit();
      };

      // 修复原因：after 里直接 app.quit 会让 renderer 先于 ChromeDriver 的
      // deleteSession 消失，ChromeDriver 随后会对失效 browsing context 等待超时。
      // 这里只给当前进程、当前窗口挂一次性监听；由 deleteSession 先关闭窗口，
      // 再走 app.quit 的 before-quit 链路回收 host/agent。没有跨 session 的 timer。
      for (const appWindow of appWindows) {
        appWindow.once("closed", requestQuitAfterDriverClose);
      }
      return {
        appName,
        appPid: currentAppPid,
        armedWindowCount: appWindows.length,
      };
    })) as {
      appName?: string;
      appPid?: number;
      armedWindowCount?: number;
    };

    wdioState.currentE2EElectronAppPid = typeof result.appPid === "number" ? result.appPid : null;
    if (!result.armedWindowCount) {
      writeE2ECleanupWarning(
        `${stage}: skip app quit barrier because current Electron app is ${result.appName ?? "unknown"} or has no windows`,
      );
      return;
    }
  } catch (error) {
    writeE2ECleanupWarning(`${stage}: app quit barrier failed: ${formatErrorMessage(error)}`);
  }
}

export async function cleanupE2EElectronProcesses(
  stage: string,
  {
    requireExit = false,
    waitForGracefulExit = false,
  }: { requireExit?: boolean; waitForGracefulExit?: boolean } = {},
) {
  try {
    // 修复原因：after 已记录当前 Electron 主 PID；常规路径先按已知根进程等待/回收，
    // 避免每个 worker 在高并发下重复启动 PowerShell/CIM 扫描整机进程树。
    // 最后的 runId/HOME 扫描仍是严格屏障，会捕获主进程退出后遗留的 host/agent。
    let targetPids =
      wdioState.currentE2EElectronAppPid !== null &&
      isProcessAlive(wdioState.currentE2EElectronAppPid)
        ? [wdioState.currentE2EElectronAppPid]
        : listCurrentE2EProcessPids();
    if (waitForGracefulExit && targetPids.length > 0) {
      // 修复原因：app.quit 发出时 ChromeDriver 仍持有 session，主进程通常要到
      // deleteSession 后才能退出；afterSession 才是等待自然退出的正确屏障位置。
      await waitForProcessesExit(targetPids, E2E_ELECTRON_APP_QUIT_TIMEOUT_MS);
      targetPids = targetPids.filter((pid) => isProcessAlive(pid));
      if (targetPids.length === 0) {
        targetPids = listCurrentE2EProcessPids();
      }
    }
    if (targetPids.length === 0) {
      return;
    }

    writeE2ECleanupWarning(
      `${stage}: force terminating leftover Electron e2e pids=${targetPids.join(",")}`,
    );
    if (process.platform === "win32") {
      forceTerminateWindowsProcesses(targetPids);
      await waitForProcessesExit(targetPids, E2E_ELECTRON_FORCE_KILL_GRACE_MS);
    } else {
      terminatePosixProcesses(targetPids, "SIGTERM");
      await waitForProcessesExit(targetPids, E2E_ELECTRON_FORCE_KILL_GRACE_MS);
      const remainingAfterTerm = targetPids.filter((pid) => isProcessAlive(pid));
      terminatePosixProcesses(remainingAfterTerm, "SIGKILL");
      await waitForProcessesExit(remainingAfterTerm, E2E_ELECTRON_FORCE_KILL_GRACE_MS);
    }

    const remainingPids = listCurrentE2EProcessPids();
    if (remainingPids.length > 0) {
      throw new Error(`E2E process exit barrier failed, remaining pids=${remainingPids.join(",")}`);
    }
  } catch (error) {
    writeE2ECleanupWarning(
      `${stage}: leftover Electron cleanup failed: ${formatErrorMessage(error)}`,
    );
    if (requireExit) {
      throw error;
    }
  }
}

function listCurrentE2EProcessPids() {
  const detectedPids = listE2EProcessTreePids({
    chromiumProfileRootDir: E2E_CHROMIUM_USER_DATA_ROOT_DIR,
    homeDir: E2E_HOME_DIR,
    runId: E2E_RUN_ID,
  });
  if (
    wdioState.currentE2EElectronAppPid !== null &&
    wdioState.currentE2EElectronAppPid !== process.pid &&
    isProcessAlive(wdioState.currentE2EElectronAppPid)
  ) {
    detectedPids.push(wdioState.currentE2EElectronAppPid);
  }
  return [...new Set(detectedPids)];
}

export async function cleanupE2EDirectory(
  stage: string,
  userDataDir: string,
  requireRemoved = false,
) {
  try {
    await rm(userDataDir, {
      force: true,
      maxRetries: process.platform === "win32" ? 3 : 1,
      recursive: true,
      retryDelay: 300,
    });
    if (existsSync(userDataDir)) {
      throw new Error(`E2E directory still exists: ${userDataDir}`);
    }
  } catch (error) {
    writeE2ECleanupWarning(
      `${stage}: E2E directory cleanup failed (${userDataDir}): ${formatErrorMessage(error)}`,
    );
    if (requireRemoved) {
      throw error;
    }
  }
}

function forceTerminateWindowsProcesses(pids: number[]) {
  if (pids.length === 0) {
    return;
  }
  try {
    // 修复原因：目标集合包含同一 Electron 树的父子 PID；逐 PID 执行 `/T`
    // 会重复递归终止同一棵树，并在多 shard 下放大 taskkill 进程创建开销。
    execFileSync("taskkill", buildWindowsTaskkillArgs(pids), {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    const alivePids = pids.filter((pid) => isProcessAlive(pid));
    if (alivePids.length > 0) {
      writeE2ECleanupWarning(
        `taskkill failed for pids=${alivePids.join(",")}: ${formatErrorMessage(error)}`,
      );
    }
  }
}

function terminatePosixProcesses(pids: number[], signal: NodeJS.Signals) {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (isProcessAliveError(error)) {
        writeE2ECleanupWarning(`${signal} failed for pid=${pid}: ${formatErrorMessage(error)}`);
      }
    }
  }
}

async function waitForProcessesExit(pids: number[], timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return true;
    }
    await delay(100);
  }
  return pids.every((pid) => !isProcessAlive(pid));
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isProcessAliveError(error);
  }
}

function isProcessAliveError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code !== "ESRCH",
  );
}

export function delay(ms: number) {
  return new Promise<void>((resolveDelay) => {
    const timer = setTimeout(resolveDelay, Math.max(ms, 0));
    timer.unref?.();
  });
}

function writeE2ECleanupWarning(message: string) {
  process.stderr.write(`[desktop-e2e-cleanup] ${message}\n`);
}

export function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function armE2ERunnerExitWatchdog(exitCode: number) {
  if (wdioState.e2eRunnerExitWatchdog) {
    clearTimeout(wdioState.e2eRunnerExitWatchdog);
  }

  // 修复原因：Electron 和 replay server 都清理完后，WDIO CLI 仍可能被历史
  // handle 卡住，形成 conversation-session 这类孤儿进程；正常退出不会触发该兜底。
  wdioState.e2eRunnerExitWatchdog = setTimeout(() => {
    writeE2ECleanupWarning(
      `onComplete: forcing WDIO runner exit after ${E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS}ms`,
    );
    process.exit(exitCode);
  }, E2E_RUNNER_FORCE_EXIT_TIMEOUT_MS);
  wdioState.e2eRunnerExitWatchdog.unref?.();
}

function forceFinalizeE2ERunnerFromGuard() {
  writeE2ECleanupWarning(
    `finalization guard: onComplete did not start within ${E2E_RUNNER_FINALIZATION_GUARD_TIMEOUT_MS}ms`,
  );
  try {
    // Bug 根因：历史 full run 在 122 个 worker 结束后静默退出 0，onComplete 没有
    // 写 summary。guard 超时先同步保全已有 NDJSON 的失败汇总，再做 best-effort 清理。
    e2eReporter.writeSummary(1);
  } catch (error) {
    writeE2ECleanupWarning(
      `finalization guard: summary recovery failed: ${formatErrorMessage(error)}`,
    );
  }
  armE2ERunnerExitWatchdog(1);

  const cleanupKeepAlive = setInterval(() => {}, 1000);
  void (async () => {
    try {
      await stopUpstreamE2EHttp();
      await stopCodingPlanTeamMock();
      await stopCodingPlanUpgradeE2EMock();
      await stopRequestSecurityFixture();
      await stopModelContextBudgetConfigE2EMock();
      await stopDynamicWorkflowConfigE2EMock();
      await stopPluginCdnZipFixture();
      await cleanupE2EElectronProcesses("finalization-guard");
      // 失败保留诊断现场（同 onComplete-home 条件）：guard 路径本身就是失败收尾。
      if (process.env.ZCODE_E2E_KEEP_HOME_ON_FAIL === "1") {
        console.warn(`[e2e] finalization guard keeping failure home: ${E2E_HOME_DIR}`);
      } else {
        await cleanupE2EDirectory("finalization-guard-home", E2E_HOME_DIR);
      }
      await cleanupE2EDirectory("finalization-guard-cache", E2E_RUN_CACHE_DIR);
    } catch (error) {
      writeE2ECleanupWarning(
        `finalization guard: emergency cleanup failed: ${formatErrorMessage(error)}`,
      );
    } finally {
      clearInterval(cleanupKeepAlive);
      process.exit(1);
    }
  })();
}
