import { describe, expect, it, vi } from "vitest";
import type { OfficialCuaPolicy } from "../src/subagent/computer-use-policy.js";
import type { SkillLoadOutcome, SkillPort } from "../src/runtime/deps.js";
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

  it("shows only preferred skills in the catalog while still allowing other allowed skills", async () => {
    const skills = ["alpha", "beta"].map((name) => ({
      name,
      description: `${name} skill`,
      directory: `/w/.agents/skills/${name}`,
      frontmatterKeys: ["name", "description"],
      path: `/w/.agents/skills/${name}/SKILL.md`,
      rootPath: "/w/.agents/skills",
      safeToAutoLoad: true,
      scope: "project" as const,
      source: "agents" as const,
    }));
    const loadSkill = vi.fn(async (request: { name: string }) => {
      const metadata = skills.find((skill) => skill.name === request.name);
      if (!metadata) throw new Error("not installed");
      return {
        metadata,
        content: `${metadata.name} instructions`,
        baseDirectory: metadata.directory,
        bytesRead: 20,
        sizeBytes: 20,
        truncated: false,
      };
    });
    const parent = createPort({
      discoverSkills: async () => ({
        skills: skills.map((skill) => ({ ...skill })),
        diagnostics: [],
        totalDiscovered: skills.length,
      }),
      loadSkill,
    } as never);
    const port = resolveSubagentSkillPort(parent, ["*"], cuaPolicy, ["alpha"])!;

    await expect(port.discoverSkills({ workingDirectory: "/w" })).resolves.toMatchObject({
      skills: [expect.objectContaining({ name: "alpha" })],
      totalDiscovered: 1,
    });
    await expect(
      port.loadSkill({ name: "beta", workingDirectory: "/w" }),
    ).resolves.toMatchObject({ content: "beta instructions" });
  });

  it("lets the next child discover and load a skill installed through the previous child port", async () => {
    const installed: SkillLoadOutcome["skills"] = [];
    const parent = createPort({
      discoverSkills: async () => ({
        skills: installed.map((skill) => ({ ...skill })),
        diagnostics: [],
        totalDiscovered: installed.length,
      }),
      installMarketplaceSkill: async (request) => {
        installed.push({
          name: request.skillId,
          description: "Installed on demand",
          directory: "/w/.agents/skills/conventional-commit",
          frontmatterKeys: ["name", "description"],
          path: "/w/.agents/skills/conventional-commit/SKILL.md",
          rootPath: "/w/.agents/skills",
          safeToAutoLoad: true,
          scope: "project",
          source: "agents",
        });
        return {
          name: request.skillId,
          source: request.source,
          skillId: request.skillId,
          path: "/w/.agents/skills/conventional-commit",
          scope: "workspace",
          filesWritten: 2,
          alreadyInstalled: false,
        };
      },
      loadSkill: async (request) => {
        const metadata = installed.find((skill) => skill.name === request.name);
        if (!metadata) throw new Error("not installed");
        return {
          metadata,
          content: "Conventional commit instructions",
          baseDirectory: metadata.directory,
          bytesRead: 32,
          sizeBytes: 32,
          truncated: false,
        };
      },
    } as never);
    const first = resolveSubagentSkillPort(parent, ["*"], cuaPolicy)!;
    await first.installMarketplaceSkill!({
      source: "github/awesome-copilot",
      skillId: "conventional-commit",
      workingDirectory: "/w",
    });

    const second = resolveSubagentSkillPort(parent, ["conventional-commit"], cuaPolicy)!;
    await expect(
      second.discoverSkills({ workingDirectory: "/w" }),
    ).resolves.toMatchObject({
      skills: [expect.objectContaining({ name: "conventional-commit" })],
      totalDiscovered: 1,
    });
    await expect(
      second.loadSkill({ name: "conventional-commit", workingDirectory: "/w" }),
    ).resolves.toMatchObject({ content: "Conventional commit instructions" });
  });
});
