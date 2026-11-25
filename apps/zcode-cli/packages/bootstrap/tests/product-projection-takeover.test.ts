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
  return apply;
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
    const apply = harness();

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
});
