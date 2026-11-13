// coreHost 准入面：durable 输入账本写入与取消（含 shared context 导入状态回滚）。
// 复用 v4-bridge-admission 的 canonical intent 构造，不重复推导 delivery。
import { conversationInputIntentSchema } from "@zcode/shared/zcode-protocol-v4";
import type { SessionId, SessionStorePort } from "@zcode/contracts";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import {
  persistOpenCodeAgentRunAdmission,
  resolveInputCommandForAdmission,
} from "./v4-bridge-admission.js";
import type { BridgeState } from "./v4-bridge-state.js";

export function createAdmissionCoreHost(
  state: BridgeState,
): Pick<V4CommandCoreHost, "admitInputCommand" | "cancelInputCommand"> {
  const { context } = state;
  return {
    admitInputCommand: async (envelope, sessionId, admission) => {
      const sessionStore = context.deps.sessionStore;
      if (!sessionStore) return null;
      const input = resolveInputCommandForAdmission(
        envelope,
        sessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) return null;
      const isOpenCodeRoute = input.executionRoute?.kind === "opencode-acp";
      if (
        isOpenCodeRoute &&
        (!sessionStore.admitOpenCodeAgentRun ||
          !sessionStore.listOpenCodeAgentRuns ||
          !sessionStore.applyOpenCodeAgentRunHostEvent)
      ) {
        throw Object.assign(new Error("Atomic OpenCode delegated admission is unavailable"), {
          reasonCode: "fault.command.opencodeAgentAdmissionUnavailable",
        });
      }
      const saveSessionInput = sessionStore.saveSessionInput;
      if (!isOpenCodeRoute && !saveSessionInput) return null;
      const kind = input.kind;
      const record = context.sessions.get(sessionId);
      const routingMode = context.v4Gateway?.getInputRoutingMode(sessionId) ?? null;
      if (isOpenCodeRoute) {
        const runtimeBusy =
          record?.activeAbortController !== undefined ||
          record?.app.runtime.getActiveForegroundExecutionId() !== undefined;
        const activeOpenCodeRuns = await sessionStore.listOpenCodeAgentRuns?.({
          sessionID: sessionId as SessionId,
          statuses: ["pending", "dispatching", "running"],
          limit: 10,
        });
        const anotherOpenCodeRun = activeOpenCodeRuns?.some(
          (run) => run.runID !== envelope.commandId,
        );
        if (
          envelope.type !== "sendText" ||
          kind !== "sendText" ||
          !record ||
          runtimeBusy ||
          anotherOpenCodeRun ||
          (routingMode !== null && routingMode !== "startNow") ||
          (context.v4Gateway?.getQueueLength(sessionId) ?? 0) > 0
        ) {
          throw Object.assign(
            new Error("OpenCode delegated input requires an idle session with startNow delivery"),
            { reasonCode: "fault.command.opencodeAgentRequiresIdleStartNow" },
          );
        }
        const intent = conversationInputIntentSchema.parse({
          sourceCommandId: envelope.commandId,
          queueItemId: admission.queueItemId,
          clientId: envelope.clientId || "cli",
          kind,
          executionRoute: input.executionRoute,
          ...(input.orchestrationMode ? { orchestrationMode: input.orchestrationMode } : {}),
          text: input.text ?? "",
          attachments: input.attachments,
          delivery: { requested: "startNow", admitted: "startNow" },
          order: { admissionSeq: admission.admissionSeq },
          steer: { state: "notRequested" },
          dispatch: { state: "admitted" },
          admittedAt: admission.admittedAt,
        });
        await persistOpenCodeAgentRunAdmission(
          sessionStore as Pick<SessionStorePort, "admitOpenCodeAgentRun">,
          envelope,
          sessionId,
          intent,
          {
            beforeAdmission: async () => {
              if (record.persistence !== "deferred") return;
              // Первая отправка из ACP draft должна создать строку session до FK-bound outbox admission;
              // этот шаг фиксирует только контейнер разговора и не запускает ZCode модель.
              await record.app.runtime.ensureSessionPersistedForExternalActivity(input.text ?? "", {
                traceContext: record.traceContext,
              });
              record.persistence = "immediate";
            },
          },
        );
        return intent;
      }
      if (record?.persistence === "deferred") {
        // session_input 有 session 外键；draft 要到 startPromptTurn 后台阶段才持久化，
        // 如果先写 ledger 会直接 FK 失败，accepted 前仍没有权威记录。因此 admission
        // 先走 runtime 的统一首发持久化边界，再落 ledger，随后 handler 只负责执行。
        await record.app.runtime.ensureSessionPersistedForExternalActivity(input.text ?? "", {
          traceContext: record.traceContext,
        });
        record.persistence = "immediate";
      }
      // 这是执行前账本的“预计投递边界”；TurnSteerQueued 会用实际 delivery/回退原因
      // 幂等更新同一记录。startNow 不能伪装成 queue，否则重启 discarded 的诊断事实失真。
      const requestedDelivery =
        input.requestedDelivery ??
        (kind === "compact" && routingMode !== null && routingMode !== "startNow"
          ? "queue"
          : routingMode === "enqueue"
            ? "queue"
            : routingMode === "guide" && kind === "sendText"
              ? "guide"
              : "startNow");
      const attachmentRefs = input.attachments;
      const fallbackReasonCode =
        input.fallbackReasonCode ??
        (requestedDelivery === "guide" && attachmentRefs.length > 0
          ? "guide.attachmentsUnsupported"
          : undefined);
      const admittedDelivery =
        input.admittedDelivery ??
        (fallbackReasonCode
          ? "queue"
          : requestedDelivery === "auto"
            ? "startNow"
            : requestedDelivery);
      const conversationInputIntent = conversationInputIntentSchema.parse({
        ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
        ...(input.conversationQuotes ? { conversationQuotes: input.conversationQuotes } : {}),
        ...(input.botGroupSource ? { botGroupSource: input.botGroupSource } : {}),
        sourceCommandId: envelope.commandId,
        queueItemId: admission.queueItemId,
        clientId: envelope.clientId || "cli",
        kind,
        executionRoute: input.executionRoute ?? { kind: "zcode" },
        ...(input.orchestrationMode ? { orchestrationMode: input.orchestrationMode } : {}),
        text: input.text ?? "",
        attachments: attachmentRefs,
        ...(input.sharedContextRefs ? { sharedContextRefs: input.sharedContextRefs } : {}),
        delivery: {
          requested: requestedDelivery,
          admitted: admittedDelivery,
          ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
        },
        order: { admissionSeq: admission.admissionSeq },
        steer: fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : requestedDelivery === "guide"
            ? { state: "submitting" }
            : { state: "notRequested" },
        dispatch: { state: "admitted" },
        admittedAt: admission.admittedAt,
        ...(input.highspeed ? { highspeed: input.highspeed } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
      if (!saveSessionInput) return null;
      await saveSessionInput.call(sessionStore, {
        id: admission.queueItemId,
        sessionID: sessionId as SessionId,
        kind,
        delivery: conversationInputIntent.delivery.admitted,
        payload: {
          text: conversationInputIntent.text,
          intent: {
            sourceCommandId: conversationInputIntent.sourceCommandId,
            queueItemId: conversationInputIntent.queueItemId,
            clientId: conversationInputIntent.clientId,
            kind: conversationInputIntent.kind,
            admissionSeq: admission.admissionSeq,
            admittedAt: admission.admittedAt,
            requestedDelivery: conversationInputIntent.delivery.requested,
            admittedDelivery: conversationInputIntent.delivery.admitted,
            ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
            attachmentRefs,
            ...(conversationInputIntent.sharedContextRefs
              ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
              : {}),
          },
          conversationInputIntent,
          attachments: attachmentRefs,
          ...(conversationInputIntent.sharedContextRefs
            ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
            : {}),
          sourceCommandType: envelope.type,
        },
      });
      if (
        conversationInputIntent.sharedContextRefs?.length &&
        conversationInputIntent.delivery.admitted !== "startNow"
      ) {
        const reference = conversationInputIntent.sharedContextRefs[0]!;
        const reserved = await sessionStore.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId: reference.context_id,
          expectedStatus: "pending",
          status: "reserved",
          sourceId: admission.queueItemId,
        });
        if (!reserved) {
          await sessionStore.settleSessionInput?.({
            id: admission.queueItemId,
            sessionID: sessionId as SessionId,
            status: "failed",
            reason: "shared_context_not_attachable",
          });
          throw new Error("fault.command.sharedContextNotAttachable");
        }
        const entry = (
          await sessionStore.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === reference.context_id,
          );
        });
        const data = entry?.data;
        const session = await sessionStore.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: reference.context_id,
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "reserved",
          });
        }
      }
      return conversationInputIntent;
    },
    cancelInputCommand: async (sessionId, queueItemId, reason) => {
      await context.deps.sessionStore?.settleSessionInput?.({
        id: queueItemId,
        sessionID: sessionId as SessionId,
        status: "cancelled",
        reason,
      });
      const store = context.deps.sessionStore;
      const entries = await store?.sessionEntries?.({
        sessionID: sessionId as SessionId,
        type: "v4/shared_context_import",
      });
      const reserved = entries?.find((entry) => {
        const data = entry.data;
        return Boolean(
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          (data as Record<string, unknown>).status === "reserved" &&
          (data as Record<string, unknown>).sourceId === queueItemId,
        );
      });
      const contextId =
        reserved?.data && typeof reserved.data === "object"
          ? (reserved.data as Record<string, unknown>).contextId
          : undefined;
      if (typeof contextId === "string") {
        await store?.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId,
          expectedStatus: "reserved",
          status: "pending",
          sourceId: queueItemId,
        });
      }
    },
  };
}
