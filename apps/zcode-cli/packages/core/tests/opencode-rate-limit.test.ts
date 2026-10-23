import { CoreErrorType, SessionEventType, createSessionId } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestModelSelection } from "./test-model-selection.js";

describe("OpenCode rate limit", () => {
  it("shows the 429 on the same request and does not reopen the stream", async () => {
    const sessionId = createSessionId("runtime-opencode-rate-limit");
    const eventStore = createTestSessionEventStore();
    let modelCallCount = 0;

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
            modelCallCount += 1;
            yield { type: "text_delta", text: "partial before limit" };
            const error = new Error("OpenCode rate limit") as Error & {
              code?: string;
              context?: Record<string, unknown>;
            };
            error.code = "model_rate_limited";
            error.context = {
              providerId: "opencode",
              reason: "rate_limited",
              retryable: true,
              statusCode: 429,
            };
            throw error;
          },
        } as never),
      },
    );

    await expect(runtime.executeTurn("send through OpenCode")).rejects.toMatchObject({
      type: CoreErrorType.UnknownError,
    });
    const events = await eventStore.getEvents(sessionId);

    expect(modelCallCount).toBe(1);
    expect(events.some((event) => event.type === SessionEventType.StreamRecoveryRetryStarted)).toBe(
      false,
    );
    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(true);
  });
});
