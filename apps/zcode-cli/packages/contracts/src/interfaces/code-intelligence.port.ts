import type { ZCodeCodeIndexQuery, ZCodeCodeIndexResult } from "@zcode/shared";
import type { TraceContext } from "../tracing/tracer.js";

/** Read-only code-index queries are routed to the workspace's owning Host. */
export interface CodeIntelligencePort {
  query(
    request: ZCodeCodeIndexQuery,
    context: { signal: AbortSignal; trace?: TraceContext },
  ): Promise<ZCodeCodeIndexResult>;

  /**
   * Signals exact workspace-relative paths that changed or disappeared.
   *
   * Optional so existing hosts keep working. When present, the Host routes the paths into the
   * same incremental pass the watcher uses (no duplicate indexing path), which closes the gap
   * between a committed file transaction and the debounced filesystem event.
   */
  notifyFilesMutated?(request: {
    workspacePath: string;
    workspaceIdentity?: string;
    changed?: string[];
    removed?: string[];
    signal?: AbortSignal;
  }): Promise<void>;
}
