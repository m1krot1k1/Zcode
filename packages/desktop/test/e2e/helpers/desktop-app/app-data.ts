import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { collectWindowsE2EProcessTreePids } from "../e2e-process-cleanup.js";
import { desktopAppPaths } from "./paths.js";

const REMOVE_APP_DATA_RETRY_DELAYS_MS = [200, 500, 1000, 2000, 3000];
const REMOVE_APP_DATA_MAX_ATTEMPTS = REMOVE_APP_DATA_RETRY_DELAYS_MS.length;

export async function clearAppData() {
  if (process.env.ZCODE_E2E_DEFER_APP_DATA_CLEANUP === "1") {
    // 修复原因：普通 spec 的 after hook 先 app.quit 会抢在 ChromeDriver
    // deleteSession 前销毁 browsing context，导致每个 worker 都支付断连超时。
    // WDIO afterSession 会在进程退出后删除 app data，此处只交还关闭所有权。
    return;
  }
  await quitElectronAppGracefully();
  await removeAppDataWithRetry();
}

export async function quitElectronAppGracefully() {
  try {
    const result = (await browser.electron.execute((electron) => {
      if (electron.app.getName() !== "ZCode E2E") {
        return { quit: false, pid: process.pid };
      }
      // 修复原因：clearAppData 常在 spec after 中运行；如果把 app.quit 延迟
      // 投递到下一 tick，长批次下旧 session 的 quit 可能串到下一轮 Electron。
      electron.app.quit();
      return { quit: true, pid: process.pid };
    })) as { quit: boolean; pid: number };

    if (result.quit && result.pid) {
      // Bug 根因：Electron 的 before-quit 最长会等待 9s Host 清理，10s 的
      // 外层等待会在 Main 最后一次 setting 写回前恰好返回。紧接着写入下一个
      // E2E 场景时，旧进程会用上一场景覆盖新 fixture。等待上限必须覆盖
      // Electron 自身的清理窗口，确认进程退出后才交还持久化文件所有权。
      await waitForPidExit(result.pid, 15_000);
    }
  } catch {
    // session already closed or app already gone — safe to continue
  }
}

async function waitForPidExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function removeAppDataWithRetry() {
  for (let attempt = 0; attempt <= REMOVE_APP_DATA_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rm(desktopAppPaths.appDataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 500,
      });
      return;
    } catch (error) {
      if (!isRetryableRemoveError(error) || attempt === REMOVE_APP_DATA_MAX_ATTEMPTS) {
        if (
          !isRetryableRemoveError(error) ||
          process.env.ZCODE_E2E_STRICT_APP_DATA_CLEANUP === "1"
        ) {
          throw error;
        } else {
          // Bugfix: after hook 的 app 数据清理只负责收尾；Windows 可能短时间保留
          // tasks-index.sqlite 句柄，下一轮 beforeSession 会先杀进程再强制重置 .e2e-home。
          process.stderr.write(
            `[desktop-e2e-cleanup] clearAppData skipped locked app data cleanup: ${formatErrorMessage(error)}\n`,
          );
          return;
        }
      }
      // 修复原因：Windows 上 host/service 进程可能在 Electron 主进程退出后仍短暂持有
      // tasks-index.sqlite 的 WAL/SHM 句柄；删除前先清掉遗留 E2E 进程，避免 after hook
      // 因清理失败把业务 case 误报为失败。
      await cleanupLeftoverE2EProcesses();
      await browser.pause(REMOVE_APP_DATA_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableRemoveError(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "ENOTEMPTY" || error.code === "EBUSY" || error.code === "EPERM";
}

async function cleanupLeftoverE2EProcesses() {
  if (process.platform !== "win32") {
    return;
  }

  const pids = listWindowsLeftoverE2EProcessPids();
  for (const pid of pids) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // 清理是尽力兜底；removeAppDataWithRetry 会继续用错误路径决定是否失败。
    }
  }
  await waitForProcessesExit(pids, 3000);
}

function listWindowsLeftoverE2EProcessPids() {
  try {
    const script = [
      "Get-CimInstance Win32_Process |",
      "Select-Object ProcessId,ParentProcessId,CommandLine |",
      "ConvertTo-Json -Compress",
    ].join(" ");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return collectWindowsE2EProcessTreePids(output, {
      currentPid: process.pid,
      homeDir: desktopAppPaths.homeDir,
      runId: process.env.ZCODE_E2E_RUN_ID,
    });
  } catch {
    return [];
  }
}
async function waitForProcessesExit(pids: number[], timeoutMs: number) {
  if (pids.length === 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
