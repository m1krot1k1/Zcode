import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { assertNoUnresolvedChildTasks } from "../src/runtime/methods/subagent/execution-guard.js";
import type { RuntimeTaskRegistry } from "../src/runtime-task/registry.js";

function registryWith(tasks: Array<Record<string, unknown>>): RuntimeTaskRegistry {
  return {
    all: () => Object.fromEntries(tasks.map((task) => [String(task.taskId), task])),
  } as unknown as RuntimeTaskRegistry;
}

const parentSessionId = createSessionId("terminal-gate-parent");

describe("subagent terminal gate", () => {
  it("rejects a successful report while a direct child is still running", () => {
    const registry = registryWith([
      {
        taskId: "agent_open",
        type: "local_agent",
        parentSessionId,
        status: "running",
      },
    ]);

    expect(() =>
      assertNoUnresolvedChildTasks(registry, {
        sessionId: parentSessionId,
        agentType: "orchestrator",
      }),
    ).toThrow("direct child task(s) were still active: agent_open");
  });

  it("ignores terminal children, other parents, and non-agent tasks", () => {
    const registry = registryWith([
      {
        taskId: "agent_done",
        type: "local_agent",
        parentSessionId,
        status: "completed",
      },
      {
        taskId: "agent_other_parent",
        type: "local_agent",
        parentSessionId: createSessionId("other-parent"),
        status: "running",
      },
      {
        taskId: "bash_running",
        type: "local_bash",
        parentSessionId,
        status: "running",
      },
    ]);

    expect(() =>
      assertNoUnresolvedChildTasks(registry, {
        sessionId: parentSessionId,
        agentType: "orchestrator",
      }),
    ).not.toThrow();
  });
});
