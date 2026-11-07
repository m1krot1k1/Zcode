import { describe, expect, it, vi } from "vitest";
import { createSessionId, createTraceId } from "@zcode/contracts";
import type {
  SkillContent,
  SkillLoadOutcome,
  SkillMarketplaceInstallResult,
  SkillMarketplaceSearchResult,
  SkillPort,
} from "@zcode/contracts";
import {
  skillInstallHandler,
  skillSearchHandler,
} from "../src/tool/handlers/skill-marketplace.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const outcome: SkillLoadOutcome = { skills: [], diagnostics: [], totalDiscovered: 0 };

function contextWith(port: SkillPort): ToolExecutionContext {
  return {
    toolCallId: "tool-skill-marketplace",
    traceId: createTraceId(),
    abortSignal: new AbortController().signal,
    skillPort: port,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionId: createSessionId("skill-marketplace-test"),
  };
}

const basePort: SkillPort = {
  async discoverSkills(): Promise<SkillLoadOutcome> {
    return outcome;
  },
  async loadSkill(): Promise<SkillContent> {
    throw new Error("not used");
  },
};

describe("skill marketplace tools", () => {
  it("formats search results with exact install coordinates", async () => {
    const searchMarketplace = vi.fn(
      async (): Promise<SkillMarketplaceSearchResult> => ({
        query: "react",
        items: [
          {
            id: "vercel-labs/agent-skills/vercel-react-best-practices",
            source: "vercel-labs/agent-skills",
            skillId: "vercel-react-best-practices",
            name: "vercel-react-best-practices",
            installs: 877_745,
            installed: false,
          },
        ],
      }),
    );
    const result = await skillSearchHandler(
      { query: "react" },
      contextWith({ ...basePort, searchMarketplace }),
    );

    expect(searchMarketplace).toHaveBeenCalledWith(
      { query: "react", owner: undefined, limit: undefined, workingDirectory: "/workspace" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toContain("vercel-labs/agent-skills/vercel-react-best-practices");
    expect(result).toContain("877745 installs");
    expect(result).toContain("SkillInstall");
  });

  it("reports the installed name and tells the agent to load it immediately", async () => {
    const installMarketplaceSkill = vi.fn(
      async (): Promise<SkillMarketplaceInstallResult> => ({
        name: "find-skills",
        source: "vercel-labs/skills",
        skillId: "find-skills",
        path: "/workspace/.agents/skills/find-skills",
        scope: "workspace",
        filesWritten: 3,
        hash: "hash",
        alreadyInstalled: false,
      }),
    );
    const result = await skillInstallHandler(
      { source: "vercel-labs/skills", skillId: "find-skills" },
      contextWith({ ...basePort, installMarketplaceSkill }),
    );

    expect(result).toContain('Skill "find-skills" is installed');
    expect(result).toContain('Skill { skill: "find-skills" }');
    expect(result).toContain("Files written: 3");
  });

  it("fails closed when the runtime has no marketplace bridge", async () => {
    await expect(skillSearchHandler({ query: "react" }, contextWith(basePort))).rejects.toThrow(
      "not available in this runtime",
    );
    await expect(
      skillInstallHandler(
        { source: "vercel-labs/skills", skillId: "find-skills" },
        contextWith(basePort),
      ),
    ).rejects.toThrow("not available in this runtime");
  });
});
