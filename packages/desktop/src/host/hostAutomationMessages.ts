import { HostMessageTypes, HostResponseTypes, type ZCodeTaskMode } from "@zcode/shared";
import { IZCodeTaskService } from "@zcode/services";
import { OffPeakPermanentDispatchError } from "@zcode/services/node";
import { buildRemoteEnvironmentKey } from "@zcode/shared";
import { dispatchCronRun } from "./hostCronDispatch.js";
import { logger } from "./hostProcessLogging.js";
import { dispatchOffPeakRun } from "./hostOffPeakDispatch.js";
import type { HostIncomingMessage } from "./hostMessagePortGuard.js";
import { hostState, remoteRegistry } from "./hostState.js";
import { getRemoteProviderProvisioningExecutor } from "./remoteProviderProvisioningService.js";

const { parentPort } = process;

type CronRunMessage = Extract<HostIncomingMessage, { type: typeof HostMessageTypes.CronRun }>;
type OffPeakRunMessage = Extract<HostIncomingMessage, { type: typeof HostMessageTypes.OffPeakRun }>;
type SessionMessageDeliverMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.SessionMessageDeliver }
>;
type SessionMessageDeliveryResultMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.SessionMessageDeliveryResult }
>;
type ProviderProvisioningExecuteMessage = Extract<
  HostIncomingMessage,
  { type: typeof HostMessageTypes.ProviderProvisioningExecute }
>;

export function handleCronRunMessage(msg: CronRunMessage): void {
  if (hostState.databaseStartup?.coordinator.snapshot.phase !== "ready") {
    parentPort.postMessage({
      type: HostResponseTypes.CronRunResult,
      runId: msg.runId,
      ok: false,
      error: "Local database startup is not ready",
      failureKind: "transient",
    });
    return;
  }
  void (async () => {
    try {
      const dispatchResult = await dispatchCronRun({
        ...msg,
        mode: msg.mode as ZCodeTaskMode | undefined,
      });
      parentPort.postMessage({
        type: HostResponseTypes.CronRunResult,
        runId: msg.runId,
        ok: true,
        ...dispatchResult,
      });
    } catch (error) {
      parentPort.postMessage({
        type: HostResponseTypes.CronRunResult,
        runId: msg.runId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        failureKind: "transient",
      });
    }
  })();
  return;
}

export function handleOffPeakRunMessage(msg: OffPeakRunMessage): void {
  if (hostState.databaseStartup?.coordinator.snapshot.phase !== "ready") {
    parentPort.postMessage({
      type: HostResponseTypes.OffPeakRunResult,
      offPeakTaskId: msg.offPeakTaskId,
      ok: false,
      error: "Local database startup is not ready",
      failureKind: "transient",
    });
    return;
  }
  void (async () => {
    try {
      const dispatchResult = await dispatchOffPeakRun(msg);
      parentPort.postMessage({
        type: HostResponseTypes.OffPeakRunResult,
        offPeakTaskId: msg.offPeakTaskId,
        ok: true,
        ...dispatchResult,
      });
    } catch (error) {
      parentPort.postMessage({
        type: HostResponseTypes.OffPeakRunResult,
        offPeakTaskId: msg.offPeakTaskId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        // 确定性模型/凭证配置错误重试不会自愈；交给 scheduler 转 failed，
        // 未知及生命周期错误仍按 transient 保持原退避语义。
        failureKind: error instanceof OffPeakPermanentDispatchError ? "permanent" : "transient",
      });
    }
  })();
  return;
}

export function handleSessionMessageDeliverMessage(msg: SessionMessageDeliverMessage): void {
  const zcodeTaskService = hostState.activeServices?.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    parentPort.postMessage({
      type: HostResponseTypes.SessionMessageDeliverResult,
      result: {
        error: "ZCode task service is not initialized.",
        messageId: msg.request.messageId,
        requestId: msg.request.requestId,
        sessionId: msg.request.fromSessionId,
        status: "failed",
      },
    });
    return;
  }

  void zcodeTaskService
    .deliverSessionMessage(msg.request)
    .then((deliveryResult) => {
      parentPort.postMessage({
        type: HostResponseTypes.SessionMessageDeliverResult,
        result: deliveryResult,
      });
    })
    .catch((error) => {
      parentPort.postMessage({
        type: HostResponseTypes.SessionMessageDeliverResult,
        result: {
          error: error instanceof Error ? error.message : String(error),
          messageId: msg.request.messageId,
          requestId: msg.request.requestId,
          sessionId: msg.request.fromSessionId,
          status: "failed",
        },
      });
    });
  return;
}

export function handleSessionMessageDeliveryResultMessage(
  msg: SessionMessageDeliveryResultMessage,
): void {
  const zcodeTaskService = hostState.activeServices?.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    logger.warn("session message delivery result received before ZCode task service initialized");
    return;
  }
  void zcodeTaskService.sendSessionMessageDeliveryResult(msg.result).catch((error) => {
    logger.warn("failed to forward session message delivery result:", error);
  });
  return;
}

export function handleProviderProvisioningExecuteMessage(
  msg: ProviderProvisioningExecuteMessage,
): void {
  const session = remoteRegistry().getSession(msg.remoteSessionId);
  if (
    !session ||
    !session.workspaceIdentity ||
    buildRemoteEnvironmentKey(session.target) !== msg.environmentKey
  ) {
    parentPort.postMessage({
      type: HostResponseTypes.ProviderProvisioningExecutionResult,
      requestId: msg.requestId,
      environmentKey: msg.environmentKey,
      status: "failed",
      error: "Remote Environment registration 已失效",
      errorCode: "session-unavailable",
    });
    return;
  }
  const scope = {
    kind: "remote",
    remoteSessionId: session.remoteSessionId,
    workspacePath: session.workspacePath ?? "/",
    workspaceIdentity: session.workspaceIdentity,
  } as const;
  void Promise.resolve()
    .then(() =>
      (() => {
        const provisioningService = getRemoteProviderProvisioningExecutor(
          remoteRegistry().resolveScopedServices(scope),
        );
        if (!provisioningService) {
          throw new Error("Remote Environment 不支持 Provider Provisioning");
        }
        return provisioningService.syncLocalToRemote();
      })(),
    )
    .then((result) => {
      parentPort.postMessage({
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: msg.requestId,
        environmentKey: msg.environmentKey,
        status: result.status,
        ...(result.errorMessage ? { error: result.errorMessage } : {}),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      });
    })
    .catch((error: unknown) => {
      parentPort.postMessage({
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: msg.requestId,
        environmentKey: msg.environmentKey,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        errorCode: "host-execution-failed",
      });
    });
  return;
}
