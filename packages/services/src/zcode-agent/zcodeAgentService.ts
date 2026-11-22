import type { IZCodeAgentService } from "./zcodeAgent.js";
import type { CreateZCodeAgentServiceOptions } from "./zcodeAgentServiceParams.js";
import type { ZCodeAgentServiceRuntime } from "./zcodeAgentServiceRuntime.js";
import { createAccountHelpers } from "./zcodeAgentServiceAccountHelpers.js";
import { createClientAccessHelpers } from "./zcodeAgentServiceClientAccess.js";
import { initializeZCodeAgentService } from "./zcodeAgentServiceInitialization.js";
import { createRequestHandlersA } from "./zcodeAgentServiceRequestHandlersA.js";
import { createRequestHandlersB } from "./zcodeAgentServiceRequestHandlersB.js";
import { createRequestHandlersC } from "./zcodeAgentServiceRequestHandlersC.js";
import { createSessionHelpers } from "./zcodeAgentServiceSessionHelpers.js";
import { createZCodeAgentServiceState } from "./zcodeAgentServiceState.js";
import { createWireClientHelpers } from "./zcodeAgentServiceWireClient.js";
import { createWorkspaceMethods } from "./zcodeAgentServiceWorkspaceMethods.js";
import { createMcpMethods } from "./zcodeAgentServiceMcpMethods.js";
import { createPluginMethods } from "./zcodeAgentServicePluginMethods.js";
import { createSessionMethods } from "./zcodeAgentServiceSessionMethods.js";
import { createV4Methods } from "./zcodeAgentServiceV4Methods.js";

export {
  resolveOffPeakAllowedModels,
  resolveOffPeakCreateModel,
  resolveOffPeakToolSelection,
  toProtocolOffPeakTaskSnapshot,
} from "./zcodeAgentServiceParams.js";
export { supportsLegacyRemoteTaskAllowlist } from "./zcodeAgentServiceSupport.js";

export function createZCodeAgentService(
  options?: CreateZCodeAgentServiceOptions,
): IZCodeAgentService & { disposeAllAndWait(): Promise<void> } {
  const runtime = createZCodeAgentServiceState(options) as ZCodeAgentServiceRuntime;
  Object.assign(runtime, createSessionHelpers(runtime));
  Object.assign(runtime, createAccountHelpers(runtime));
  Object.assign(runtime, createRequestHandlersA(runtime));
  Object.assign(runtime, createRequestHandlersB(runtime));
  Object.assign(runtime, createRequestHandlersC(runtime));
  Object.assign(runtime, createWireClientHelpers(runtime));
  Object.assign(runtime, createClientAccessHelpers(runtime));

  initializeZCodeAgentService(runtime);

  return {
    ...createWorkspaceMethods(runtime),
    ...createMcpMethods(runtime),
    ...createPluginMethods(runtime),
    ...createSessionMethods(runtime),
    ...createV4Methods(runtime),
  };
}
