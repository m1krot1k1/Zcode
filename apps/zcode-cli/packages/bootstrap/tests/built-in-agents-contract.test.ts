import { describe, expect, it } from "vitest";
import { BUILT_IN_AGENT_SUMMARIES } from "@zcode/shared";
import { BUILT_IN_SWARM_PROFILES } from "@zcode/core";

describe("shared built-in agent catalog", () => {
  it("matches the runtime roster exactly", () => {
    expect(
      BUILT_IN_AGENT_SUMMARIES.map((agent) => ({
        name: agent.name,
        description: agent.description,
        color: agent.color,
        tools: [...agent.tools],
        skills: [...agent.skills],
        injectAgentsMd: agent.injectAgentsMd,
        memory: agent.memory,
      })),
    ).toEqual(
      BUILT_IN_SWARM_PROFILES.map((profile) => ({
        name: profile.name,
        description: profile.description,
        color: profile.color,
        tools: profile.tools ? [...profile.tools] : undefined,
        skills: profile.skills ? [...profile.skills] : undefined,
        injectAgentsMd: profile.injectAgentsMd,
        memory: profile.memory,
      })),
    );
  });
});
