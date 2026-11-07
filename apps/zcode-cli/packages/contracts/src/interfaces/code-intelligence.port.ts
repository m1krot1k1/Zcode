import type { ZCodeCodeIndexQuery, ZCodeCodeIndexResult } from "@zcode/shared";
import type { TraceContext } from "../tracing/tracer.js";

/** Read-only code-index queries are routed to the workspace's owning Host. */
export interface CodeIntelligencePort {
  query(
    request: ZCodeCodeIndexQuery,
    context: { signal: AbortSignal; trace?: TraceContext },
  ): Promise<ZCodeCodeIndexResult>;
}
