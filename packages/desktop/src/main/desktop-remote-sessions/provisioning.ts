import { randomUUID } from "node:crypto";
import { HostMessageTypes, type ProviderProvisioningTrigger } from "@zcode/shared";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import type { RemoteSessionsContext } from "./types.js";

export function createProviderProvisioningExecution(ctx: RemoteSessionsContext) {
  function executeProviderProvisioning(
    child: ElectronUtilityProcess,
    remoteSessionId: string,
    environmentKey: string,
    trigger: ProviderProvisioningTrigger,
  ): Promise<void> {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      ctx.state.pendingProviderProvisioningExecutions.set(requestId, {
        child,
        trigger,
        startedAtMonotonicMs: ctx.monotonicNowMs(),
        resolve,
        reject,
      });
      try {
        child.postMessage({
          type: HostMessageTypes.ProviderProvisioningExecute,
          requestId,
          environmentKey,
          remoteSessionId,
          trigger,
        });
      } catch (error) {
        ctx.state.pendingProviderProvisioningExecutions.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return { executeProviderProvisioning };
}
