import { describe, expect, it } from "vitest";
import { createToolCallId } from "@zcode/contracts";
import {
  MIN_TOOL_PAYLOAD_RESERVE_TOKENS,
  resolveReasoningAwareMaxOutputTokens,
  resolveThinkingBudgetTokens,
} from "../src/runtime/methods/model-token-limits.js";
import {
  TOOL_CALL_TRUNCATED_BY_MAX_TOKENS,
  attachRawMalformedToolInput,
} from "../src/tool/self-repair/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import {
  countContinuePrompts,
  createRecordingMessageStore,
  createRuntime,
  requestText,
  stopResult,
} from "./runtime-output-token-continuation-test-helpers.js";

describe("Increment 4.1 (F-01): finishReason === 'length' truncation recovery & reasoning-aware maxOutputTokens", () => {
  describe("resolveReasoningAwareMaxOutputTokens", () => {
    it("keeps configured maxOutputTokens when thinking/reasoningEffort is disabled", () => {
      const resolved = resolveReasoningAwareMaxOutputTokens({
        configuredMaxOutputTokens: 8_192,
        contextWindow: 200_000,
        estimatedInputTokens: 10_000,
        modelHardMaxOutputTokens: 64_000,
        reasoningEffort: "disabled",
      });

      expect(resolved.thinkingBudgetTokens).toBe(0);
      expect(resolved.effectiveMaxOutputTokens).toBe(8_192);
    });

    it("expands maxOutputTokens when reasoningEffort is active to guarantee >= 16,384 tool payload reserve", () => {
      const resolved = resolveReasoningAwareMaxOutputTokens({
        configuredMaxOutputTokens: 8_192,
        contextWindow: 200_000,
        estimatedInputTokens: 12_000,
        modelHardMaxOutputTokens: 64_000,
        reasoningEffort: "high",
      });

      const expectedThinking = resolveThinkingBudgetTokens("high");
      expect(expectedThinking).toBe(16_384);
      expect(resolved.effectiveMaxOutputTokens).toBeGreaterThanOrEqual(
        expectedThinking + MIN_TOOL_PAYLOAD_RESERVE_TOKENS,
      );
      expect(resolved.effectiveMaxOutputTokens - resolved.thinkingBudgetTokens).toBeGreaterThanOrEqual(
        MIN_TOOL_PAYLOAD_RESERVE_TOKENS,
      );
    });

    it("caps expanded maxOutputTokens cleanly at modelHardMaxOutputTokens and remaining contextWindow", () => {
      const cappedByModel = resolveReasoningAwareMaxOutputTokens({
        configuredMaxOutputTokens: 8_192,
        contextWindow: 200_000,
        estimatedInputTokens: 5_000,
        modelHardMaxOutputTokens: 24_576,
        reasoningEffort: "max",
      });

      expect(cappedByModel.effectiveMaxOutputTokens).toBe(24_576);
      expect(cappedByModel.minToolPayloadReserveTokens).toBe(MIN_TOOL_PAYLOAD_RESERVE_TOKENS);
      expect(cappedByModel.thinkingBudgetTokens).toBe(24_576 - MIN_TOOL_PAYLOAD_RESERVE_TOKENS);
    });
  });

  describe("AgentRuntime turn recovery on truncated tool call (finishReason === 'length')", () => {
    it("does NOT blindly repair truncated JSON tail and returns TOOL_CALL_TRUNCATED_BY_MAX_TOKENS with incremental decomposition instructions", async () => {
      const requests: Array<{ messages: readonly { content: unknown }[] }> = [];
      const store = createRecordingMessageStore();
      const registry = createToolRegistry();
      let writeExecutions = 0;

      registry.register({
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string" },
            file_path: { type: "string" },
          },
          required: ["file_path", "content"],
        },
        metadata: {
          concurrentSafe: false,
          destructive: true,
          name: "Write",
          needsApproval: false,
          readOnly: false,
          riskLevel: "medium",
          sideEffectScope: "filesystem",
        },
        handler: async () => {
          writeExecutions += 1;
          return "written";
        },
      });

      const truncatedRawJson =
        '{"file_path":"src/huge-module.ts","content":"export function alpha() {\\n' +
        "  const x = 1;\\n".repeat(120);
      let modelStep = 0;

      const runtime = createRuntime({
        id: "truncated-write-recovery",
        deps: {
          sessionStore: store as never,
          toolRegistry: registry,
        },
        modelAdapter: {
          async generateText(request: { messages: readonly { content: unknown }[] }) {
            requests.push(request);
            modelStep += 1;
            if (modelStep === 1) {
              const malformedInput = attachRawMalformedToolInput({}, truncatedRawJson);
              return {
                finishReason: "length" as const,
                text: "Generating module...",
                toolCalls: [
                  {
                    id: createToolCallId("call_trunc_write_1"),
                    input: malformedInput,
                    name: "Write",
                  },
                ],
                usage: {
                  inputTokens: 1_200,
                  outputTokens: 8_192,
                  reasoningTokens: 6_100,
                  totalTokens: 9_392,
                },
              };
            }
            return stopResult("Created skeleton and applied incremental sections.", 1_500, 64);
          },
        } as never,
      });

      const turnResult = await runtime.executeTurn("Create src/huge-module.ts");

      // Мутирующий оборванный Write НЕ должен исполняться со слепо достроенным JSON.
      expect(writeExecutions).toBe(0);
      expect(turnResult.response).toContain("Created skeleton");
      expect(requests).toHaveLength(2);

      // Текстовый Continue не должен смешиваться с оборванным вызовом инструмента.
      expect(countContinuePrompts(requests[1]!.messages)).toBe(0);

      const secondRequestPrompt = requestText(requests[1]!.messages);
      expect(secondRequestPrompt).toContain(TOOL_CALL_TRUNCATED_BY_MAX_TOKENS);
      expect(secondRequestPrompt).toContain('Tool call "Write"');
      expect(secondRequestPrompt).toContain(
        `rawInputBytes=${new TextEncoder().encode(truncatedRawJson).byteLength}`,
      );
      expect(secondRequestPrompt).toContain("minimal valid module skeleton");
      expect(secondRequestPrompt).toContain("Edit or ApplyPatch");

      // Диагностика усечённого вызова сохранена в sessionStore (F-06).
      const savedAssistant = store.savedMessages.find(
        (msg) => msg.role === "assistant" && msg.finish === "length",
      );
      expect(savedAssistant).toBeDefined();
      expect(savedAssistant.rawTruncatedInputPreview).toContain('{"file_path":"src/huge-module.ts"');
    });
  });
});
