// coreHost 运行时面：会话注册表窄视图、v4 队列读面、OpenCode delegated run 控制、
// highspeed 队列执行材料驻留与投影提交等待。全部惰性读 context.v4Gateway。
import {
  zcodeOpenCodeAgentRunRequestSchema,
  zcodeOpenCodeAgentRunResultSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import type { SessionId } from "@zcode/contracts";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import type { BridgeState } from "./v4-bridge-state.js";

export function createRuntimeCoreHost(
  state: BridgeState,
): Pick<
  V4CommandCoreHost,
  | "getRecord"
  | "interactions"
  | "logger"
  | "getQueueItem"
  | "hasQueueItemKind"
  | "hasQueuedDelivery"
  | "getQueueLength"
  | "cancelOpenCodeAgentRun"
  | "respondToOpenCodeAgentPermission"
  | "retainQueuedTurnExecution"
  | "readQueuedTurnExecution"
  | "deleteQueuedTurnExecution"
  | "clearQueuedTurnExecutions"
  | "waitForProjectionEventCommit"
> {
  const { context, queuedTurnExecutions } = state;
  return {
    // 同一注册表对象引用：view 是旧 record 的结构化窄视图，字段变更双向可见。
    getRecord: (sessionId) => context.sessions.get(sessionId),
    // 同一登记表实例：broker（旧目录）注册反向请求 deferred，
    // v4 resolveInteraction handler 经此投递应答（v4 原生基础设施，非过渡钩子）。
    interactions: context.v4Interactions,
    logger: {
      info: (message, fields) => context.logger?.info(message, fields),
      warn: (message, fields) => context.logger?.warn(message, fields),
    },
    // v4 原生能力（非过渡钩子）：sendQueuedNow 必须读取 v4 投影里的完整 intent。
    // 命令执行时 context.v4Gateway 已由 server 注入（createConversationV4Gateway
    // 返回值回填），这里惰性取用避免构造期自引用。
    getQueueItem: (sessionId, queueItemId) =>
      context.v4Gateway?.getQueueItem(sessionId, queueItemId) ?? null,
    hasQueueItemKind: (sessionId, kind) =>
      context.v4Gateway?.hasQueueItemKind(sessionId, kind) ?? false,
    hasQueuedDelivery: (sessionId, delivery) =>
      context.v4Gateway?.hasQueuedDelivery(sessionId, delivery) ?? false,
    getQueueLength: (sessionId) => context.v4Gateway?.getQueueLength(sessionId) ?? 0,
    cancelOpenCodeAgentRun: async (sessionId, commandId, runId) => {
      const sessionStore = context.deps.sessionStore;
      if (!sessionStore?.getOpenCodeAgentRun || commandId !== runId) return false;
      const sessionID = sessionId as SessionId;
      const run = await sessionStore.getOpenCodeAgentRun({ sessionID, runID: runId });
      if (
        !run ||
        run.commandID !== commandId ||
        run.runID !== runId ||
        (run.status !== "dispatching" && run.status !== "running")
      ) {
        return false;
      }
      const request = zcodeOpenCodeAgentRunRequestSchema.parse({
        protocolVersion: 1,
        zcodeSessionId: String(sessionID),
        commandId,
        runId,
        operation: "cancelRun",
        ...(run.openCodeSessionID ? { opencodeSessionId: run.openCodeSessionID } : {}),
      });
      const result = await context.requestClient(
        zcodeProtocolMethods.interactionRequestOpenCodeAgentRun,
        request,
        zcodeOpenCodeAgentRunResultSchema,
        { timeoutMs: 30_000 },
      );
      // Host ACK подтверждает только совпавший активный run; terminal ACK означает, что Stop опоздал.
      return (
        result.status === "accepted" ||
        result.status === "starting" ||
        result.status === "running" ||
        result.status === "cancelling" ||
        result.status === "cancelled"
      );
    },
    respondToOpenCodeAgentPermission: async ({
      sessionId,
      commandId,
      runId,
      opencodeSessionId,
      requestId,
      optionId,
    }) => {
      const sessionStore = context.deps.sessionStore;
      if (!sessionStore?.getOpenCodeAgentRun || commandId !== runId) return false;
      const sessionID = sessionId as SessionId;
      const run = await sessionStore.getOpenCodeAgentRun({ sessionID, runID: runId });
      if (
        !run ||
        run.commandID !== commandId ||
        run.runID !== runId ||
        run.openCodeSessionID !== opencodeSessionId ||
        (run.status !== "dispatching" && run.status !== "running")
      ) {
        return false;
      }
      const request = zcodeOpenCodeAgentRunRequestSchema.parse({
        protocolVersion: 1,
        zcodeSessionId: String(sessionID),
        commandId,
        runId,
        operation: "respondToPermission",
        opencodeSessionId,
        requestId,
        optionId,
      });
      const result = await context.requestClient(
        zcodeProtocolMethods.interactionRequestOpenCodeAgentRun,
        request,
        zcodeOpenCodeAgentRunResultSchema,
        { timeoutMs: 30_000 },
      );
      return result.status === "responded";
    },
    retainQueuedTurnExecution: (sessionId, sourceCommandId, execution) => {
      const sessionExecutions = queuedTurnExecutions.get(sessionId) ?? new Map();
      sessionExecutions.set(sourceCommandId, execution);
      queuedTurnExecutions.set(sessionId, sessionExecutions);
    },
    readQueuedTurnExecution: (sessionId, sourceCommandId) =>
      queuedTurnExecutions.get(sessionId)?.get(sourceCommandId),
    deleteQueuedTurnExecution: (sessionId, sourceCommandId) => {
      const sessionExecutions = queuedTurnExecutions.get(sessionId);
      sessionExecutions?.delete(sourceCommandId);
      if (sessionExecutions?.size === 0) queuedTurnExecutions.delete(sessionId);
    },
    clearQueuedTurnExecutions: (sessionId) => {
      queuedTurnExecutions.delete(sessionId);
    },
    waitForProjectionEventCommit: (sessionId, eventId, options) => {
      const gateway = context.v4Gateway;
      if (!gateway) {
        return Promise.reject(new Error("v4 gateway unavailable for projection commit wait"));
      }
      return gateway.waitForProjectionEventCommit(sessionId, eventId, options);
    },
  };
}
