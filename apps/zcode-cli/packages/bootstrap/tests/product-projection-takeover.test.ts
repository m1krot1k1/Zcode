import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { conversationDeltaSchema } from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

/**
 * The takeover card is the only place the fallback model's answer is visible, and it renders
 * only when the projected row carries `takeover`. The projection must therefore copy the payload
 * field on spawn and on the terminal update; otherwise the answer degrades to a summary line.
 */
function harness() {
  const projection = new ProductProjection("takeover-projection", "epoch");
  let seq = 0;
  const apply = (type: SessionEvent["type"], payload: unknown) =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "takeover-projection",
      turnId: "turn-1",
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      type,
      payload,
    } as SessionEvent);
  apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
  apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "item", messageId: "user-1" });
  return { apply, projection };
}

const runningTakeover = {
  taskId: "task-1",
  itemIndex: 0,
  itemText: "refused item",
  providerId: null,
  providerName: null,
  modelId: null,
  status: "running" as const,
  output: "",
};

describe("uncensored takeover projection", () => {
  it("carries the fallback answer into the subagent row", () => {
    const { apply } = harness();

    apply(SessionEventType.SubagentSpawned, {
      agentId: "agent-1",
      agentType: "uncensored-takeover",
      status: "running",
      description: "Uncensored takeover for task item 0",
      takeover: runningTakeover,
    });
    const deltas = apply(SessionEventType.SubagentStopped, {
      agentId: "agent-1",
      agentType: "uncensored-takeover",
      status: "completed",
      durationMs: 1200,
      takeover: {
        ...runningTakeover,
        providerName: "nano-gpt",
        modelId: "deepseek-uncensored",
        status: "done",
        output: "delegated answer",
      },
    });

    for (const delta of deltas) expect(conversationDeltaSchema.parse(delta)).toEqual(delta);
    const row = deltas
      .filter(
        (delta): delta is Extract<typeof delta, { op: "row.upserted" | "row.appended" }> =>
          delta.op === "row.upserted" || delta.op === "row.appended",
      )
      .map((delta) => delta.row)
      .find((candidate) => candidate.kind === "subagent");
    expect(row?.takeover).toMatchObject({
      providerName: "nano-gpt",
      modelId: "deepseek-uncensored",
      status: "done",
      output: "delegated answer",
    });
  });

  it("keeps the fallback answer as the last visible assistant text", () => {
    const { apply, projection } = harness();
    const stream = (assistantMessageId: string, partId: string, text: string) => {
      apply(SessionEventType.ModelStreaming, {
        assistantMessageId,
        partId,
        kind: "text_start",
        delta: "",
        done: false,
      });
      apply(SessionEventType.ModelStreaming, {
        assistantMessageId,
        partId,
        kind: "text_delta",
        delta: text,
        done: false,
      });
      apply(SessionEventType.ModelStreaming, {
        assistantMessageId,
        partId,
        kind: "text_end",
        delta: "",
        done: true,
      });
    };

    // The main model's refusal is streamed and persisted as its own assistant message.
    stream("assistant-primary", "part-primary", "I can't help with that.");
    apply(SessionEventType.SubagentSpawned, {
      agentId: "agent-1",
      agentType: "uncensored-takeover",
      status: "running",
      description: "Uncensored takeover for task item 0",
      takeover: runningTakeover,
    });
    apply(SessionEventType.SubagentStopped, {
      agentId: "agent-1",
      agentType: "uncensored-takeover",
      status: "completed",
      durationMs: 1200,
      takeover: {
        ...runningTakeover,
        providerName: "nano-gpt",
        modelId: "deepseek-uncensored",
        status: "done",
        output: "Fallback answer.",
      },
    });
    // The gate writes the fallback outcome as a new synthetic assistant message.
    stream("assistant-fallback", "part-fallback", "Fallback answer.");

    const assistantTexts = projection.snapshot.rows.window.flatMap((row) =>
      row.kind === "assistantText" ? [row.text] : [],
    );
    expect(assistantTexts).toEqual(["I can't help with that.", "Fallback answer."]);
    expect(assistantTexts.at(-1)).toBe("Fallback answer.");
  });

  describe("refusal marker in streaming text", () => {
    it("never renders the token, even when it arrives split across deltas", () => {
      const projection = new ProductProjection("marker-stream", "epoch");
      let seq = 0;
      const apply = (type: SessionEvent["type"], payload: unknown) =>
        projection.applyEvent({
          id: `event-${++seq}`,
          sessionId: "marker-stream",
          turnId: "turn-1",
          traceId: "trace",
          timestamp: new Date(1700000000000 + seq),
          sequenceNumber: seq,
          type,
          payload,
        } as SessionEvent);
      apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
      apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "x", messageId: "user-1" });

      const stream = (payload: Record<string, unknown>) =>
        apply(SessionEventType.ModelStreaming, { done: false, ...payload });
      const deltas = [
        ...stream({ kind: "text_start", delta: "" }),
        ...stream({ kind: "text_delta", delta: "[[ZCODE_" }),
        ...stream({ kind: "text_delta", delta: "REFUSAL]]" }),
        ...stream({ kind: "text_delta", delta: "\nНе буду это писать." }),
      ];

      const appended = deltas
        .filter(
          (delta): delta is Extract<typeof delta, { op: "row.delta" }> => delta.op === "row.delta",
        )
        .map((delta) => delta.append)
        .join("");
      expect(appended).toBe("\nНе буду это писать.");
    });
  });
});
