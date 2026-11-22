import { CoreErrorType, createSessionId } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("OpenCode stop", () => {
  it("cancels the same run and drops provider chunks that arrive after Stop", async () => {
    const sessionId = createSessionId("runtime-opencode-stop");
    const eventStore = createTestSessionEventStore();
    const firstChunk = deferred();
    const releaseLateChunk = deferred();

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelStreaming: "on",
        modelSelection: createTestModelSelection("opencode/deepseek-v4.1-flash-free"),
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            throw new Error("generateText should not be used");
          },
          async *streamText() {
            yield { type: "text_delta", text: "before-stop" };
            firstChunk.resolve();
            await releaseLateChunk.promise;
            yield { type: "text_delta", text: "AFTER_STOP_MUST_NOT_LAND" };
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    const pendingTurn = runtime.executeTurn("send through OpenCode");
    await firstChunk.promise;
    expect(runtime.stopActiveForegroundExecution({ reason: "user stop" })).toMatchObject({
      kind: "stopped",
    });
    releaseLateChunk.resolve();

    await expect(pendingTurn).rejects.toMatchObject({ type: CoreErrorType.TurnCancelled });
    const serialized = JSON.stringify(await eventStore.getEvents(sessionId));
    expect(serialized).toContain("before-stop");
    expect(serialized).not.toContain("AFTER_STOP_MUST_NOT_LAND");
  });
});
