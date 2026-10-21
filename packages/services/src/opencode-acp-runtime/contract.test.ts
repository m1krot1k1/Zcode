import { describe, expect, it } from "vitest";

import { opencodeAcpRuntimeModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("opencode-acp-runtime contract", () => {
  it("declares its module manifest", () => {
    expect(opencodeAcpRuntimeModule.id).toBe("opencode-acp-runtime");
  });
});
