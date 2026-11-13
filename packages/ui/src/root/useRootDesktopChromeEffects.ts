import { useEffect, useRef, useState } from "react";
import type { IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useDesktopNativeThemeSync } from "@/root/useDesktopNativeThemeSync.js";
import type { Theme } from "@/useTheme.js";

/**
 * 桌面窗口外观相关的副作用：更新说明静默确认 + nativeTheme 同步。
 *
 * 自动更新每次命中待展示 release notes 都会回到这里；产品已移除弹窗，因此收到后直接 ack，
 * 既保留“更新已下载”按钮/菜单/安装链路，也避免 pending 状态残留到下次启动。
 */
export function useRootDesktopChromeEffects({
  platform,
  isDesktop,
  theme,
  isStartupRenderBlocked,
  welcomeScreenOpen,
  workspaceShellPath,
  isSettingsTabActive,
}: {
  platform: IPlatformService;
  isDesktop?: boolean;
  theme: Theme;
  isStartupRenderBlocked: boolean;
  welcomeScreenOpen: boolean;
  workspaceShellPath: string | null;
  isSettingsTabActive: boolean;
}) {
  const acknowledgingReleaseNotesVersionRef = useRef<string | null>(null);
  const [hasEnteredNativeThemeSyncSurface, setHasEnteredNativeThemeSyncSurface] = useState(false);

  useEffect(
    () =>
      platform.onPostUpdateReleaseNotes((payload) => {
        logger.info("[Root] 收到更新说明，改为静默确认", {
          version: payload.version,
          title: payload.title,
        });
        if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
          return;
        }

        // 自动更新每次命中待展示 release notes 都会走到这里，
        // 之前 Root 会立刻把 payload 送进对话框状态，导致用户每次更新都被强制弹窗打断。
        // 这次需求只移除弹窗本身，因此这里改成收到后直接静默 ack，
        // 既不影响“更新已下载”按钮/菜单/安装链路，也避免 pending 状态残留到下次启动后再次触发。
        acknowledgingReleaseNotesVersionRef.current = payload.version;
        void platform
          .acknowledgePostUpdateReleaseNotes(payload.version)
          .then(() => {
            logger.info("[Root] 更新说明已静默确认", {
              version: payload.version,
            });
          })
          .catch((error) => {
            logger.error("[Root] 更新说明静默确认失败", {
              version: payload.version,
              error,
            });
          })
          .finally(() => {
            if (acknowledgingReleaseNotesVersionRef.current === payload.version) {
              acknowledgingReleaseNotesVersionRef.current = null;
            }
          });
      }),
    [platform],
  );

  const canEnterNativeThemeSyncSurface = Boolean(
    !isStartupRenderBlocked && !welcomeScreenOpen && (workspaceShellPath || isSettingsTabActive),
  );

  useEffect(() => {
    if (!canEnterNativeThemeSyncSurface) {
      return;
    }

    // macOS nativeTheme 会影响窗口 vibrancy。这里等 RootStartupLoading
    // 真正退出并进入主界面/设置页后一轮再允许同步，避免启动壳背景被应用主题提前改写。
    setHasEnteredNativeThemeSyncSurface(true);
  }, [canEnterNativeThemeSyncSurface]);

  useDesktopNativeThemeSync({
    enabled: hasEnteredNativeThemeSyncSurface,
    isDesktop,
    platform,
    theme,
  });
}
