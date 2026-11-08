import { describe, expect, it } from "vitest";

import { exampleAgentWorkbenchProps } from "./contract.example.js";
import { agentWorkbenchModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("agent-workbench contract", () => {
  it("declares its module manifest", () => {
    expect(agentWorkbenchModule.id).toBe("agent-workbench");
    expect(agentWorkbenchModule.requires).toEqual([
      "code-intelligence",
      "services",
      "shared",
      "ui",
    ]);
  });

  it("demonstrates the dashboard workspace identity props", () => {
    expect(exampleAgentWorkbenchProps.workspacePath).toBe("/path/to/workspace");
    expect(exampleAgentWorkbenchProps.workspaceIdentity).toBe("local-workspace");
  });
});
