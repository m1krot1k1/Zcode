import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { IServiceAccessor } from "./contract.ts";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { Button } from "@/components/ui/button.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { consumeZcodeJwtInvalidRestartMarker } from "@/root/zcodeJwtInvalidRestartMarker.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

export type WelcomeScreenOpenReason =
  | "startup-provider-required"
  | "manual-login"
  | "provider-request"
  | "logout-provider-required"
  | "session-expired";

/**
 * Root 入口层状态：登录/欢迎页、模型选择读取、远程连接弹窗与目录浏览器开关。
 *
 * 这里只持有入口 UI 的局部状态，不承载 workspace 业务事实。
 */
export function useRootEntryState({
  services,
  intl,
  initialWorkspaceAbsPath,
}: {
  services: IServiceAccessor;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  initialWorkspaceAbsPath?: string;
}) {
  const [welcomeScreenOpenReason, setWelcomeScreenOpenReason] =
    useState<WelcomeScreenOpenReason | null>(() =>
      consumeZcodeJwtInvalidRestartMarker() ? "session-expired" : null,
    );
  const loginEntryRequest = useZCodeStore((state) => state.loginEntryRequest);
  const rootModelSelectionRead = useModelSelectionServiceView(services.modelSelectionService);
  const rootModelSelectionView =
    rootModelSelectionRead.state.status === "ready" ? rootModelSelectionRead.state.view : null;
  const rootModelSelectionErrorNode =
    rootModelSelectionRead.state.status === "error" ? (
      <div className="fixed right-4 bottom-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-destructive/30 bg-surface-raised px-3 py-2 text-ui-base text-foreground shadow-lg">
        <span className="min-w-0 flex-1">
          {intl.formatMessage({ id: "root.modelSelection.loadFailed" })}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={rootModelSelectionRead.reload}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    ) : null;
  const readRootModelSelectionView = useCallback(
    () => services.modelSelectionService.getView(),
    [services.modelSelectionService],
  );
  const [remoteConnectionDialogOpen, setRemoteConnectionDialogOpen] = useState(false);
  const [remoteConnectionOpenPreference, setRemoteConnectionOpenPreference] =
    useState<RemoteConnectionOpenPreference | null>(null);
  const [remoteConnectionOpenIntentId, setRemoteConnectionOpenIntentId] = useState(0);
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [remoteConnectionInProgress, setRemoteConnectionInProgress] = useState(false);
  const [remoteConnectionRequestId, setRemoteConnectionRequestId] = useState<string | null>(null);
  const { connectionLogs: remoteConnectionLogs, resetConnectionLogs: resetRemoteConnectionLogs } =
    useRemoteConnectionLogs(remoteConnectionRequestId);
  const [isBootstrappingInitialWorkspace, setIsBootstrappingInitialWorkspace] = useState(
    Boolean(initialWorkspaceAbsPath),
  );
  // 兜底创建 workspace 的 loading 状态由入口层持有：首屏门禁与兜底 effect 都要读它，
  // 单一 owner 避免两处状态互相等待。
  const [isCreatingFallbackWorkspace, setIsCreatingFallbackWorkspace] = useState(false);
  const previousRemoteConnectionInProgressRef = useRef(false);

  useEffect(() => {
    const wasInProgress = previousRemoteConnectionInProgressRef.current;
    if (!wasInProgress && remoteConnectionInProgress) {
      resetRemoteConnectionLogs();
    }
    previousRemoteConnectionInProgressRef.current = remoteConnectionInProgress;
  }, [remoteConnectionInProgress, resetRemoteConnectionLogs]);

  return {
    welcomeScreenOpenReason,
    setWelcomeScreenOpenReason,
    loginEntryRequest,
    rootModelSelectionRead,
    rootModelSelectionView,
    rootModelSelectionErrorNode,
    readRootModelSelectionView,
    remoteConnectionDialogOpen,
    setRemoteConnectionDialogOpen,
    remoteConnectionOpenPreference,
    setRemoteConnectionOpenPreference,
    remoteConnectionOpenIntentId,
    setRemoteConnectionOpenIntentId,
    directoryBrowserOpen,
    setDirectoryBrowserOpen,
    remoteConnectionInProgress,
    setRemoteConnectionInProgress,
    remoteConnectionRequestId,
    setRemoteConnectionRequestId,
    remoteConnectionLogs,
    resetRemoteConnectionLogs,
    isBootstrappingInitialWorkspace,
    setIsBootstrappingInitialWorkspace,
    isCreatingFallbackWorkspace,
    setIsCreatingFallbackWorkspace,
  };
}
