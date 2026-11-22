import { describe, expect, it } from "vitest";
import { shouldRunRootSwarmPlanner } from "../src/runtime/helpers/swarm-planner-gate.js";

describe("root swarm planner gate", () => {
  it("does not run the planner for auto mode", () => {
    expect(
      shouldRunRootSwarmPlanner({
        ownsRootRunBudget: true,
        orchestrationMode: "auto",
      }),
    ).toBe(false);
  });

  it("does not run the planner without an orchestration intent", () => {
    expect(shouldRunRootSwarmPlanner({ ownsRootRunBudget: true })).toBe(false);
  });

  it("runs the planner for an explicit swarm root turn", () => {
    expect(
      shouldRunRootSwarmPlanner({
        ownsRootRunBudget: true,
        orchestrationMode: "swarm",
      }),
    ).toBe(true);
  });

  it("does not reopen the planner for a descendant with inherited swarm root run", () => {
    expect(
      shouldRunRootSwarmPlanner({
        ownsRootRunBudget: true,
        orchestrationMode: "swarm",
        internalSwarmRootRunId: "root-run-1",
      }),
    ).toBe(false);
  });

  it("does not run the planner when the turn does not own the root run budget", () => {
    expect(
      shouldRunRootSwarmPlanner({
        ownsRootRunBudget: false,
        orchestrationMode: "swarm",
      }),
    ).toBe(false);
  });
});
