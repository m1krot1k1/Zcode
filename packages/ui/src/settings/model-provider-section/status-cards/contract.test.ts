import { describe, expect, it } from "vitest";

import { uiModelProviderStatusCardsModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("ui-model-provider-status-cards contract", () => {
  it("declares its module manifest", () => {
    expect(uiModelProviderStatusCardsModule.id).toBe("ui-model-provider-status-cards");
  });
});
