import type { CodeIntelligencePort } from "@zcode/contracts";
import {
  zcodeCodeIndexQueryResultSchema,
  zcodeProtocolEmptyResultSchema,
  zcodeProtocolMethods,
  zcodeCodeIndexQueryTimeoutMs,
  type ZCodeCodeIndexQuery,
} from "@zcode/shared";
import {
  protocolTraceFromTraceContext,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/**
 * Порт кодового индекса для CLI-сессии.
 *
 * Помимо запросов он умеет сообщать о зафиксированных путях: Host владеет индексом, поэтому
 * сигнал идёт отдельным RPC-вызовом `code-index/notify-mutated`, а не прямой записью в SQLite.
 * Второго пути записи нет — Host направляет пути в тот же инкрементальный проход.
 */
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
    async notifyFilesMutated(request) {
      request.signal?.throwIfAborted();
      const changed = (request.changed ?? []).filter((path) => path.length > 0).slice(0, 4000);
      const removed = (request.removed ?? []).filter((path) => path.length > 0).slice(0, 4000);
      if (changed.length === 0 && removed.length === 0) return;
      await context.requestClient(
        zcodeProtocolMethods.codeIndexNotifyMutated,
        { sessionId, workspacePath: request.workspacePath, changed, removed },
        zcodeProtocolEmptyResultSchema,
        {
          ...(request.signal ? { signal: request.signal } : {}),
          timeoutMs: zcodeCodeIndexQueryTimeoutMs,
        },
      );
    },
  };
}
