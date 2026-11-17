import { describe, expect, it } from "vitest";
import { ServiceChannels } from "@zcode/shared";

import { IChatAutocompleteService } from "./contract.js";
import { chatAutocompleteModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("services-chat-autocomplete contract", () => {
  it("declares its module manifest", () => {
    expect(chatAutocompleteModule.id).toBe("services-chat-autocomplete");
    expect(chatAutocompleteModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("binds the service descriptor to the shared channel", () => {
    expect(IChatAutocompleteService.channelName).toBe(ServiceChannels.ChatAutocomplete);
    expect(ServiceChannels.ChatAutocomplete).toBe("chat-autocomplete");
  });
});

describe("chat autocomplete reasoning level regression", () => {
  it("не отправляет неподдерживаемый none, если модель знает только disabled", async () => {
    // Регрессия Этапа 6.1b: сервис всегда отправлял `reasoningLevel: "none"`, хотя у части
    // моделей допустим только `disabled`, из-за чего ghost-подсказка не генерировалась.
    const { createChatAutocompleteService } = await import("./service.js");
    const { pickCheapestReasoningLevel } = await import("./service.js");
    const calls: Array<{ options?: { reasoningLevel?: string } }> = [];
    const service = createChatAutocompleteService({
      textGenerator: {
        async generateText(params) {
          calls.push(params.selection);
          return {
            text: "и тесты",
            selection: { providerId: params.selection.providerId, modelId: params.selection.modelId },
          };
        },
      },
      modelResolver: {
        async resolveDefaultSelection() {
          return {
            providerId: "opencode-go-messages",
            modelId: "minimax-m3",
            reasoningLevels: ["disabled"],
          };
        },
      },
      now: () => 0,
    });

    await service.complete({
      requestId: "auto_regression_1",
      workspacePath: "/repo/zcode",
      prefix: "добавь проверку для ",
      suffix: "",
      cursorAtEndOfLine: true,
      openTabPaths: [],
      context: { history: false, openFiles: false, diffs: false, codeIndex: false, userLexicon: false },
      debounceMs: 120,
    });

    expect(calls[0]?.options?.reasoningLevel).toBe("disabled");
    expect(pickCheapestReasoningLevel(["disabled", "low"])).toBe("disabled");
    expect(pickCheapestReasoningLevel([])).toBeUndefined();
  });
});
