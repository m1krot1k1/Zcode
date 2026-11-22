import { useEffect, useRef } from "react";
import type { IServiceAccessor } from "./contract.ts";
import {
  shouldBlockRootRender,
  shouldOpenFallbackWorkspaceAfterCreate,
} from "@/lib/rootStartupGate.js";
import { logger } from "@/logger.js";
import type { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import type { TabStore } from "@/store/tabStore.js";

/**
 * 启动兜底 workspace：历史恢复为空且入口没有 initialWorkspacePath 时落到默认会话目录。
 *
 * 不能用 effect cleanup 作为异步取消标记：setIsCreatingFallbackWorkspace 或 addTab 后的
 * workspaceShellPath 变化都会先跑 cleanup，若因此跳过 finally，启动 loading gate 会永远为 true。
 */
export function useRootFallbackWorkspace({
  services,
  tabStoreApi,
  isResolvingStartupAuthState,
  isResolvingProviderStartupState,
  isRestoring,
  isBootstrappingInitialWorkspace,
  isStartupProviderLoginEntryOpen,
  workspaceShellPath,
  isSettingsTabActive,
  allowOpenWorkspace,
  handleSelectConversationWorkspace,
  setWorkspaceActionError,
  setIsCreatingFallbackWorkspace,
}: {
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  isResolvingStartupAuthState: boolean;
  isResolvingProviderStartupState: boolean;
  isRestoring: boolean;
  isBootstrappingInitialWorkspace: boolean;
  isStartupProviderLoginEntryOpen: boolean;
  workspaceShellPath: string | null;
  isSettingsTabActive: boolean;
  allowOpenWorkspace: boolean;
  handleSelectConversationWorkspace: ReturnType<
    typeof useRootWorkspaceActions
  >["handleSelectConversationWorkspace"];
  setWorkspaceActionError: ReturnType<typeof useRootWorkspaceActions>["setWorkspaceActionError"];
  setIsCreatingFallbackWorkspace: (creating: boolean) => void;
}) {
  const didRequestFallbackWorkspaceRef = useRef(false);
  const rootInnerMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      rootInnerMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      shouldBlockRootRender({
        isResolvingStartupAuthState,
        isResolvingProviderStartupState,
        isRestoring,
        isBootstrappingInitialWorkspace,
      }) ||
      isStartupProviderLoginEntryOpen ||
      workspaceShellPath ||
      isSettingsTabActive ||
      !allowOpenWorkspace ||
      didRequestFallbackWorkspaceRef.current
    ) {
      return;
    }

    didRequestFallbackWorkspaceRef.current = true;
    setIsCreatingFallbackWorkspace(true);
    // 以前 tab store 的默认空态会把 Root 带到打开工作区中间页。
    // 删除整页流程后，启动恢复为空或入口没有传 initialWorkspacePath 时必须在 Root
    // 兜底落到默认 workspace，避免用户先看到一张“打开工作区”中间页或空白页。
    // 这里不能用当前 effect 的 cleanup 作为异步取消标记：setIsCreatingFallbackWorkspace
    // 或 addTab 后的 workspaceShellPath 变化都会让 React 先跑 cleanup，若因此跳过 finally，
    // 启动 loading gate 会永远保持 true。
    services.fileService
      .ensureConversationWorkspace()
      .then((result) => {
        // 启动兜底创建目录可能早于会话恢复发起、晚于恢复完成返回。
        // 返回后必须按 tab store 最新 active workspace 再判一次，避免迟到的默认项目抢走上次恢复的 tab。
        if (
          !shouldOpenFallbackWorkspaceAfterCreate({
            isMounted: rootInnerMountedRef.current,
            activeWorkspacePath: tabStoreApi.getState().activeWorkspacePath,
          })
        ) {
          return;
        }
        handleSelectConversationWorkspace(result.path);
      })
      .catch((error) => {
        if (!rootInnerMountedRef.current) {
          return;
        }
        logger.error("[Root] 启动兜底创建默认 workspace 失败", { error });
        setWorkspaceActionError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (rootInnerMountedRef.current) {
          setIsCreatingFallbackWorkspace(false);
        }
      });
  }, [
    allowOpenWorkspace,
    handleSelectConversationWorkspace,
    isBootstrappingInitialWorkspace,
    isResolvingProviderStartupState,
    isResolvingStartupAuthState,
    isRestoring,
    isSettingsTabActive,
    isStartupProviderLoginEntryOpen,
    services.fileService,
    setWorkspaceActionError,
    setIsCreatingFallbackWorkspace,
    tabStoreApi,
    workspaceShellPath,
  ]);
}
