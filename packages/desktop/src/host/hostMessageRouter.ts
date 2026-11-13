import { ICuaPipSessionService } from "@zcode/services";
import { HostMessageTypes, formatZodError } from "@zcode/shared";
import {
  handleCronRunMessage,
  handleOffPeakRunMessage,
  handleProviderProvisioningExecuteMessage,
  handleSessionMessageDeliverMessage,
  handleSessionMessageDeliveryResultMessage,
} from "./hostAutomationMessages.js";
import { parseHostIncomingMessageEvent } from "./hostMessagePortGuard.js";
import {
  resolveFeedbackLogArchiveRequest,
  resolveLocalMediaPreviewPathAuthorization,
  logger,
} from "./hostProcessLogging.js";
import {
  browserControlMainBridge,
  hostNetworkCapture,
  pluginSandboxRegistrationBridge,
} from "./hostProcessBridges.js";
import { disposeHostResources } from "./hostShutdown.js";
import { hostResourceUsageResponder } from "./hostSourceServices.js";
import { hostState } from "./hostState.js";
import {
  handleAttachServicePort,
  handleBindRemoteWorkspaceContext,
  handleCancelRemoteWorkspaceBind,
  handleCancelRemoteWorkspaceConnect,
  handleConnectRemoteWorkspace,
  handleDetachServicePort,
  handleDisposeRemoteWorkspaceSession,
  handlePrepareProjectWorkspace,
} from "./hostWorkspaceMessages.js";
import { initializeLocalHost } from "./hostLocalInit.js";

/** main → Host 消息唯一入口；分支顺序与既有协议处理顺序保持一致。 */
export async function routeHostMessage(e: Electron.MessageEvent): Promise<void> {
  const result = parseHostIncomingMessageEvent(e);
  if (!result.success) {
    logger.error("invalid parentPort message:", formatZodError(result.error));
    return;
  }

  const msg = result.data;
  // 在任何 await 之前同步赋值：InitLocal 与变更消息同端口按序到达，初值不会覆盖较新的变更。
  if (msg.type === HostMessageTypes.InitLocal && msg.locale) {
    hostState.applicationLocale = msg.locale;
  }
  if (msg.type === HostMessageTypes.ApplicationLocaleChanged) {
    hostState.applicationLocale = msg.locale;
    return;
  }
  if (msg.type === HostMessageTypes.NetworkCapture) {
    hostNetworkCapture.setCaptureId(msg.control.captureId);
    return;
  }
  const port = e.ports[0];
  if (msg.type === HostMessageTypes.DatabaseStartupControl) {
    if (msg.control.action === "snapshot") hostState.databaseStartup?.coordinator.publish();
    else if (msg.control.action === "retry")
      void hostState.databaseStartup?.coordinator.retry(msg.control.attemptId);
    return;
  }

  if (msg.type === HostMessageTypes.PrepareProjectWorkspace) {
    handlePrepareProjectWorkspace(msg);
    return;
  }

  if (msg.type === HostMessageTypes.CuaPipFocusChanged) {
    const service = hostState.activeServices?.getOptional(ICuaPipSessionService);
    if (service) {
      void service.publishFocus(msg.event);
    } else {
      // 取不到服务时过去静默丢弃，focus-changed 于是从链路上凭空消失
      // （dev 实测 0 条，正式包同期 92 条）。补这条才能把「main 没发」与
      // 「host 收到了但服务没注册」分开。
      logger.warn("[cua-pip-session] focus event dropped: service unavailable");
    }
    return;
  }

  if (msg.type === HostMessageTypes.ResourceUsageSnapshotRequest) {
    void hostResourceUsageResponder.handleRequest(msg);
    return;
  }
  if (msg.type === HostMessageTypes.ResourceUsageSnapshotCancel) {
    hostResourceUsageResponder.cancelRequest(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.FeedbackLogArchiveResult) {
    resolveFeedbackLogArchiveRequest(msg);
    return;
  }

  if (msg.type === HostMessageTypes.LocalMediaPreviewPathAuthorizeResult) {
    resolveLocalMediaPreviewPathAuthorization(msg);
    return;
  }

  if (msg.type === HostMessageTypes.PluginSandboxRegisterResult) {
    pluginSandboxRegistrationBridge.accept(msg);
    return;
  }

  if (msg.type === HostMessageTypes.CronRun) {
    handleCronRunMessage(msg);
    return;
  }

  if (msg.type === HostMessageTypes.OffPeakRun) {
    handleOffPeakRunMessage(msg);
    return;
  }

  if (msg.type === HostMessageTypes.BrowserExecuteResult) {
    // main 的 WebContentsView+CDP 执行完 browser 命令，按 requestId 关联回 bridge 的 pending。
    void browserControlMainBridge.handleResult({
      requestId: msg.requestId,
      result: msg.result,
    });
    return;
  }

  if (msg.type === HostMessageTypes.Dispose) {
    // main 进程通知清理（窗口关闭 / app 退出时）
    // 这里必须等待统一资源清理完成（含异步收尾写回），再让进程退出；main 侧仍有强杀 timer 兜底。
    const result = await disposeHostResources("parent dispose");
    process.exit(result.exitCode);
    return;
  }

  if (msg.type === HostMessageTypes.Broadcast) {
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliver) {
    handleSessionMessageDeliverMessage(msg);
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliveryResult) {
    handleSessionMessageDeliveryResultMessage(msg);
    return;
  }

  if (msg.type === HostMessageTypes.ProviderProvisioningExecute) {
    handleProviderProvisioningExecuteMessage(msg);
    return;
  }

  if (msg.type === HostMessageTypes.ConnectRemoteWorkspace) {
    handleConnectRemoteWorkspace(msg);
    return;
  }

  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceConnect) {
    handleCancelRemoteWorkspaceConnect(msg);
    return;
  }

  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceBind) {
    handleCancelRemoteWorkspaceBind(msg);
    return;
  }

  if (msg.type === HostMessageTypes.BindRemoteWorkspaceContext) {
    handleBindRemoteWorkspaceContext(msg);
    return;
  }

  if (msg.type === HostMessageTypes.DisposeRemoteWorkspaceSession) {
    handleDisposeRemoteWorkspaceSession(msg);
    return;
  }

  if (msg.type === HostMessageTypes.AttachServicePort) {
    await handleAttachServicePort(msg, port);
    return;
  }

  if (msg.type === HostMessageTypes.DetachServicePort) {
    handleDetachServicePort(msg);
    return;
  }

  if (!port) {
    return;
  }

  if (msg.type === HostMessageTypes.InitLocal) {
    await initializeLocalHost(msg, port);
  }
}
