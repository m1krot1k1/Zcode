import { describe, expect, it, vi } from "vitest";
import type { OfficialCuaPolicy } from "../src/subagent/computer-use-policy.js";
import type { SkillPort } from "../src/runtime/deps.js";
import { resolveSubagentSkillPort } from "../src/runtime/methods/subagent/skill-port.js";

const cuaPolicy: OfficialCuaPolicy = {
  serverNames: new Set(),
  isOfficialToolRequest: () => false,
  isOfficialServerSelector: () => false,
  isOfficialSkillRequest: () => false,
  isOfficialSkill: () => false,
};

function createPort(overrides: Partial<SkillPort>): SkillPort {
  return {
    discoverSkills: async () => ({ skills: [], diagnostics: [], totalDiscovered: 0 }),
    loadSkill: async () => {
      throw new Error("not used");
    },
    ...overrides,
  } as SkillPort;
}

describe("FilteredSkillPort marketplace delegation", () => {
  it("delegates search and install to the parent port", async () => {
    const searchMarketplace = vi.fn(async () => ({ items: [], total: 0 }));
    const installMarketplaceSkill = vi.fn(async () => ({
      skill: undefined,
      installed: true,
    }));
    const port = resolveSubagentSkillPort(
      createPort({ searchMarketplace, installMarketplaceSkill } as never),
      ["*"],
      cuaPolicy,
    )!;

    await expect(port.searchMarketplace!({ query: "x", workingDirectory: "/w" })).resolves.toEqual({
      items: [],
      total: 0,
    });
    await port.installMarketplaceSkill!({
      source: "org/repo",
      skillId: "skill",
      workingDirectory: "/w",
    });
    expect(searchMarketplace).toHaveBeenCalledWith({ query: "x", workingDirectory: "/w" }, undefined);
    expect(installMarketplaceSkill).toHaveBeenCalled();
  });

  it("fails closed when the parent has no marketplace bridge", async () => {
    const port = resolveSubagentSkillPort(createPort({}), ["*"], cuaPolicy)!;
    await expect(
      port.searchMarketplace!({ query: "x", workingDirectory: "/w" }),
    ).rejects.toThrow(/marketplace search is not available/u);
    await expect(
      port.installMarketplaceSkill!({
        source: "org/repo",
        skillId: "skill",
        workingDirectory: "/w",
      }),
    ).rejects.toThrow(/marketplace install is not available/u);
  });
});
