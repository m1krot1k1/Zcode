import { describe, expect, it } from "vitest";

import type { CliModelCacheControlContract } from "./contract.js";
import { cliModelCacheControlModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("cli-model-cache-control contract", () => {
  it("declares its module manifest and public entrypoints", () => {
    expect(cliModelCacheControlModule.id).toBe("cli-model-cache-control");
    expect(cliModelCacheControlModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
    const assertContractType = (_value?: CliModelCacheControlContract) => Boolean(_value);
    expect(assertContractType()).toBe(false);
  });
});
