import type { ZCodeAgentServiceClientAccessHelpers } from "./zcodeAgentServiceClientAccess.js";
import type { ZCodeAgentServiceAccountHelpers } from "./zcodeAgentServiceAccountHelpers.js";
import type { ZCodeAgentServiceRequestHandlersA } from "./zcodeAgentServiceRequestHandlersA.js";
import type { ZCodeAgentServiceRequestHandlersB } from "./zcodeAgentServiceRequestHandlersB.js";
import type { ZCodeAgentServiceRequestHandlersC } from "./zcodeAgentServiceRequestHandlersC.js";
import type { ZCodeAgentServiceSessionHelpers } from "./zcodeAgentServiceSessionHelpers.js";
import type { ZCodeAgentServiceState } from "./zcodeAgentServiceState.js";
import type { ZCodeAgentServiceWireHelpers } from "./zcodeAgentServiceWireClient.js";

export type ZCodeAgentServiceRuntime = ZCodeAgentServiceState &
  ZCodeAgentServiceSessionHelpers &
  ZCodeAgentServiceAccountHelpers &
  ZCodeAgentServiceRequestHandlersA &
  ZCodeAgentServiceRequestHandlersB &
  ZCodeAgentServiceRequestHandlersC &
  ZCodeAgentServiceWireHelpers &
  ZCodeAgentServiceClientAccessHelpers;
