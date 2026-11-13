import { useEffect } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { useTabPersistence } from "@/hooks/useTabPersistence.js";
import type { WorkspacePersistenceGate } from "@/hooks/useTabPersistence.js";
import { reconcileConversationTelemetryWorkspaceScopes } from "@/v4/telemetry/ConversationTelemetryAttachment.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

type TabPersistenceOptions = Parameters<typeof useTabPersistence>[0];

/**
 * workspace 会话持久化与恢复完成态。
 *
 * 恢复门禁同时受 provider 启动检查约束：未连接账号前不恢复 workspace，避免 ChatView
 * 在登录页背后预热草稿 session。完成后才把全量 workspace 集合同步给对话遥测。
 */
export function useRootTabPersistence({
  services,
  supportsSettings,
  restoreSession,
  canRestoreWorkspaceSession,
  workspacePersistenceGate,
  restorePersistedSession,
  buildPersistedTabPatch,
  isDesktop,
  windowWorkspaceTabs,
}: {
  services: IServiceAccessor;
  supportsSettings: boolean;
  restoreSession: boolean;
  canRestoreWorkspaceSession: boolean;
  workspacePersistenceGate: WorkspacePersistenceGate;
  restorePersistedSession: TabPersistenceOptions["restorePersistedSession"];
  buildPersistedTabPatch: TabPersistenceOptions["buildPersistPatch"];
  isDesktop?: boolean;
  windowWorkspaceTabs: WorkspaceTabState[];
}) {
  const { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore } = useTabPersistence({
    settingService: supportsSettings ? services.settingService : undefined,
    // 首次安装未连接账号时，provider 登录入口判定会晚于 workspace 恢复。
    // 如果这里先恢复 workspace，ChatView mount 会触发草稿 session 预热并在登录页背后报错。
    restoreSession: restoreSession && canRestoreWorkspaceSession,
    persistSession: restoreSession && canRestoreWorkspaceSession,
    persistenceGate: workspacePersistenceGate,
    restorePersistedSession,
    buildPersistPatch: buildPersistedTabPatch,
  });

  useEffect(() => {
    if (!isDesktop || !hasCompletedFullRestore) return;
    // Bug 原因：active-first 的单 workspace 只是 Renderer 首屏投影，若立刻对外同步，
    // 会短暂撤销其他 workspace 的 telemetry scope。完整补齐后才能发布全量集合。
    reconcileConversationTelemetryWorkspaceScopes(
      windowWorkspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      })),
    );
  }, [hasCompletedFullRestore, isDesktop, windowWorkspaceTabs]);

  return { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore };
}
