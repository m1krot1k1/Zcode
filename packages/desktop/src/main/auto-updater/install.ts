import { app } from "electron";
import pkg from "electron-updater";
import { logger } from "../logger.js";
import { sendManualCheckResult, setAutoUpdaterMenuState } from "./channels.js";
import { shouldAutoDownloadAndInstallUpdates } from "./preferences.js";
import { clearPersistedPostUpdateReleaseNotesForVersion } from "./releaseNotes.js";
import {
  buildUpdateAvailableState,
  buildUpdateDownloadedState,
  clearAvailableUpdateState,
  clearDownloadingUpdateState,
  clearReadyUpdateState,
  crossModuleActions,
  hasVisibleUpdateTarget,
  isDevAutoUpdateEnabled,
  isReadyUpdateCurrentTarget,
  isUpdateTargetLocked,
  notifyForceAutoUpdate,
  shouldRelaunchForDevAutoUpdateInstall,
  updaterState,
} from "./state.js";

const { autoUpdater } = pkg;

function recoverFromFailedUpdateInstall(): void {
  const { runtime } = updaterState;
  if (runtime.quitAndInstallState === "recovering") return;
  // 退出准备已不可逆地关闭 Host/Agent 和远控服务；安装失败不能只清标记留在失效窗口。
  // 恢复保持终态直到退出，重复原生错误不得重复安排重启。
  runtime.quitAndInstallState = "recovering";
  logger.warn("[auto-update] install failed after shutdown started: relaunch app");
  app.relaunch();
  app.exit(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isDevSquirrelReadyError(error: unknown): boolean {
  if (
    app.isPackaged ||
    !isDevAutoUpdateEnabled() ||
    process.platform !== "darwin" ||
    !isRecord(error)
  ) {
    return false;
  }

  return error.domain === "SQRLUpdaterErrorDomain" && error.code === 2;
}

export async function quitAndInstallUpdate(rejectUnavailable = false) {
  const { runtime, menu, ready, available } = updaterState;
  if (runtime.quitAndInstallState !== "idle") {
    logger.info("[auto-update] quitAndInstall already in flight");
    return;
  }
  if (
    menu.state.kind === "update-downloaded" &&
    ready.version &&
    ready.restoredFromPendingReleaseNotes
  ) {
    const restoredVersion = ready.version;
    const restoredReleaseNotes = ready.releaseNotes;
    const restoredChannel = ready.channel ?? available.channel;
    logger.warn(
      `[auto-update] restage restored pending update before install version=${restoredVersion}`,
    );
    clearReadyUpdateState();
    available.releaseNotes = restoredReleaseNotes;
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(restoredVersion, restoredReleaseNotes, restoredChannel),
    );
    if (await shouldAutoDownloadAndInstallUpdates(runtime.settingService)) {
      crossModuleActions.downloadAvailableUpdate("restored-pending-install");
    }
    return;
  }

  if (menu.state.kind !== "update-downloaded" || !ready.version || !isReadyUpdateCurrentTarget()) {
    // 修复原因：renderer 可能因为旧 UpdateReady 缓存残留而展示“重启以更新”，
    // 但 main 在 staging error 后已经清掉 ready。目标已经换成更高版本时，
    // 这里也不能安装仍低于目标的旧包。
    logger.warn(`[auto-update] ignore quitAndInstall request: state=${menu.state.kind}`);
    if (rejectUnavailable) {
      throw new Error(`Update is not ready to install: state=${menu.state.kind}`);
    }
    return;
  }

  // 安装只读取已下载包，不依赖 manifest 请求。立即锁定 ready，迟到检查不能替换它，
  // 也不能让一次挂起的后台网络请求扣押用户已经选择的安装。
  runtime.quitAndInstallState = "preparing";
  logger.info("[auto-update] user requested quit and install");
  // macOS 上 quitAndInstall() 在关窗前不会先走 app.before-quit。
  // 如果仍然只靠 before-quit 去放行窗口 close，现有的“红绿灯关闭=隐藏窗口”逻辑会把退出拦住，
  // 表现成点击更新后界面消失但进程没退、安装流程也不再继续。
  // 这里先通知主进程进入“允许真正关窗”的状态，再把控制权交给 updater。
  try {
    // Windows 更新会替换 resources/glm 等随包资源；
    // 若 quitAndInstall 先于 host/agent 子进程完成退出，安装器可能在文件仍被占用时开始覆盖，
    // 最终留下“应用能启动但 bundled agent 丢失”的半更新状态。
    // 这里显式等待主进程完成退出准备，再进入安装器，尽量把资源替换和子进程回收时序拉直。
    await runtime.onBeforeQuitAndInstall?.();
  } catch (error) {
    // 安装前退出准备是释放 host/agent 与 resources/glm 文件锁的硬前置条件。
    // 如果这里失败后仍启动安装器，Windows 可能在资源仍被占用时覆盖安装目录，形成半更新。
    handleAutoUpdateFailure(error, "prepare quit and install failed");
    recoverFromFailedUpdateInstall();
    if (rejectUnavailable) {
      throw error;
    }
    return;
  }

  if (!ready.version || !isReadyUpdateCurrentTarget()) {
    // 后台结果已锁定，只有原生 staging 错误能使 ready 失效。服务已经清理，
    // 此时不能仅解除标记停留在旧窗口，必须重启恢复 Host/Agent 和远控连接。
    recoverFromFailedUpdateInstall();
    return;
  }

  runtime.quitAndInstallState = "installing";
  try {
    if (shouldRelaunchForDevAutoUpdateInstall()) {
      // 开发态只用于验证服务端 manifest、下载进度和安装入口 UI 闭环，
      // 未打包应用没有可被安装器接管的真实发布包上下文。这里改为重启当前 dev app，
      // 避免点击“重启以更新”执行退出准备后停在无响应状态。
      logger.info("[auto-update] dev update install fallback: relaunch app");
      app.relaunch();
      app.exit(0);
      return;
    }

    // 3.3.0 的 Windows 自定义 PowerShell delayed launcher 在 detached/hidden
    // 模式下可能只创建 powershell.exe，却没有稳定执行到安装器启动，用户看到应用关闭但版本不变。
    // 这里恢复 electron-updater 原生安装入口，避免把“launcher 进程创建成功”误当成更新已接管。
    autoUpdater.quitAndInstall();
    // macOS 安装入口会先返回，原生 staging 完成后才异步触发 before-quit。
    // 若在 finally 清标记，退出监听器会重新拦截并安装，形成无限重入；成功交接后保留到进程退出。
  } catch (error) {
    handleAutoUpdateFailure(error, "quit and install failed");
    if (rejectUnavailable) {
      throw error;
    }
  }
}

export function handleAutoUpdateFailure(error: unknown, source: string) {
  const { runtime, menu, ready, available, downloading, listeners } = updaterState;
  if (runtime.quitAndInstallState === "recovering") return;
  if (isUpdateTargetLocked() && source.endsWith("check failed")) {
    logger.info("[auto-update] ignore late check failure after install admission");
    return;
  }
  const failedInstall = runtime.quitAndInstallState === "installing";
  const message = error instanceof Error ? error.message : String(error);
  const failedDownload =
    menu.state.kind === "download-progress"
      ? {
          version: downloading.version ?? menu.state.version,
          releaseNotes: downloading.releaseNotes ?? menu.state.releaseNotes ?? null,
          channel: downloading.channel ?? menu.state.channel ?? available.channel,
        }
      : downloading.cancellationToken && downloading.version
        ? {
            version: downloading.version,
            releaseNotes: downloading.releaseNotes ?? null,
            channel: downloading.channel ?? available.channel,
          }
        : null;
  if (menu.state.kind === "update-downloaded" && ready.version && isDevSquirrelReadyError(error)) {
    // 开发态验证真实测试环境 manifest 时，macOS Squirrel 仍可能在
    // update-downloaded 后补一个 code=2 staging 错误。生产包必须清掉失败的 ready，
    // 但开发态需要保留 ready 状态来验证“重启以更新”交互闭环。
    logger.warn(
      `[auto-update] ignore dev Squirrel ready error after ${source} version=${ready.version}: ${message}`,
    );
    setAutoUpdaterMenuState(buildUpdateDownloadedState(ready.version));
    return;
  }

  logger.error(`[auto-update] ${source}:`, error);
  if (source.endsWith("check failed") && hasVisibleUpdateTarget(menu.state) && !listeners.force) {
    notifyForceAutoUpdate({ kind: "error", message });
    sendManualCheckResult({ kind: "error", message });
    return;
  }
  if (menu.state.kind === "update-downloaded" && ready.version) {
    const failedReadyVersion = ready.version;
    // macOS Squirrel 可能在 update-downloaded 后才发现包无法 stage。
    // 如果继续保留 ready 缓存，renderer 会一直展示“重启以更新”，再次点击只会调用一个已失败的安装上下文。
    clearReadyUpdateState();
    clearPersistedPostUpdateReleaseNotesForVersion(
      failedReadyVersion,
      `${source}-after-ready-error`,
    );
    logger.info(`[auto-update] cleared ready update after ${source} version=${failedReadyVersion}`);
  }
  clearAvailableUpdateState();
  clearDownloadingUpdateState();
  if (failedDownload?.version && !ready.version && !listeners.force) {
    // 修复原因：用户点击“下载更新”后如果下载启动或 staging 很快失败，
    // 旧逻辑会清空 available/downloading 并广播 idle，renderer 入口和弹窗同时消失。
    // 失败并不等同于用户跳过该版本，应退回“发现更新”状态，让用户能看到并重试下载。
    available.releaseNotes = failedDownload.releaseNotes;
    available.channel = failedDownload.channel;
    setAutoUpdaterMenuState(
      buildUpdateAvailableState(
        failedDownload.version,
        failedDownload.releaseNotes,
        failedDownload.channel,
      ),
    );
  } else {
    setAutoUpdaterMenuState(
      ready.version ? buildUpdateDownloadedState(ready.version) : { kind: "idle", enabled: true },
    );
  }
  notifyForceAutoUpdate({ kind: "error", message });
  sendManualCheckResult({ kind: "error", message });
  // 下载失败也是一次下载结束，无论来自 Promise reject 还是 error 事件。
  // 没有强制更新在进行时立即复查，避免弱网失败期间错过更高版本。
  // 失败可能发生在启动检查的结果处理里，记下原因，等这次检查收口后再查。
  if (failedDownload && !listeners.force) {
    runtime.recheckAfterDownload?.("download-failed");
  }
  if (failedInstall) recoverFromFailedUpdateInstall();
}
