import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { useMarketingTaskCompletionRefresh } from "@/components/marketing-touch/useMarketingTaskCompletionRefresh.js";
import { useWorkspaceTerminalTaskNotifications } from "@/hooks/useTaskNotifications.js";
import { useOffPeakTaskNotifications } from "@/hooks/useOffPeakTaskNotifications.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/**
 * Уведомления App-уровня: завершение маркетинговых задач, терминальные
 * task-события workspace и off-peak уведомления (только desktop-цепочка).
 */
export function useAppRootNotifications({
  services,
  workspaceAbsPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  workspaceRpcReady,
  isDesktop,
  platform,
}: {
  services: IServiceAccessor;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  workspaceRpcReady: boolean;
  isDesktop?: boolean;
  platform: IPlatformService;
}) {
  const { intl } = useZCodeIntl();
  const notificationEnabled = useZCodeStore((s) => s.notificationEnabled);
  useMarketingTaskCompletionRefresh({
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { endpointKey: workspaceRemoteSessionId } : {}),
    rpcReady: workspaceRpcReady,
  });
  useWorkspaceTerminalTaskNotifications({
    workspacePath: workspaceAbsPath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { endpointKey: workspaceRemoteSessionId } : {}),
    enabled: notificationEnabled,
    rpcReady: workspaceRpcReady,
    platform,
    formatMessage: intl.formatMessage,
  });
  // 闲时任务终态/等确认通知：仅桌面本地链路，main 进程按 status:taskId 去重多窗口重复。
  useOffPeakTaskNotifications({
    offPeakTaskService: services.offPeakTaskService,
    platform,
    enabled: Boolean(notificationEnabled && isDesktop),
    formatMessage: intl.formatMessage,
  });
}
