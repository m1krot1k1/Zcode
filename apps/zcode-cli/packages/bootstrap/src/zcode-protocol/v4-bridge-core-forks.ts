// coreHost 分叉面：selection side chat、running stable fork、editUserQuery 前分叉
// 与 bundle 提交后的失败记录。分叉点判定与 persistent 事实写入都在 fork 域。
import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SessionEventType,
  createSessionId,
  type SessionId,
  type StableForkGoalBoundaryMetadata,
} from "@zcode/contracts";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import { cloneModelSelection, derivedSessionModelSelection } from "./fork-model-selection.js";
import {
  buildForkInitialInput,
  recordForkStartFailureBestEffort,
  registerCommittedForkBestEffort,
  stableForkMode,
} from "./v4-bridge-fork.js";
import { resolveInputCommandForAdmission } from "./v4-bridge-admission.js";
import type { BridgeState } from "./v4-bridge-state.js";

export function createForksCoreHost(
  state: BridgeState,
): Pick<
  V4CommandCoreHost,
  | "createSelectionSideSession"
  | "forkStableConversation"
  | "forkConversationBeforeInput"
  | "recordForkStartFailure"
> {
  const { context } = state;
  return {
    createSelectionSideSession: async (sessionId, options) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const modelSelection = cloneModelSelection(
        options.modelSelection ?? record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.createSelectionSideConversation({
        modelSelection,
        sourceCommandId: options.sourceCommandId,
        revisionAtDecision: options.revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: options.sourceCommandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
          followupMode: context.v4Gateway?.getSessionFollowupMode(sessionId) ?? "queue",
        },
        inheritLatestTarget: false,
      });
      return { sessionId: String(fork.forkedSessionId) };
    },
    // running stable fork：只走 core transcript copy，再注册 child record。父 runtime、queue、
    // background/continuation inbox 与 shared workspace 均不读取、不停止、不复制。
    forkStableConversation: async (sessionId, options) => {
      const { goalBoundary, revisionAtDecision, sourceCommandId, target } = options;
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      const boundary = messages.find(
        (message) => String(message.info.id) === target.boundaryMessageId,
      );
      if (boundary?.info.role !== "assistant") {
        throw new Error("guard.forkTargetAmbiguous");
      }
      // 分叉继承分叉点的会话选型；加速轮消息记录的是单轮执行 Selection，必须跳过后退回父会话常驻选型。
      const modelSelection = derivedSessionModelSelection(
        boundary.info.providerId && boundary.info.modelId
          ? {
              providerId: boundary.info.providerId,
              modelId: boundary.info.modelId,
              ...(boundary.info.reasoningLevel
                ? { options: { reasoningLevel: boundary.info.reasoningLevel } }
                : {}),
            }
          : undefined,
        record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.forkStableConversationAtMessage({
        modelSelection,
        target,
        goalBoundary,
        sourceCommandId,
        revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: sourceCommandId,
        runtimeConfig: {
          mode: stableForkMode(boundary.info.mode, record.app.getMode()),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        // core 已按 copied message/verifier 边界复制 goal；禁止再用 parent 当前 target 覆盖。
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    forkConversationBeforeInput: async (sessionId, { editTarget, envelope, admission }) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({
        sessionID: sessionId as SessionId,
      });
      const targetMessage = messages.find(
        (message) => String(message.info.id) === editTarget.transcriptMessageId,
      );
      if (targetMessage?.info.role !== "user") {
        throw new Error("guard.latestQueryEditOnly");
      }
      const modelSelection = derivedSessionModelSelection(
        targetMessage.info.modelSelection,
        record.app.runtime.getSessionModelSelection(),
      );
      const events = await record.eventStore.getEvents(sessionId as SessionId);
      const targetStarted = events.find(
        (event) =>
          event.type === SessionEventType.TurnStarted &&
          String((event.payload as { messageId?: unknown }).messageId ?? "") ===
            editTarget.transcriptMessageId,
      );
      const priorTargetChange = targetStarted
        ? events
            .filter(
              (event) =>
                event.sequenceNumber < targetStarted.sequenceNumber &&
                event.type === SessionEventType.TargetChanged,
            )
            .at(-1)
        : undefined;
      const forkedSessionId = String(createSessionId());
      const input = resolveInputCommandForAdmission(
        envelope,
        forkedSessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) throw new Error("fault.command.forkInputAdmissionMissing");
      const initialInput = buildForkInitialInput(envelope, forkedSessionId, admission, input);
      let goalBoundary: StableForkGoalBoundaryMetadata | null = priorTargetChange
        ? (() => {
            const target = (priorTargetChange.payload as { target?: unknown }).target;
            return target
              ? {
                  kind: "snapshot" as const,
                  target: target as Extract<
                    StableForkGoalBoundaryMetadata,
                    { kind: "snapshot" }
                  >["target"],
                  verificationEntryIds: [],
                }
              : { kind: "none" as const };
          })()
        : null;
      if (goalBoundary?.kind === "snapshot" && store.sessionEntries && targetStarted) {
        const targetId = goalBoundary.target.targetID;
        const boundaryTime = targetStarted.timestamp.getTime();
        const entries = await store.sessionEntries({
          sessionID: sessionId as SessionId,
          type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        });
        goalBoundary = {
          ...goalBoundary,
          verificationEntryIds: entries.flatMap((entry) => {
            const data = entry.data as { payload?: { targetId?: unknown } };
            return entry.time.updated <= boundaryTime && data.payload?.targetId === targetId
              ? [entry.id]
              : [];
          }),
        };
      }
      if (!goalBoundary) {
        const targetIndex = messages.indexOf(targetMessage);
        const previousAssistant = messages
          .slice(0, targetIndex)
          .reverse()
          .find((message) => message.info.role === "assistant");
        goalBoundary = previousAssistant?.info.anchor?.goalBoundary ?? null;
        if (!previousAssistant) goalBoundary = { kind: "none" };
      }
      if (!goalBoundary) {
        throw new Error("guard.forkTargetAmbiguous");
      }
      const fork = await record.app.runtime.forkConversationBeforeMessage({
        modelSelection,
        forkedSessionId: forkedSessionId as SessionId,
        targetMessageId: targetMessage.info.id,
        targetProductTurnId: editTarget.productTurnId,
        targetTranscriptTurnId: String(
          targetMessage.info.anchor?.turnId ?? editTarget.productTurnId,
        ),
        sourceCommandId: envelope.commandId,
        initialInput,
        commandFact: {
          parentSessionId: sessionId,
          sourceCommandId: envelope.commandId,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: envelope.baseRevision ?? 0,
            result: {
              type: "editUserQuery",
              disposition: "fork",
              sessionId: forkedSessionId,
            },
          },
          metadata: {
            parentSessionId: sessionId,
            sourceCommandId: envelope.commandId,
            editTarget,
          },
        },
        // 严格取 TurnStarted 之前的 TargetChanged 或上一稳定 assistant anchor；禁止
        // 把 parent 当前（可能正由被编辑 goal 写入）的 target 冒充 input 前状态。
        goalBoundary,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: envelope.commandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    recordForkStartFailure: async (sessionId, envelope, error) => {
      await recordForkStartFailureBestEffort(context, sessionId, envelope, error, {
        parentSessionId: String(envelope.sessionId ?? ""),
      });
    },
  };
}
