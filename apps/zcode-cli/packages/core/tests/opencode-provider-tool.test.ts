import { SessionEventType, createSessionId } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createToolRegistry } from "../src/tool/registry.js";

describe("OpenCode provider tool", () => {
  it("shows the observation once and does not run the local tool", async () => {
    const sessionId = createSessionId("runtime-opencode-provider-tool");
    const eventStore = createTestSessionEventStore();
    const registry = createToolRegistry();
    let handlerCalls = 0;
    let modelCalls = 0;

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "OpenCodeObservedRead",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => {
        handlerCalls += 1;
        return "local-read-must-not-run";
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelStreaming: "on",
        modelSelection: createTestModelSelection("opencode/deepseek-v4.1-flash-free"),
      },
      {
        eventStore,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText() {
            throw new Error("generateText should not be used");
          },
          async *streamText() {
            modelCalls += 1;
            yield {
              type: "tool_call",
              toolCall: {
                id: "oc-tool-1",
                name: "OpenCodeObservedRead",
                input: { filePath: "README.md" },
                providerExecuted: true,
              },
            };
            yield { type: "text_delta", text: "saw the file" };
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("ask OpenCode");
    const events = await eventStore.getEvents(sessionId);
    const toolEvents = events.filter(
      (event) =>
        event.type === SessionEventType.ModelStreaming &&
        (event.payload as { kind?: string }).kind === "tool_call",
    );

    expect(modelCalls).toBe(1);
    expect(handlerCalls).toBe(0);
    expect(events.some((event) => event.type === SessionEventType.ToolCallScheduled)).toBe(false);
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.payload).toMatchObject({
      kind: "tool_call",
      providerExecuted: true,
      toolCallId: "oc-tool-1",
      toolName: "OpenCodeObservedRead",
    });
  });
});
