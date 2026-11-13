import { useCallback, useEffect } from "react";
import { logger } from "@/logger.js";
import type { WelcomeScreenOpenReason } from "@/root/useRootEntryState.js";
import type { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import type { LoginCompleteReason } from "@/WelcomeScreen.js";

/**
 * 欢迎/登录页的入口与完成收尾。
 *
 * 登录入口已从模态弹窗收敛为 WelcomeScreen；provider 连接请求仍要先退出首次启动引导语义，
 * 避免连接完成后误创建默认 workspace。
 */
export function useRootWelcomeScreenEntry({
  workspaceShellPath,
  isSettingsTabActive,
  loginEntryRequest,
  welcomeScreenOpenReason,
  setWelcomeScreenOpenReason,
  refreshAppSettings,
  allowOpenWorkspace,
  handleEnsureConversationWorkspace,
}: {
  workspaceShellPath: string | null;
  isSettingsTabActive: boolean;
  loginEntryRequest: unknown;
  welcomeScreenOpenReason: WelcomeScreenOpenReason | null;
  setWelcomeScreenOpenReason: (reason: WelcomeScreenOpenReason | null) => void;
  refreshAppSettings: () => Promise<void>;
  allowOpenWorkspace: boolean;
  handleEnsureConversationWorkspace: ReturnType<
    typeof useRootWorkspaceActions
  >["handleEnsureConversationWorkspace"];
}) {
  useEffect(() => {
    if (!workspaceShellPath) {
      return;
    }

    logger.info(
      `[Root] settings view ${isSettingsTabActive ? "open" : "closed"} workspace=${workspaceShellPath}`,
    );
  }, [isSettingsTabActive, workspaceShellPath]);

  useEffect(() => {
    if (!loginEntryRequest) {
      return;
    }
    // 登录入口已从模态弹窗收敛为 WelcomeScreen。
    // provider 连接请求仍要先退出首次启动引导语义，避免连接完成后误创建默认 workspace。
    setWelcomeScreenOpenReason("provider-request");
  }, [loginEntryRequest, setWelcomeScreenOpenReason]);

  // 登录入口不依赖会话；保持引用稳定，避免草稿更新穿透侧栏 memo。
  const handleOpenLoginEntry = useCallback(() => {
    setWelcomeScreenOpenReason("manual-login");
  }, [setWelcomeScreenOpenReason]);
  const handleWelcomeScreenComplete = useCallback(
    async (reason: LoginCompleteReason) => {
      await refreshAppSettings();
      if (
        welcomeScreenOpenReason !== "startup-provider-required" ||
        workspaceShellPath ||
        !allowOpenWorkspace
      ) {
        setWelcomeScreenOpenReason(null);
        return;
      }

      try {
        await handleEnsureConversationWorkspace();
      } catch (error) {
        logger.error("[Root] 登录后创建默认 workspace 失败", {
          error,
          reason,
        });
      } finally {
        setWelcomeScreenOpenReason(null);
      }
    },
    [
      allowOpenWorkspace,
      handleEnsureConversationWorkspace,
      refreshAppSettings,
      setWelcomeScreenOpenReason,
      welcomeScreenOpenReason,
      workspaceShellPath,
    ],
  );

  return { handleOpenLoginEntry, handleWelcomeScreenComplete };
}
