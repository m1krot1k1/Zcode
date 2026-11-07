import type { CodeIntelligencePort } from "@zcode/contracts";
import {
  zcodeCodeIndexQueryResultSchema,
  zcodeProtocolMethods,
  zcodeCodeIndexQueryTimeoutMs,
  type ZCodeCodeIndexQuery,
} from "@zcode/shared";
import {
  protocolTraceFromTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

export function createProtocolCodeIntelligencePort(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): CodeIntelligencePort {
  return {
    query(request, options) {
      options.signal.throwIfAborted();
      return context.requestClient(
        zcodeProtocolMethods.codeIndexQuery,
        { sessionId, ...request } satisfies { sessionId: string } & ZCodeCodeIndexQuery,
        zcodeCodeIndexQueryResultSchema,
        {
          signal: options.signal,
          timeoutMs: zcodeCodeIndexQueryTimeoutMs,
          trace: options.trace ? protocolTraceFromTraceContext(options.trace) : undefined,
        },
      );
    },
  };
}
