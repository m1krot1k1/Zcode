import { describe, expect, it } from "vitest";
import { executeToolBatch } from "../src/tool/executor/batch-runner.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";
import type { ExecutableToolCall, ToolExecutionResult } from "../src/tool/types.js";

function completed(call: ExecutableToolCall): ToolExecutionResult {
  const now = new Date();
  return {
    toolCallId: call.id,
    toolName: call.name,
    success: true,
    output: "",
    durationMs: 0,
    startedAt: now,
    completedAt: now,
  };
}

describe("executeToolBatch", () => {
  it("passes the number of sibling Agent/Task calls to every call", async () => {
    const seen: Array<number | undefined> = [];
    const calls: ExecutableToolCall[] = [
      { id: "agent-1", name: "Agent", input: {} },
      { id: "agent-2", name: "Agent", input: {} },
      { id: "read-1", name: "Read", input: {} },
    ];

    await executeToolBatch(
      { maxConcurrency: 10 } as ToolExecutorDeps,
      async (call, options) => {
        seen.push(options?.parallelAgentBatchSize);
        return completed(call);
      },
      calls,
    );

    expect(seen).toEqual([2, 2, 2]);
  });

  it("does not count a lone Agent as a parallel agent batch", async () => {
    const seen: Array<number | undefined> = [];
    const calls: ExecutableToolCall[] = [
      { id: "agent-1", name: "Agent", input: {} },
      { id: "read-1", name: "Read", input: {} },
    ];

    await executeToolBatch(
      { maxConcurrency: 10 } as ToolExecutorDeps,
      async (call, options) => {
        seen.push(options?.parallelAgentBatchSize);
        return completed(call);
      },
      calls,
    );

    expect(seen).toEqual([1, 1]);
  });
});
