import { describe, expect, it } from "vitest";
import {
  isExplicitRoutingCommandInput,
  shouldRunRootSwarmPlanner,
} from "../src/runtime/helpers/swarm-planner-gate.js";

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

  // 回归：`/start` 展开后根只允许调用 Task(start)，而 Swarm 分支会把根的全部工具（含 Task）
  // 塞进 disallowlist。两条编排同开时 `/start` 永远执行不了自己唯一的动作。
  it("does not run the planner when the turn is an explicit routing command", () => {
    expect(
      shouldRunRootSwarmPlanner({
        ownsRootRunBudget: true,
        orchestrationMode: "swarm",
        explicitRoutingCommand: true,
      }),
    ).toBe(false);
  });

  it("still runs the planner for an explicit swarm turn with free-form input", () => {
    expect(
      shouldRunRootSwarmPlanner({
        ownsRootRunBudget: true,
        orchestrationMode: "swarm",
        explicitRoutingCommand: false,
      }),
    ).toBe(true);
  });
});

describe("explicit routing command detection", () => {
  it.each(["start", "review", "evolve", "evaluate"])("recognises /%s", (name) => {
    expect(isExplicitRoutingCommandInput(`/${name} do the thing`)).toBe(true);
    expect(isExplicitRoutingCommandInput(`/${name}`)).toBe(true);
    expect(isExplicitRoutingCommandInput(`  /${name.toUpperCase()} do the thing  `)).toBe(true);
  });

  // `/init` 是一次普通写入任务，`/workflow` 的工具面由动态工作流闸门管；两者都不该关掉 swarm。
  it.each(["init", "workflow", "compact", "help"])("ignores /%s", (name) => {
    expect(isExplicitRoutingCommandInput(`/${name} do the thing`)).toBe(false);
  });

  it("ignores ordinary prose that merely mentions the command", () => {
    expect(isExplicitRoutingCommandInput("please /start this")).toBe(false);
    expect(isExplicitRoutingCommandInput("run the start profile")).toBe(false);
    expect(isExplicitRoutingCommandInput("/starting point")).toBe(false);
    expect(isExplicitRoutingCommandInput("")).toBe(false);
    expect(isExplicitRoutingCommandInput(undefined)).toBe(false);
  });
});
