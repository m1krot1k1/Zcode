import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { conversationInputIntentSchema, queueItemSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  buildOpenCodeAgentRunAdmission,
  isConversationInputAdmissionCommand,
  persistOpenCodeAgentRunAdmission,
  resolveInputCommandForAdmission,
} from "../src/zcode-protocol/v4-bridge.js";
import {
  inputIntentMetadata,
  inputIntentMetadataFromCanonical,
  inputIntentMetadataFromQueueItem,
} from "../src/zcode-protocol-v4/commands/input-intent.js";

function envelope(type: CommandEnvelope["type"], payload: unknown): CommandEnvelope {
  return {
    commandId: "cmd-new",
    clientId: "client-new",
    sessionId: "s-parent",
    type,
    payload,
    issuedAt: 1,
  };
}

describe("v4 input admission canonical intent", () => {
  it("gateway admission 接线包含 compact/edit/retry，排除非输入命令", () => {
    expect(isConversationInputAdmissionCommand("compact")).toBe(true);
    expect(isConversationInputAdmissionCommand("editUserQuery")).toBe(true);
    expect(isConversationInputAdmissionCommand("retryTurn")).toBe(true);
    expect(isConversationInputAdmissionCommand("applyFileRewind")).toBe(false);
  });

  it("非输入命令不创建 session_input", () => {
    expect(resolveInputCommandForAdmission(envelope("stop", {}), "s-parent", vi.fn())).toBeNull();
  });

  it("compact admission 保留 typed maintenance intent，不伪装成 sendText", () => {
    expect(resolveInputCommandForAdmission(envelope("compact", {}), "s-parent", vi.fn())).toEqual({
      kind: "compact",
      text: "/compact",
      attachments: [],
    });
  });

  it("sendText admission 保留 Highspeed message metadata", () => {
    const highspeed = {
      schemaVersion: 1 as const,
      cardId: "hsc-1",
      taskId: "s-parent",
      provider: "zai",
      model: "glm-5",
      issuedAt: 1_000,
      expiresAt: 10_000,
    };

    expect(
      resolveInputCommandForAdmission(
        envelope("sendText", { text: "accelerate", highspeedMeta: highspeed }),
        "s-parent",
        vi.fn(),
      ),
    ).toEqual({
      kind: "sendText",
      executionRoute: { kind: "zcode" },
      text: "accelerate",
      attachments: [],
      highspeed,
    });

    expect(
      inputIntentMetadata(
        {
          ...envelope("sendText", { text: "accelerate", highspeedMeta: highspeed }),
          __v4Admission: { admissionSeq: 1, admittedAt: 1, queueItemId: "queue-highspeed" },
        } as unknown as CommandEnvelope,
        { requestedDelivery: "startNow", text: "accelerate" },
      ).highspeed,
    ).toEqual(highspeed);
  });

  it("sendText route 保留在 canonical intent；ACP model 不转成 ZCode modelSelection", () => {
    const executionRoute = {
      kind: "opencode-acp",
      model: { kind: "catalog", modelId: "free/provider-model" },
    } as const;
    const command = envelope("sendText", { text: "check this", executionRoute });
    const resolved = resolveInputCommandForAdmission(command, "s-parent", vi.fn());
    expect(resolved).toMatchObject({ kind: "sendText", executionRoute });

    const metadata = inputIntentMetadata(
      {
        ...command,
        __v4Admission: { admissionSeq: 8, admittedAt: 10, queueItemId: "queue-cmd-new" },
      } as unknown as CommandEnvelope,
      { requestedDelivery: "startNow", text: "check this" },
    );
    expect(metadata.executionRoute).toEqual(executionRoute);
    expect(metadata.modelSelection).toBeUndefined();
    expect(
      inputIntentMetadataFromCanonical(command, {
        kind: "sendText",
        text: "check this",
        executionRoute,
      }).executionRoute,
    ).toEqual(executionRoute);
  });

  it("sendText swarm mode survives canonical admission, queue promotion and canonical retry", () => {
    const command = envelope("sendText", { text: "分成独立工作", orchestrationMode: "swarm" });
    const resolved = resolveInputCommandForAdmission(command, "s-parent", vi.fn());
    expect(resolved).toMatchObject({ kind: "sendText", orchestrationMode: "swarm" });

    const admittedCommand = {
      ...command,
      __v4Admission: { admissionSeq: 9, admittedAt: 10, queueItemId: "queue-swarm" },
    } as unknown as CommandEnvelope;
    const metadata = inputIntentMetadata(admittedCommand, {
      requestedDelivery: "queue",
      admittedDelivery: "queue",
      text: "分成独立工作",
    });
    expect(metadata.orchestrationMode).toBe("swarm");

    const queueItem = queueItemSchema.parse({
      ...conversationInputIntentSchema.parse({
        sourceCommandId: command.commandId,
        queueItemId: "queue-swarm",
        clientId: command.clientId,
        kind: "sendText",
        text: "分成独立工作",
        orchestrationMode: resolved.orchestrationMode,
        attachments: [],
        delivery: { requested: "queue", admitted: "queue" },
        order: { admissionSeq: 9, queuePosition: 1 },
        steer: { state: "notRequested" },
        dispatch: { state: "queued" },
        admittedAt: 10,
      }),
    });
    expect(inputIntentMetadataFromQueueItem(queueItem, queueItem.text).orchestrationMode).toBe(
      "swarm",
    );

    const retried = inputIntentMetadataFromCanonical(admittedCommand, {
      kind: "sendText",
      text: "разделить и повторить",
      orchestrationMode: metadata.orchestrationMode,
    });
    expect(retried.orchestrationMode).toBe("swarm");
    expect(
      inputIntentMetadata(
        {
          ...envelope("sendText", { text: "ordinary" }),
          __v4Admission: { admissionSeq: 10, admittedAt: 11, queueItemId: "queue-normal" },
        } as unknown as CommandEnvelope,
        { requestedDelivery: "startNow", text: "ordinary" },
      ),
    ).not.toHaveProperty("orchestrationMode");
  });

  it("ACP admission uses the atomic command-keyed outbox transaction only", async () => {
    const command = envelope("sendText", {
      text: "check this",
      executionRoute: {
        kind: "opencode-acp",
        model: { kind: "catalog", modelId: "free/provider-model" },
      },
    });
    const intent = conversationInputIntentSchema.parse({
      sourceCommandId: command.commandId,
      queueItemId: "queue-cmd-new",
      clientId: command.clientId,
      kind: "sendText",
      executionRoute: command.payload.executionRoute,
      text: "check this",
      attachments: [],
      delivery: { requested: "startNow", admitted: "startNow" },
      order: { admissionSeq: 8 },
      steer: { state: "notRequested" },
      dispatch: { state: "admitted" },
      admittedAt: 10,
    });
    const atomicAdmission = vi.fn().mockResolvedValue(undefined);
    const legacyAdmission = vi.fn();
    const store = {
      admitOpenCodeAgentRun: atomicAdmission,
      saveSessionInput: legacyAdmission,
    };

    const first = buildOpenCodeAgentRunAdmission(command, "s-parent", intent);
    await persistOpenCodeAgentRunAdmission(store, command, "s-parent", intent);
    await persistOpenCodeAgentRunAdmission(store, command, "s-parent", intent);

    expect(first).toMatchObject({
      commandID: command.commandId,
      runID: command.commandId,
      requestedModelID: "free/provider-model",
      input: {
        id: command.commandId,
        sessionID: "s-parent",
        kind: "sendText",
        delivery: "startNow",
        payload: {
          text: "check this",
          executionRoute: "opencode-cli",
          conversationInputIntent: { executionRoute: intent.executionRoute },
        },
      },
    });
    expect(atomicAdmission).toHaveBeenCalledTimes(2);
    expect(atomicAdmission.mock.calls[0]?.[0]).toEqual(first);
    expect(atomicAdmission.mock.calls[1]?.[0]).toEqual(first);
    expect(legacyAdmission).not.toHaveBeenCalled();
  });

  it("first ACP send persists a deferred session before the atomic input/run admission", async () => {
    const command = envelope("sendText", {
      text: "first OpenCode message",
      executionRoute: {
        kind: "opencode-acp",
        model: { kind: "catalog", modelId: "free/provider-model" },
      },
    });
    const intent = conversationInputIntentSchema.parse({
      sourceCommandId: command.commandId,
      queueItemId: "queue-cmd-new",
      clientId: command.clientId,
      kind: "sendText",
      executionRoute: command.payload.executionRoute,
      text: "first OpenCode message",
      attachments: [],
      delivery: { requested: "startNow", admitted: "startNow" },
      order: { admissionSeq: 1 },
      steer: { state: "notRequested" },
      dispatch: { state: "admitted" },
      admittedAt: 10,
    });
    const order: string[] = [];
    const atomicAdmission = vi.fn(async () => {
      order.push("atomic-input-and-run-admission");
    });
    let persistence: "deferred" | "immediate" = "deferred";

    await persistOpenCodeAgentRunAdmission(
      { admitOpenCodeAgentRun: atomicAdmission },
      command,
      "s-parent",
      intent,
      {
        beforeAdmission: async () => {
          if (persistence !== "deferred") return;
          order.push("persist-session-row");
          persistence = "immediate";
        },
      },
    );

    expect(order).toEqual(["persist-session-row", "atomic-input-and-run-admission"]);
    expect(persistence).toBe("immediate");
    expect(atomicAdmission).toHaveBeenCalledTimes(1);
    expect(atomicAdmission.mock.calls[0]?.[0]).toMatchObject({
      commandID: command.commandId,
      runID: command.commandId,
      input: { sessionID: "s-parent", kind: "sendText", delivery: "startNow" },
    });
  });

  it("does not create an ACP outbox row when deferred session persistence fails", async () => {
    const command = envelope("sendText", {
      text: "first OpenCode message",
      executionRoute: {
        kind: "opencode-acp",
        model: { kind: "catalog", modelId: "free/provider-model" },
      },
    });
    const intent = conversationInputIntentSchema.parse({
      sourceCommandId: command.commandId,
      queueItemId: "queue-cmd-new",
      clientId: command.clientId,
      kind: "sendText",
      executionRoute: command.payload.executionRoute,
      text: "first OpenCode message",
      attachments: [],
      delivery: { requested: "startNow", admitted: "startNow" },
      order: { admissionSeq: 1 },
      steer: { state: "notRequested" },
      dispatch: { state: "admitted" },
      admittedAt: 10,
    });
    const atomicAdmission = vi.fn();

    await expect(
      persistOpenCodeAgentRunAdmission(
        { admitOpenCodeAgentRun: atomicAdmission },
        command,
        "s-parent",
        intent,
        { beforeAdmission: async () => Promise.reject(new Error("session persistence failed")) },
      ),
    ).rejects.toThrow("session persistence failed");
    expect(atomicAdmission).not.toHaveBeenCalled();
  });

  it("retry 以新 commandId admission，但保留 canonical kind/delivery/attachments/provenance", () => {
    const resolve = vi.fn().mockReturnValue({
      ok: true,
      action: "retryTurn",
      row: {},
      messageId: "msg-assistant",
      editTarget: {
        entityId: "msg-user",
        productTurnId: "turn-1",
        transcriptMessageId: "msg-user",
        coveredByStableCompact: false,
        intent: {
          kind: "sendGoalCommand",
          text: "original objective",
          inputOrigin: "mobile",
          botGroupSource: {
            provider: "feishu",
            botId: "bot",
            chatId: "group",
            senderId: "member",
            senderName: "Member",
            messageId: "message",
          },
          sourceCommandId: "cmd-original",
          clientId: "client-original",
          queueItemId: "queue-original",
          requestedDelivery: "guide",
          admittedDelivery: "queue",
          fallbackReasonCode: "guide.goalUnsupported",
          attachments: [
            {
              ref: "attachment://a",
              fileName: "a.txt",
              mime: "text/plain",
              bytes: 1,
              sourceKind: "topic-history",
              messageCount: 1,
            },
          ],
          provenance: { sourceCommandId: "cmd-root", clientId: "client-root" },
        },
      },
    });

    expect(
      resolveInputCommandForAdmission(
        envelope("retryTurn", {
          target: { rowId: 7, entityId: "msg-assistant" },
        }),
        "s-parent",
        resolve,
      ),
    ).toEqual({
      kind: "sendGoalCommand",
      text: "original objective",
      inputOrigin: "mobile",
      botGroupSource: {
        provider: "feishu",
        botId: "bot",
        chatId: "group",
        senderId: "member",
        senderName: "Member",
        messageId: "message",
      },
      attachments: [
        {
          ref: "attachment://a",
          fileName: "a.txt",
          mime: "text/plain",
          bytes: 1,
          sourceKind: "topic-history",
          messageCount: 1,
        },
      ],
      requestedDelivery: "guide",
      admittedDelivery: "queue",
      fallbackReasonCode: "guide.goalUnsupported",
      provenance: { sourceCommandId: "cmd-root", clientId: "client-root" },
    });
  });

  it("compact-covered edit 只在原 session admission", () => {
    const resolve = vi.fn().mockReturnValue({
      ok: true,
      action: "editUserQuery",
      row: {},
      editTarget: {
        entityId: "msg-user",
        productTurnId: "turn-1",
        transcriptMessageId: "msg-user",
        coveredByStableCompact: true,
        intent: {
          kind: "sendText",
          text: "old",
          sourceCommandId: "cmd-original",
        },
      },
    });
    const command = envelope("editUserQuery", {
      target: { rowId: 7, entityId: "msg-user" },
      newText: "edited",
    });

    expect(resolveInputCommandForAdmission(command, "s-parent", resolve)).toMatchObject({
      kind: "sendText",
      text: "edited",
      provenance: { sourceCommandId: "cmd-original" },
    });
  });
});
