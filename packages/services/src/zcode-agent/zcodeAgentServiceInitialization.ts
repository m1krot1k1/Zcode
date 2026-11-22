import { createProviderReadinessSnapshotFromSelectionView } from "./zcodeAgentServiceParams.js";
import { logger } from "./zcodeAgentServiceSupport.js";
import type { ZCodeAgentServiceRuntime } from "./zcodeAgentServiceRuntime.js";

export function initializeZCodeAgentService(ctx: ZCodeAgentServiceRuntime): void {
  const {
    accountProviderConfigSource,
    activeClientsByWorkspaceKey,
    clearV4SubscriptionRoutes,
    cuaOperationTurnTracker,
    forgetWorkspaceSessions,
    handleAccountProviderConfigChanged,
    handleProviderReadinessChanged,
    handleRuntimeProviderCatalogChanged,
    invalidateWorkspaceClient,
    modelSelectionReadinessSource,
    mutable,
    processManager,
    runtimeProviderCatalogSource,
  } = ctx;
  mutable.v4RouteRuntimeRestartDisposable = processManager.onRuntimeRestarted(
    ({ workspaceKey }) => {
      clearV4SubscriptionRoutes(workspaceKey);
      cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
    },
  );
  mutable.runtimeLifecycleDisposable = processManager.onRuntimeLifecycle((event) => {
    if (event.state !== "unavailable") return;
    // 协议关闭、进程崩溃或请求超时时，runtime 可能不会再发送 turn-failed/
    // session-closed，也不一定能成功启动下一代 runtime。必须在 unavailable 这个权威
    // 生命周期边界清掉 CUA tracker，否则 Windows 顶部提示和 Helper 恢复门控会永久残留。
    cuaOperationTurnTracker?.clearWorkspaceKey(event.workspaceKey);
    // Bug 原因：runtime 退出后事件序号/去重/trace 镜像只属于已死进程；不清理会让
    // 重连后的会话继承旧 seq 基线，同时把已关闭会话的 emitter 永久留在 Host 内存。
    forgetWorkspaceSessions(event.workspaceKey);
    const active = activeClientsByWorkspaceKey.get(event.workspaceKey);
    if (!active) return;
    // Process manager 只会为当前 available runtime 发布 unavailable；这里再绑定当前
    // active client 做第二层 identity guard，避免旧 runtime 的迟到回收误伤换代结果。
    invalidateWorkspaceClient(event.workspaceKey, active.client);
  });
  mutable.modelSelectionSubscription = modelSelectionReadinessSource?.onDidChange?.((view) => {
    void handleProviderReadinessChanged({
      reason: "model_selection_changed",
      snapshot: createProviderReadinessSnapshotFromSelectionView(view),
    }).catch((error) => {
      logger.warn(undefined, "model selection readiness 热同步失败", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  mutable.accountProviderConfigUnsubscribe = accountProviderConfigSource?.onDidChange((reason) => {
    void handleAccountProviderConfigChanged(reason).catch((error) => {
      logger.warn(undefined, "account provider config 热同步失败", {
        message: error instanceof Error ? error.message : String(error),
        reason,
      });
    });
  });
  mutable.runtimeProviderCatalogUnsubscribe = runtimeProviderCatalogSource?.onDidChange(
    (reason) => {
      void handleRuntimeProviderCatalogChanged(reason).catch((error) => {
        logger.warn(undefined, "OpenCode runtime provider catalog 热同步失败", {
          message: error instanceof Error ? error.message : String(error),
          reason,
        });
      });
    },
  );
}
