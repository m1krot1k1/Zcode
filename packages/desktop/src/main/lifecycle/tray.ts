import type { Locale, DesktopCommandId } from "@zcode/shared";
import { logger } from "../logger.js";
import { createDesktopTray } from "../desktopTray.js";
import {
  resolveCloseToTraySupported,
  type createCloseToTrayCapabilityMonitor,
} from "../desktopTraySupport.js";

export interface TrayLifecycleOptions {
  getApplicationLocale: () => Locale;
  ensurePrimaryWindow: (reason: string) => Promise<void>;
  executeDesktopCommand: (command: DesktopCommandId) => Promise<unknown>;
  markExplicitQuit: (reason: string) => void;
  quitApp: () => void;
  getTrayReady: () => boolean;
  setTrayReady: (ready: boolean) => void;
  closeToTrayCapabilityMonitor: ReturnType<typeof createCloseToTrayCapabilityMonitor>;
  windowUnreadCountMap: Map<number, number>;
  syncApplicationUnreadBadge: (unreadCountMap: Map<number, number>) => void;
}

export interface TrayLifecycle {
  initializeTray: () => void;
  ensureLinuxDesktopTray: () => Promise<void>;
  refreshCloseToTrayCapability: () => Promise<{
    supported: boolean;
    gnomeLikeWithoutTray: boolean;
  }>;
}

export function createTrayLifecycle(options: TrayLifecycleOptions): TrayLifecycle {
  const desktopTrayOptions = {
    getLocale: options.getApplicationLocale,
    showCurrentWindow: () => {
      void options.ensurePrimaryWindow("tray-show-current-window");
    },
    executeDesktopCommand: options.executeDesktopCommand,
    quitApp: () => {
      options.markExplicitQuit("tray-quit");
      options.quitApp();
    },
    logger,
  };

  // CR-01：托盘实例是否创建成功必须成为可隐藏能力的一部分。DBus watcher 只能证明桌面
  // 可能有 host，new Tray() 仍可能因图标缺失/会话未就绪抛错；此时隐藏窗口会让用户失去
  // 唯一入口（失联）。trayReady 由创建结果置位，关窗与设置页能力查询都读它。
  function initializeTray(): void {
    if (process.platform === "win32") {
      options.setTrayReady(createDesktopTray(desktopTrayOptions) !== null);
    }
  }

  async function ensureLinuxDesktopTray(): Promise<void> {
    if (process.platform !== "linux" || options.getTrayReady()) {
      return;
    }
    // Linux 托盘创建跟随能力而非设置开关（spec：docs/desktop/linux-close-to-tray.md）：
    // 无 StatusNotifierWatcher 的桌面（GNOME 默认）上 new Tray() 静默失败，注册无人渲染的
    // DBus name 没有意义；能力探测通过后再创建。用户装扩展后经设置页查询也会走到这里补建。
    const capability = await options.closeToTrayCapabilityMonitor.refresh();
    if (capability.supported) {
      options.setTrayReady(
        createDesktopTray({ ...desktopTrayOptions, platform: "linux" }) !== null,
      );
      // 托盘补建成功时回放当前未读数：创建前已有的未读不能等到下一次计数变化才出现在红点上。
      if (options.getTrayReady()) {
        options.syncApplicationUnreadBadge(options.windowUnreadCountMap);
      }
    }
  }

  async function refreshCloseToTrayCapability(): Promise<{
    supported: boolean;
    gnomeLikeWithoutTray: boolean;
  }> {
    await ensureLinuxDesktopTray();
    const capability = await options.closeToTrayCapabilityMonitor.refresh();
    return {
      supported: resolveCloseToTraySupported({
        platform: process.platform,
        desktopTrayReady: options.getTrayReady(),
        capabilitySupported: capability.supported,
      }),
      gnomeLikeWithoutTray: capability.gnomeLikeWithoutTray,
    };
  }

  return { initializeTray, ensureLinuxDesktopTray, refreshCloseToTrayCapability };
}
