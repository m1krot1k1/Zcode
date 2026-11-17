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
