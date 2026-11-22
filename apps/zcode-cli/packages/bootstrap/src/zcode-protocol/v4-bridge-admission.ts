// 输入准入（admission）域：命令 envelope → canonical ConversationInputIntent，
// 以及 OpenCode delegated run 的唯一 durable admission 事务。
// 这层只依赖协议类型与 session store 端口，不持有桥状态。
import type {
  AttachmentRef,
  CommandEnvelope,
  ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  OpenCodeAgentRunAdmission,
  OpenCodeAgentRunStatus,
  SessionId,
  SessionStorePort,
} from "@zcode/contracts";
import type { ZCodeOpenCodeAgentRunResult } from "@zcode/shared";
import type { ConversationRowTargetResolution } from "../zcode-protocol-v4/product-projection.js";

export interface InputCommandForAdmission {
  executionRoute?: ConversationInputIntent["executionRoute"];
  orchestrationMode?: ConversationInputIntent["orchestrationMode"];
  inputOrigin?: "desktop" | "mobile";
  conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
  botGroupSource?: ConversationInputIntent["botGroupSource"];
  kind: ConversationInputIntent["kind"];
  text: string;
  attachments: readonly AttachmentRef[];
  sharedContextRefs?: ConversationInputIntent["sharedContextRefs"];
  requestedDelivery?: ConversationInputIntent["delivery"]["requested"];
  admittedDelivery?: ConversationInputIntent["delivery"]["admitted"];
  fallbackReasonCode?: string;
  highspeed?: ConversationInputIntent["highspeed"];
  provenance?: ConversationInputIntent["provenance"];
}

export type ResolveAdmissionRowTarget = (
  sessionId: string,
  target: { rowId: number; entityId: string },
  action: "editUserQuery" | "retryTurn",
) => ConversationRowTargetResolution | null;

function admissionAttachmentRefs(
  attachments: NonNullable<
    Extract<ConversationRowTargetResolution, { ok: true }>["editTarget"]
  >["intent"]["attachments"],
): AttachmentRef[] {
  return (
    attachments?.flatMap((attachment) =>
      attachment.ref
        ? [
            {
              // 重试／编辑必须保留与原 row 相同的附件来源，不能重新枚举字段丢失文本材料标记。
              ...attachment,
              ref: attachment.ref,
            },
          ]
        : [],
    ) ?? []
  );
}

/**
 * admission 只持久化真正会产生输入的命令。edit/retry 不能从 payload 猜 intent；
 * 必须复用 projection 的 canonical target，并把旧来源折叠进 provenance。
 */
export function resolveInputCommandForAdmission(
  envelope: CommandEnvelope,
  admissionSessionId: string,
  resolveRowTarget: ResolveAdmissionRowTarget,
): InputCommandForAdmission | null {
  if (envelope.type === "createSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string; attachments?: AttachmentRef[] };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: firstInput.attachments ?? [],
        }
      : null;
  }
  if (envelope.type === "createSelectionSideSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: [],
        }
      : null;
  }
  if (envelope.type === "sendText" || envelope.type === "sendGoalCommand") {
    const payload = envelope.payload as {
      text: string;
      executionRoute?: ConversationInputIntent["executionRoute"];
      attachments?: AttachmentRef[];
      context_refs?: ConversationInputIntent["sharedContextRefs"];
      highspeedMeta?: ConversationInputIntent["highspeed"];
      inputOrigin?: "desktop" | "mobile";
      conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
      botGroupSource?: ConversationInputIntent["botGroupSource"];
      orchestrationMode?: ConversationInputIntent["orchestrationMode"];
    };
    return {
      kind: envelope.type,
      text: payload.text,
      attachments: payload.attachments ?? [],
      executionRoute: payload.executionRoute ?? { kind: "zcode" },
      ...(payload.context_refs ? { sharedContextRefs: payload.context_refs } : {}),
      ...(payload.highspeedMeta ? { highspeed: payload.highspeedMeta } : {}),
      ...(payload.inputOrigin ? { inputOrigin: payload.inputOrigin } : {}),
      ...(payload.conversationQuotes ? { conversationQuotes: payload.conversationQuotes } : {}),
      ...(payload.botGroupSource ? { botGroupSource: payload.botGroupSource } : {}),
      ...(payload.orchestrationMode ? { orchestrationMode: payload.orchestrationMode } : {}),
    };
  }
  if (envelope.type === "compact") {
    return { kind: "compact", text: "/compact", attachments: [] };
  }
  if (envelope.type !== "editUserQuery" && envelope.type !== "retryTurn") return null;
  if (!envelope.sessionId) return null;
  const payload = envelope.payload as {
    target: { rowId: number; entityId: string };
    newText?: string;
    conversationQuotes?: ConversationInputIntent["conversationQuotes"];
    attachments?: AttachmentRef[];
  };
  const resolution = resolveRowTarget(envelope.sessionId, payload.target, envelope.type);
  if (!resolution?.ok || !resolution.editTarget) return null;
  const canonical = resolution.editTarget;

  // 会先提交 append-only branch cut，不再为 edit 创建 hidden child。
  const originalSourceCommandId =
    canonical.intent.provenance?.sourceCommandId ?? canonical.intent.sourceCommandId;
  return {
    kind: canonical.intent.kind,
    ...(canonical.intent.inputOrigin ? { inputOrigin: canonical.intent.inputOrigin } : {}),
    ...((payload.conversationQuotes ?? canonical.intent.conversationQuotes)
      ? { conversationQuotes: payload.conversationQuotes ?? canonical.intent.conversationQuotes }
      : {}),
    ...(canonical.intent.botGroupSource ? { botGroupSource: canonical.intent.botGroupSource } : {}),
    text:
      envelope.type === "editUserQuery"
        ? (payload.newText ?? canonical.intent.text)
        : canonical.intent.text,
    attachments:
      envelope.type === "editUserQuery" && payload.attachments
        ? payload.attachments
        : admissionAttachmentRefs(canonical.intent.attachments),
    ...(canonical.intent.requestedDelivery
      ? { requestedDelivery: canonical.intent.requestedDelivery }
      : {}),
    ...(canonical.intent.admittedDelivery
      ? { admittedDelivery: canonical.intent.admittedDelivery }
      : {}),
    ...(canonical.intent.fallbackReasonCode
      ? { fallbackReasonCode: canonical.intent.fallbackReasonCode }
      : {}),
    ...(canonical.intent.orchestrationMode
      ? { orchestrationMode: canonical.intent.orchestrationMode }
      : {}),
    ...(originalSourceCommandId
      ? {
          provenance: canonical.intent.provenance ?? {
            sourceCommandId: originalSourceCommandId,
            ...(canonical.intent.queueItemId ? { queueItemId: canonical.intent.queueItemId } : {}),
            ...(canonical.intent.clientId ? { clientId: canonical.intent.clientId } : {}),
          },
        }
      : {}),
  };
}

