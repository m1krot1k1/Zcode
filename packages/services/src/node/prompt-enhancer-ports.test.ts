import { describe, expect, it, vi } from "vitest";
import type { ISkillsService } from "../skills/skills.js";
import type { ISubagentsService } from "../subagents/subagents.js";
import { createPromptEnhancerCapabilityIndexProvider } from "./prompt-enhancer-ports.js";

function skillsService(names: readonly string[]): Pick<ISkillsService, "list"> {
  return {
    list: vi.fn(async () => ({
      skills: names.map((name) => ({
        id: `skill:${name}`,
        name,
        description: `${name} description`,
        body: "",
        path: `/repo/.agents/skills/${name}/SKILL.md`,
        scope: "workspace" as const,
        enabled: true,
      })),
      capability: { userScopeAvailable: true },
      diagnostics: [],
    })),
  };
}

function subagentsService(names: readonly string[]): Pick<ISubagentsService, "list"> {
  return {
    list: vi.fn(async () => ({
      agents: [],
      userAgents: names.map((name) => ({
        id: `user:${name}`,
        name,
        description: `${name} agent`,
        systemPrompt: "",
        path: `/home/.zcode/agents/${name}.md`,
        scope: "user" as const,
        source: "user" as const,
        enabled: true,
      })),
      pluginAgents: [],
      capability: { userScopeAvailable: true },
      diagnostics: [],
    })),
  };
}

describe("prompt enhancer capability index provider", () => {
  it("merges skills and user agents into one installed index", async () => {
    const provider = createPromptEnhancerCapabilityIndexProvider({
      skillsService: skillsService(["yandex-direct"]),
      subagentsService: subagentsService(["reviewer"]),
    });
    const entries = await provider.list({ workspacePath: "/repo/zcode" });
    expect(entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
      "skill:yandex-direct",
      "agent:reviewer",
    ]);
  });

  it("caches per workspace identity and refreshes after the TTL", async () => {
    let now = 1_000;
    const skills = skillsService(["first"]);
    const provider = createPromptEnhancerCapabilityIndexProvider({
      skillsService: skills,
      subagentsService: subagentsService([]),
      now: () => now,
      ttlMs: 1_000,
    });

    await provider.list({ workspacePath: "/repo/a" });
    await provider.list({ workspacePath: "/repo/a", workspaceIdentity: "remote:a" });
    // Identity is a separate cache key: path fallback must not leak into remote cache.
    expect(skills.list).toHaveBeenCalledTimes(2);

    now += 1_001;
    await provider.list({ workspacePath: "/repo/a" });
    expect(skills.list).toHaveBeenCalledTimes(3);
  });

  it("keeps agent entries when the skills scan fails", async () => {
    const failingSkills: Pick<ISkillsService, "list"> = {
      list: vi.fn(async () => {
        throw new Error("permission denied");
      }),
    };
    const provider = createPromptEnhancerCapabilityIndexProvider({
      skillsService: failingSkills,
      subagentsService: subagentsService(["reviewer"]),
    });
    const entries = await provider.list({ workspacePath: "/repo/zcode" });
    expect(entries.map((entry) => entry.name)).toEqual(["reviewer"]);
  });
});
