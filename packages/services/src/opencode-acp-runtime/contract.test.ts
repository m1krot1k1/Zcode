import { describe, expect, it } from "vitest";

import { opencodeAcpRuntimeModule } from "./module.js";
import type { OpenCodeCliModelCatalog } from "./contract.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("opencode-acp-runtime contract", () => {
  it("declares its module manifest", () => {
    expect(opencodeAcpRuntimeModule.id).toBe("opencode-acp-runtime");
  });

  it("keeps CLI model discovery explicit that authentication was not checked", () => {
    const catalog: OpenCodeCliModelCatalog = {
      status: "available",
      models: [
        {
          modelId: "provider/model",
          name: "Model",
          contextWindow: 32_000,
          maxOutputTokens: 8_000,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
          outputSupportsText: true,
        },
      ],
      authentication: "not-checked",
    };
    expect(catalog.authentication).toBe("not-checked");
  });
});