/** Build the sole durable input/outbox transaction for an admitted OpenCode run. */
export function buildOpenCodeAgentRunAdmission(
  envelope: CommandEnvelope,
  sessionId: string,
  intent: ConversationInputIntent,
): OpenCodeAgentRunAdmission {
  if (
    envelope.type !== "sendText" ||
    envelope.sessionId !== sessionId ||
    intent.kind !== "sendText" ||
    intent.executionRoute.kind !== "opencode-acp" ||
    intent.delivery.requested !== "startNow" ||
    intent.delivery.admitted !== "startNow" ||
    intent.attachments.length !== 0 ||
    intent.sharedContextRefs?.length ||
    intent.modelSelection !== undefined ||
    intent.mode !== undefined ||
    intent.planEnabled !== undefined
  ) {
    throw Object.assign(
      new Error("OpenCode delegated input must be idle, startNow, and text-only"),
      {
        reasonCode: "fault.command.opencodeAgentRequiresIdleStartNow",
      },
    );
  }
  const requestedModelID =
    intent.executionRoute.model.kind === "catalog"
      ? intent.executionRoute.model.modelId
      : undefined;
  return {
    commandID: envelope.commandId,
    runID: envelope.commandId,
    ...(requestedModelID ? { requestedModelID } : {}),
    input: {
      id: envelope.commandId,
      sessionID: sessionId as SessionId,
      kind: "sendText",
      delivery: "startNow",
      payload: {
        text: intent.text,
        // Storage uses its own discriminator; the canonical intent keeps ACP model identity
        // without mapping it into the ZCode ModelSelection contract.
        executionRoute: "opencode-cli",
        conversationInputIntent: intent,
        attachments: intent.attachments,
        sourceCommandType: envelope.type,
      },
    },
  };
}

export async function persistOpenCodeAgentRunAdmission(
  sessionStore: Pick<SessionStorePort, "admitOpenCodeAgentRun">,
  envelope: CommandEnvelope,
  sessionId: string,
  intent: ConversationInputIntent,
  options: { beforeAdmission?: () => Promise<void> } = {},
): Promise<void> {
  const admit = sessionStore.admitOpenCodeAgentRun;
  if (!admit) {
    throw Object.assign(new Error("Atomic OpenCode delegated admission is unavailable"), {
      reasonCode: "fault.command.opencodeAgentAdmissionUnavailable",
    });
  }
  await options.beforeAdmission?.();
  await admit.call(sessionStore, buildOpenCodeAgentRunAdmission(envelope, sessionId, intent));
}

export async function settleOpenCodeStartFailure(
  sessionStore: Pick<SessionStorePort, "getOpenCodeAgentRun" | "transitionOpenCodeAgentRun">,
  sessionID: SessionId,
  runID: string,
  result: ZCodeOpenCodeAgentRunResult,
): Promise<void> {
  if (
    !(
      result.status === "failed" ||
      result.status === "cancelled" ||
      result.status === "interrupted"
    )
  ) {
    return;
  }
  const current = await sessionStore.getOpenCodeAgentRun?.({ sessionID, runID });
  if (!current || ["completed", "cancelled", "failed", "interrupted"].includes(current.status))
    return;
  const status: OpenCodeAgentRunStatus = result.status;
  await sessionStore.transitionOpenCodeAgentRun?.({
    sessionID,
    runID,
    expectedStatus: current.status,
    expectedEventSequence: current.eventSequence,
    eventSequence: current.eventSequence + 1,
    status,
    diagnosticCode: result.diagnosticCode,
    stopReason: result.stopReason,
    resultText: result.finalText,
  });
}

export function isConversationInputAdmissionCommand(type: CommandEnvelope["type"]): boolean {
  return (
    type === "sendText" ||
    type === "sendGoalCommand" ||
    type === "compact" ||
    type === "editUserQuery" ||
    type === "retryTurn"
  );
}
