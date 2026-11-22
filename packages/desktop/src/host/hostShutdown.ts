import { flushHostE2ECoverage } from "./e2eCoverage.js";
import {
  closeOffPeakTaskRepo,
  disposeOffPeakRunSubscriptions,
  disposeOffPeakRuntimeOwner,
} from "./hostOffPeakDispatch.js";
import { closeCronAutomationRepo, disposeCronRunSubscriptions } from "./hostCronDispatch.js";
import { disposeAttachedServicePorts } from "./hostAttachmentRuntime.js";
import { logger } from "./hostProcessLogging.js";
import { hostNetworkCapture, pluginSandboxRegistrationBridge } from "./hostProcessBridges.js";
import { disposeLocalResourceTelemetry } from "./hostSourceServices.js";
import { hostState, remoteRegistry, controllerRuntime } from "./hostState.js";
import { stopHostNetworkTelemetry } from "./hostNetworkTelemetry.js";
import { runHostShutdownPhases, type HostShutdownResult } from "./hostShutdownPhases.js";
import { createHostUncaughtExceptionHandler } from "./hostUncaughtExceptionGuard.js";
import { disposeServiceResources, disposeServiceResourcesAndWait } from "@zcode/services/node";

export async function disposeHostResources(reason: string): Promise<HostShutdownResult> {
  hostState.databaseStartup?.dispose();
  hostState.pendingStartupAttachments.clear();
  if (hostState.hasDisposedHostResources) {
    return (
      (await hostState.disposeHostResourcesInFlight) ?? {
        exitCode: 0,
        failedPhases: [],
        timedOutPhases: [],
      }
    );
  }
  hostState.hasDisposedHostResources = true;
  for (const controller of hostState.projectNavigationAbortControllers.values()) controller.abort();
  hostState.projectNavigationAbortControllers.clear();

  hostState.disposeHostResourcesInFlight = (async () => {
    logger.info(`disposing host resources, reason=${reason}`);

    pluginSandboxRegistrationBridge.dispose();
    stopHostNetworkTelemetry();
    hostNetworkCapture.setCaptureId(null);
    hostState.hostSelfResourceTelemetry?.stop();
    disposeLocalResourceTelemetry();
    disposeAttachedServicePorts();
    controllerRuntime().dispose();
    disposeCronRunSubscriptions();
    closeCronAutomationRepo();
    disposeOffPeakRunSubscriptions();
    disposeOffPeakRuntimeOwner();
    closeOffPeakTaskRepo();

    const servicesToDispose = hostState.activeServices;
    hostState.activeServices = null;
    // Registry 是全部远端 connection 的唯一 owner；释放失败不能阻塞本地服务继续收口。
    const shutdownResult = await runHostShutdownPhases(
      [
        {
          name: "remote-registry-dispose",
          run: () => remoteRegistry().dispose(),
          timeoutMs: 6_000,
        },
        {
          name: "source-server-manager-dispose",
          run: async () => {
            hostState.sourceServerConnectionManager?.dispose();
            hostState.sourceServerManagementService?.dispose();
            hostState.sourceSettingsStateSubscription?.dispose();
            hostState.sourceServerConnectionManager = null;
            hostState.sourceServerManagementService = null;
            hostState.sourceSettingsStateSubscription = null;
            hostState.sourceServerDirectory = null;
          },
          timeoutMs: 2_000,
        },
        ...(servicesToDispose
          ? [
              {
                name: "service-dispose",
                run: () => disposeServiceResourcesAndWait(servicesToDispose),
                timeoutMs: 3_500,
              },
            ]
          : []),
      ],
      {
        phaseTimeoutMs: 5_000,
        log: (message, details) => logger.warn(message, details),
      },
    );
    if (shutdownResult.exitCode !== 0) {
      logger.warn("host resource cleanup completed with errors", {
        failedPhases: shutdownResult.failedPhases,
        reason,
        timedOutPhases: shutdownResult.timedOutPhases,
      });
    }
    hostState.activeHostApiNetworkTransport = null;
    return shutdownResult;
  })();

  const shutdownResult = await hostState.disposeHostResourcesInFlight;
  flushHostE2ECoverage((error) => {
    logger.warn("[e2e-coverage] host coverage flush failed", error);
  });
  return shutdownResult;
}

export function disposeHostResourcesBestEffort(reason: string): void {
  if (hostState.hasDisposedHostResources) {
    return;
  }
  hostState.hasDisposedHostResources = true;

  logger.info(`disposing host resources, reason=${reason}`);
  pluginSandboxRegistrationBridge.dispose();
  stopHostNetworkTelemetry();
  hostNetworkCapture.setCaptureId(null);
  disposeLocalResourceTelemetry();
  disposeAttachedServicePorts();
  controllerRuntime().dispose();
  disposeCronRunSubscriptions();
  closeCronAutomationRepo();
  disposeOffPeakRunSubscriptions();
  disposeOffPeakRuntimeOwner();
  closeOffPeakTaskRepo();
  void remoteRegistry().dispose();

  if (hostState.activeServices) {
    try {
      disposeServiceResources(hostState.activeServices);
    } catch (error) {
      logger.error("failed to dispose local services:", error);
    } finally {
      hostState.activeServices = null;
      hostState.activeHostApiNetworkTransport = null;
    }
  }
}

/** SIGTERM/SIGINT/disconnect/exit 与致命异常都收敛到同一有界 shutdown。 */
export function installHostProcessGuards(): void {
  process.once("SIGTERM", () => {
    void disposeHostResources("SIGTERM").then(
      (result) => process.exit(result.exitCode),
      () => process.exit(1),
    );
  });

  process.once("SIGINT", () => {
    void disposeHostResources("SIGINT").then(
      (result) => process.exit(result.exitCode),
      () => process.exit(1),
    );
  });

  process.once("disconnect", () => {
    // parent IPC 消失后不会再有人发送 Dispose；有界清理结束后必须明确退出，避免 Host 常驻。
    void disposeHostResources("disconnect").finally(() => process.exit(1));
  });

  process.once("exit", () => {
    disposeHostResourcesBestEffort("exit");
  });

  let handlingFatalUncaughtException = false;
  process.on(
    "uncaughtException",
    createHostUncaughtExceptionHandler({
      onRecovered: (error, origin) => {
        const memoryUsage = process.memoryUsage();
        logger.warn("contained host allocation failure from native TLS callback", {
          arrayBuffers: memoryUsage.arrayBuffers,
          external: memoryUsage.external,
          heapUsed: memoryUsage.heapUsed,
          message: error.message,
          origin,
          rss: memoryUsage.rss,
        });
      },
      onFatal: (error, origin) => {
        if (handlingFatalUncaughtException) {
          process.exit(1);
        }
        handlingFatalUncaughtException = true;
        logger.error(`uncaughtException origin=${origin}:`, error);
        void disposeHostResources(`uncaughtException:${origin}`).finally(() => process.exit(1));
      },
    }),
  );
}
