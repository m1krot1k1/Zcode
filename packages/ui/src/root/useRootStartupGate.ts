import { useMemo } from "react";
import type { UserInfo } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import {
  isProviderStartupSyncPending,
  shouldEnableProviderAvailabilityLoginEntryGuard,
  shouldResolveProviderStartupState,
} from "@/lib/rootStartupGate.js";
import { resolveProviderAvailabilityState } from "@/lib/modelProviderAvailability.js";
import type { WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";
import type { WelcomeScreenOpenReason } from "@/root/useRootEntryState.js";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";

/**
 * 启动门禁：把 OAuth 恢复、provider 可用性检查与 workspace 恢复串成一条判定链。
 *
 * `workspacePersistenceGate` 从这里产出，由 tab 恢复与远程 session 流程共享同一个可变门禁。
 */
export function useRootStartupGate({
  preferDirectoryBrowser,
  explicitSupportsEmbeddedBrowser,
  isDesktop,
  isRestoringOAuthSession,
  rootModelSelectionRead,
  rootModelSelectionView,
  providerFamilyDomainMigrationComplete,
  isWebRemoteControlRoot,
  welcomeScreenOpenReason,
  setWelcomeScreenOpenReason,
  user,
  providerFamilyDomain,
  refreshProviderState,
  readModelSelectionView,
}: {
  preferDirectoryBrowser?: boolean;
  explicitSupportsEmbeddedBrowser?: boolean;
  isDesktop?: boolean;
  isRestoringOAuthSession: boolean;
  rootModelSelectionRead: ReturnType<typeof useModelSelectionServiceView>;
  rootModelSelectionView: ModelSelectionView | null;
  providerFamilyDomainMigrationComplete: boolean;
  isWebRemoteControlRoot: boolean;
  welcomeScreenOpenReason: WelcomeScreenOpenReason | null;
  setWelcomeScreenOpenReason: (
    update: (current: WelcomeScreenOpenReason | null) => WelcomeScreenOpenReason | null,
  ) => void;
  user: UserInfo | null;
  providerFamilyDomain: string | null | undefined;
  refreshProviderState: () => Promise<void>;
  readModelSelectionView: () => Promise<ModelSelectionView>;
}) {
  const shouldPreferDirectoryBrowser = Boolean(preferDirectoryBrowser);
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  const isResolvingStartupAuthState = isRestoringOAuthSession;
  const rootProviderAvailability = resolveProviderAvailabilityState({
    modelSelectionView: rootModelSelectionView,
  });
  const providerStartupSyncPending = isProviderStartupSyncPending({
    providerFamilyDomainMigrationComplete,
    modelSelectionViewHydrated:
      rootProviderAvailability.hydrated || rootModelSelectionRead.state.status === "error",
  });
  const providerAvailabilityLoginEntryGuardEnabled =
    shouldEnableProviderAvailabilityLoginEntryGuard({
      isWebRemoteControlRoot,
    });
  const { startupCheckCompleted: providerAvailabilityStartupCheckCompleted } =
    useProviderAvailabilityLoginEntryGuard({
      enabled: providerAvailabilityLoginEntryGuardEnabled,
      user,
      isRestoringOAuthSession: isResolvingStartupAuthState || providerStartupSyncPending,
      providerFamilyDomain,
      modelSelectionView: rootModelSelectionView,
      modelSelectionError:
        rootModelSelectionRead.state.status === "error"
          ? rootModelSelectionRead.state.error
          : undefined,
      refreshProviderState,
      readModelSelectionView,
      setLoginEntryOpen: (open) => {
        setWelcomeScreenOpenReason((currentReason) => {
          if (open) {
            return "startup-provider-required";
          }
          // JWT 过期提示确认后会先写入 session-expired，随后 provider
          // 启动门禁以 open=false 收尾。这里若无条件清空，会覆盖重新登录页并回到工作区。
          // 门禁只能关闭自己拥有的启动登录态，不能清理其它交互来源的 reason。
          return currentReason === "startup-provider-required" ? null : currentReason;
        });
      },
    });
  const isResolvingProviderStartupState = shouldResolveProviderStartupState({
    isWebRemoteControlRoot,
    providerStartupSyncPending,
    providerAvailabilityStartupCheckCompleted,
  });
  const isStartupProviderLoginEntryOpen = welcomeScreenOpenReason === "startup-provider-required";
  // 首次安装时 provider 登录入口判定晚于 workspace 注入，ChatView 会先 mount 并触发草稿预热。
  // 这里把 provider 启动检查纳入 workspace 恢复门禁，避免未连接账号前启动 ZCode session。
  const canRestoreWorkspaceSession =
    !isResolvingStartupAuthState &&
    !isResolvingProviderStartupState &&
    !isStartupProviderLoginEntryOpen;
  const workspacePersistenceGate = useMemo<WorkspacePersistenceGate>(
    () => ({ canPersist: false, restoreFailed: false }),
    [],
  );

  return {
    shouldPreferDirectoryBrowser,
    supportsEmbeddedBrowser,
    isResolvingStartupAuthState,
    providerStartupSyncPending,
    isResolvingProviderStartupState,
    isStartupProviderLoginEntryOpen,
    canRestoreWorkspaceSession,
    workspacePersistenceGate,
  };
}
