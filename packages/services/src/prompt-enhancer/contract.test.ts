import { describe, expect, it } from "vitest";
import { promptEnhanceRequestSchema } from "@zcode/shared";

import { createPromptEnhancerService } from "./service.js";
import { promptEnhancerModule } from "./module.js";

// 契约测试只 import contract/module/index и подменяет порты; реализация модели не участвует.
describe("prompt-enhancer contract", () => {
  it("declares its module manifest", () => {
    expect(promptEnhancerModule.id).toBe("prompt-enhancer");
    expect(promptEnhancerModule.requires).toEqual(["services", "shared"]);
  });

  it("keeps the public surface to enhance/cancel/onStreamDelta", () => {
    const service = createPromptEnhancerService({
      textGenerator: {
        async generateText() {
          return { text: '{"enhancedText":"ok"}', selection: { providerId: "p", modelId: "m" } };
        },
      },
      modelResolver: {
        async resolveDefaultSelection() {
          return { providerId: "p", modelId: "m" };
        },
      },
      estimateTokens: () => ({ tokens: 1, method: "char-ratio" as const }),
    });
    expect(Object.keys(service).sort()).toEqual(["cancel", "enhance", "onStreamDelta"]);
  });

  it("rejects a request that violates the shared wire schema", async () => {
    const service = createPromptEnhancerService({
      textGenerator: {
        async generateText() {
          return { text: "{}", selection: { providerId: "p", modelId: "m" } };
        },
      },
      modelResolver: {
        async resolveDefaultSelection() {
          return { providerId: "p", modelId: "m" };
        },
      },
    });
    await expect(service.enhance({ requestId: "", workspacePath: "" } as never)).rejects.toThrow(
      /invalid_request|Invalid|expected/i,
    );
  });

  it("unsubscribes stream listeners exactly once", () => {
    const service = createPromptEnhancerService({
      textGenerator: {
        async generateText() {
          return { text: "{}", selection: { providerId: "p", modelId: "m" } };
        },
      },
    });
    let calls = 0;
    const unsubscribe = service.onStreamDelta(() => {
      calls += 1;
    });
    unsubscribe();
    unsubscribe();
    expect(calls).toBe(0);
  });

  it("classifies the draft, selects a framework and returns consent-aware capabilities", async () => {
    let systemPrompt = "";
    const service = createPromptEnhancerService({
      textGenerator: {
        async generateText(params) {
          systemPrompt = params.messages[0]?.content ?? "";
          return {
            text: JSON.stringify({
              enhancedText: "Implement the TypeScript endpoint, add tests, then verify the build.",
              assumptions: [{ text: "The endpoint belongs to the existing API", origin: "draft" }],
              capabilitySuggestions: [
                { kind: "skill", name: "yandex-direct", reason: "Matches the task domain" },
              ],
            }),
            selection: { providerId: "p", modelId: "m" },
          };
        },
      },
      modelResolver: {
        async resolveDefaultSelection() {
          return { providerId: "p", modelId: "m" };
        },
      },
      estimateTokens: () => ({ tokens: 1, method: "char-ratio" as const }),
    });

    const result = await service.enhance(
      promptEnhanceRequestSchema.parse({
        requestId: "req_service_classify_1",
        workspacePath: "/repo/zcode",
        target: "chat_user_prompt",
        draftText: "Implement a TypeScript endpoint, add tests, then verify the build",
      }),
    );

    expect(result.framework).toBe("rise");
    expect(result.domain).toBe("coding");
    expect(result.taskKind).toBe("feature");
    expect(result.capabilitySuggestions).toEqual([
      {
        kind: "skill",
        name: "yandex-direct",
        reason: "Matches the task domain",
        installed: false,
        source: "model",
        requiresConsent: true,
      },
    ]);
    expect(systemPrompt).toContain("Never ask the author a question");
    expect(systemPrompt).toContain("RISE");
  });

  it("accepts the shared request schema shape", () => {
    expect(
      promptEnhanceRequestSchema.safeParse({
        requestId: "req_contract_1",
        workspacePath: "/repo/zcode",
        target: "chat_user_prompt",
        draftText: "fix bug",
      }).success,
    ).toBe(true);
  });
});
