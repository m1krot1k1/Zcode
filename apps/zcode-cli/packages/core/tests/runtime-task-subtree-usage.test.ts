import { createSessionId } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import type { RuntimeTaskSnapshot } from "../src/runtime-task/registry-types.js";

function task(input: {
  taskId: string;
  parentTaskId?: string;
  totalTokens?: number;
  durationMs?: number;
  toolUseCount?: number;
}): RuntimeTaskSnapshot {
  return {
    taskId: input.taskId,
    agentId: input.taskId,
    agentType: "coder",
    description: input.taskId,
    prompt: input.taskId,
    status: "completed",
    startedAt: new Date(0),
    completedAt: new Date(1),
    childSessionId: createSessionId(`subagent_${input.taskId}`),
    parentSessionId: createSessionId("root"),
    type: "local_agent",
    ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
    ...(input.totalTokens === undefined &&
    input.durationMs === undefined &&
    input.toolUseCount === undefined
      ? {}
      : {
          usage: {
            ...(input.totalTokens === undefined ? {} : { totalTokens: input.totalTokens }),
            ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
            ...(input.toolUseCount === undefined ? {} : { toolUseCount: input.toolUseCount }),
          },
        }),
  };
}

describe("runtime task subtree usage", () => {
  it("sums own usage and every descendant exactly once", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register(task({ taskId: "root" }));
    registry.register(task({ taskId: "child-a", parentTaskId: "root", totalTokens: 10, durationMs: 100, toolUseCount: 2 }));
    registry.register(task({ taskId: "child-b", parentTaskId: "root", totalTokens: 20, durationMs: 200, toolUseCount: 3 }));
    registry.register(task({ taskId: "grandchild", parentTaskId: "child-a", totalTokens: 5, durationMs: 50, toolUseCount: 1 }));

    expect(
      registry.getSubtreeUsage("root", { totalTokens: 1, durationMs: 10, toolUseCount: 1 }),
    ).toEqual({ totalTokens: 36, totalDurationMs: 360, toolUseCount: 7 });
  });

  it("returns the own usage when there are no descendants", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register(task({ taskId: "leaf" }));

    expect(
      registry.getSubtreeUsage("leaf", { totalTokens: 7, durationMs: 70, toolUseCount: 4 }),
    ).toEqual({ totalTokens: 7, totalDurationMs: 70, toolUseCount: 4 });
  });

  it("returns undefined for an unknown task", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    expect(registry.getSubtreeUsage("missing")).toBeUndefined();
  });
});
