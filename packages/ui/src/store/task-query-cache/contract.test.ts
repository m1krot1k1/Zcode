import { describe, expect, it } from "vitest";

import { uiTaskQueryCacheModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("ui-task-query-cache contract", () => {
  it("declares its module manifest", () => {
    expect(uiTaskQueryCacheModule.id).toBe("ui-task-query-cache");
  });
});
