import { describe, expect, it } from "vitest";

import {
  resolveSubagentEffortLevel,
  type ResolveSubagentEffortLevelInput,
} from "../src/runtime/helpers/subagent-effort.js";
import { applySubagentEffortSelection } from "../src/runtime/methods/subagent/effort-application.js";
import { createInheritedSubagentModelFactory } from "../src/runtime/methods/subagent/model-factory.js";

const LEVELS = ["disabled", "low", "medium", "high", "max"] as const;

function resolve(
  input: Partial<ResolveSubagentEffortLevelInput> & Pick<ResolveSubagentEffortLevelInput, "effort">,
) {
  return resolveSubagentEffortLevel({ supportedLevels: LEVELS, ...input });
}

describe("resolveSubagentEffortLevel", () => {
  it("never lowers into a disabled level on a sparse enabled/disabled scale", () => {
    const sparse = ["disabled", "enabled"] as const;
    expect(
      resolveSubagentEffortLevel({
        effort: "lower",
        supportedLevels: sparse,
        baseLevel: "enabled",
        parentLevel: "enabled",
      }),
    ).toEqual({ level: "enabled", outcome: "applied" });
    expect(
      resolveSubagentEffortLevel({
        effort: "lowest",
        supportedLevels: sparse,
      }),
    ).toEqual({ level: "enabled", outcome: "applied" });
  });

  it("selects the lowest working level and skips disabled", () => {
    expect(
      resolve({
        effort: "lowest",
        baseLevel: "max",
        parentLevel: "max",
      }),
    ).toEqual({ level: "low", outcome: "applied" });
    expect(
      resolveSubagentEffortLevel({
        effort: "lowest",
        supportedLevels: ["disabled", "off"],
      }),
    ).toEqual({ outcome: "no-supported-levels" });
    expect(resolve({ effort: "lower", baseLevel: "max", parentLevel: "max" })).toMatchObject({
      level: "high",
      outcome: "applied",
    });
  });

  it("forces the highest supported level for the orchestrator policy", () => {
    expect(
      resolveSubagentEffortLevel({
        policy: "highest",
        effort: "lower",
        baseLevel: "low",
        parentLevel: "low",
        supportedLevels: LEVELS,
      }),
    ).toEqual({ level: "max", outcome: "applied" });
    expect(
      resolveSubagentEffortLevel({
        policy: "highest",
        supportedLevels: [],
      }),
    ).toEqual({ outcome: "no-supported-levels" });
  });

  it("applies orchestrator highest without changing the selected model", () => {
    const childModel = {
      optionSpecs: { reasoningLevel: { values: [...LEVELS] } },
      options: { reasoningLevel: "low" },
    } as never;
    const factory = (() => childModel) as never;
    const result = applySubagentEffortSelection({
      agentType: "orchestrator",
      childModel,
      childSelection: {
        modelId: "deepseek-v4.1-flash",
        options: { reasoningLevel: "low" },
        providerId: "opencode-go",
      },
      parentSelection: {
        modelId: "deepseek-v4.1-flash",
        options: { reasoningLevel: "low" },
        providerId: "opencode-go",
      },
      parentModel: {
        options: { reasoningLevel: "low" },
      } as never,
      baseFactory: factory,
      rebuildFactory: () => factory,
    });

    expect(result.childSelection.providerId).toBe("opencode-go");
    expect(result.childSelection.modelId).toBe("deepseek-v4.1-flash");
    expect(result.childSelection.options?.reasoningLevel).toBe("max");
  });

  it("keeps orchestrator max through the inherited-model factory", () => {
    const inheritedSelection = {
      modelId: "deepseek-v4.1-flash",
      options: { reasoningLevel: "low" },
      providerId: "opencode-go",
    };
    const inheritedModel = {
      optionSpecs: { reasoningLevel: { values: [...LEVELS] } },
      options: { reasoningLevel: "low" },
      providerId: "opencode-go",
      modelId: "deepseek-v4.1-flash",
    } as never;
    const maxModel = {
      optionSpecs: { reasoningLevel: { values: [...LEVELS] } },
      options: { reasoningLevel: "max" },
      providerId: "opencode-go",
      modelId: "deepseek-v4.1-flash",
    } as never;
    const fallback = (() => maxModel) as never;
    const buildFactory = (selection: typeof inheritedSelection) =>
      createInheritedSubagentModelFactory(selection, inheritedModel, fallback);

    const result = applySubagentEffortSelection({
      agentType: "orchestrator",
      childModel: inheritedModel,
      childSelection: inheritedSelection,
      parentSelection: inheritedSelection,
      parentModel: inheritedModel,
      baseFactory: buildFactory(inheritedSelection),
      rebuildFactory: (selection) => buildFactory(selection as typeof inheritedSelection),
    });

    expect(result.childSelection.options?.reasoningLevel).toBe("max");
    expect((result.childModel as { options?: { reasoningLevel?: string } }).options?.reasoningLevel).toBe(
      "max",
    );
  });

  it("is a no-op for models without reasoning levels", () => {
    expect(
      resolveSubagentEffortLevel({
        effort: "lower",
        baseLevel: "high",
        parentLevel: "high",
        supportedLevels: [],
      }),
    ).toEqual({ outcome: "no-supported-levels" });
  });

  it("keeps the resolved selection for an unknown class without throwing", () => {
    expect(resolve({ effort: "extreme", baseLevel: "medium", parentLevel: "high" })).toEqual({
      outcome: "unknown-class",
      level: "medium",
    });
  });

  it("lowers, keeps and raises within a comparable scale", () => {
    expect(resolve({ effort: "lower", baseLevel: "medium", parentLevel: "medium" })).toMatchObject({
      level: "low",
      outcome: "applied",
    });
    expect(resolve({ effort: "same", baseLevel: "medium", parentLevel: "medium" })).toMatchObject({
      level: "medium",
      outcome: "applied",
    });
    expect(
      resolve({ effort: "higher", baseLevel: "medium", parentLevel: "medium" }),
    ).toMatchObject({ level: "medium", outcome: "clamped" });
  });

  it("allows elevation above the parent only with the explicit flag", () => {
    expect(
      resolve({
        effort: "higher",
        effortAboveParent: true,
        baseLevel: "medium",
        parentLevel: "medium",
      }),
    ).toMatchObject({ level: "high", outcome: "applied" });
  });

  it("clamps a profile override above the parent when a class is supplied", () => {
    expect(resolve({ effort: "same", baseLevel: "max", parentLevel: "medium" })).toMatchObject({
      level: "medium",
      outcome: "clamped",
    });
    expect(resolve({ effort: "lower", baseLevel: "max", parentLevel: "max" })).toMatchObject({
      level: "high",
      outcome: "applied",
    });
  });

  it("anchors to a supported parent level when the base level is foreign to the child model", () => {
    expect(
      resolveSubagentEffortLevel({
        effort: "lower",
        supportedLevels: ["low", "high"],
        baseLevel: "minimal",
        parentLevel: "high",
      }),
    ).toEqual({ level: "low", outcome: "applied", baseClamped: true });
  });

  it("falls back to the lowest supported level when neither anchor is supported", () => {
    expect(
      resolveSubagentEffortLevel({
        effort: "same",
        supportedLevels: ["low", "high"],
        baseLevel: "minimal",
        parentLevel: "max",
      }),
    ).toEqual({ level: "low", outcome: "applied", baseClamped: true });
    expect(
      resolveSubagentEffortLevel({
        effort: "higher",
        supportedLevels: ["low", "high"],
        baseLevel: "minimal",
        parentLevel: "max",
      }),
    ).toEqual({ level: "low", outcome: "elevation-denied", baseClamped: true });
  });

  it("reports no-anchor when neither base nor parent level exists", () => {
    expect(resolve({ effort: "lower" })).toEqual({ outcome: "no-anchor" });
  });

  it("clamps at the bottom and top of the scale", () => {
    expect(resolve({ effort: "lower", baseLevel: "disabled", parentLevel: "max" })).toMatchObject({
      level: "low",
      outcome: "applied",
    });
    expect(
      resolve({
        effort: "higher",
        effortAboveParent: true,
        baseLevel: "max",
        parentLevel: "max",
      }),
    ).toMatchObject({ level: "max", outcome: "applied" });
  });
});
