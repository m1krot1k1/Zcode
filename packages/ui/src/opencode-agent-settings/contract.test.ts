import { describe, expect, it } from "vitest";

import { opencodeAgentSettingsModule } from "./module.js";
import { findOpenCodeConfigOption, getOpenCodeSelectValues } from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("opencode-agent-settings contract", () => {
  it("declares its module manifest", () => {
    expect(opencodeAgentSettingsModule.id).toBe("opencode-agent-settings");
  });

  it("flattens the live ACP model selectors without synthesizing catalog entries", () => {
    const options = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select" as const,
        currentValue: "zen/free-model",
        options: [
          { value: "zen/free-model", name: "Free model" },
          {
            group: "local",
            name: "Local models",
            options: [{ value: "ollama/qwen", name: "Qwen" }],
          },
        ],
      },
    ];
    const model = findOpenCodeConfigOption(options, "model");

    expect(model?.currentValue).toBe("zen/free-model");
    expect(getOpenCodeSelectValues(model!)).toEqual([
      { value: "zen/free-model", name: "Free model", description: undefined },
      { value: "ollama/qwen", name: "Local models: Qwen", description: undefined },
    ]);
    expect(findOpenCodeConfigOption([], "model")).toBeUndefined();
  });
});
