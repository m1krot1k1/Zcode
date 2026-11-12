import type { BrowserWindow } from "electron";
import { InternalChannels, type HostProcessExitNotification } from "@zcode/shared";

/**
 * 每个 Host 生命周期链只允许一次自动重启。
 *
 * 无限 respawn 会在 CLI 配置损坏/端口绑定失败等确定性故障下变成 busy loop，
 * 比直接报错更糟；一次重启能覆盖偶发崩溃，第二次仍失败则交给 UI 提示用户。
 */
export const MAX_HOST_PROCESS_RESPAWNS = 1;

interface HostProcessExitDecision {
  notify: boolean;
  respawn: boolean;
}

/**
 * 只有“非主动 dispose + 窗口仍存活 + 尚未用完重启额度”才允许 respawn。
 * 无论是否重启，意外退出都必须通知 renderer，否则界面会停在不可恢复的 loading 状态。
 */
export function resolveHostProcessExitDecision(params: {
  intentional: boolean;
  windowDestroyed: boolean;
  webContentsDestroyed: boolean;
  respawnAttempt: number;
}): HostProcessExitDecision {
  if (params.intentional || params.windowDestroyed || params.webContentsDestroyed) {
    return { notify: false, respawn: false };
  }
  return {
    notify: true,
    respawn: params.respawnAttempt < MAX_HOST_PROCESS_RESPAWNS,
  };
}

/** main → renderer 的退出通知；窗口销毁或发送失败时静默返回，不能让退出处理本身崩溃。 */
export function notifyHostProcessExit(
  win: BrowserWindow,
  payload: HostProcessExitNotification,
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(InternalChannels.HostProcessExited, payload);
  } catch {
    // 退出路径以清理进程为主，通知失败不能反向阻断 respawn/注销。
  }
}
