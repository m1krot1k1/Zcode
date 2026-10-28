import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeContextSourceAdapter } from "@zcode/adapters/context";
import { getSwarmAgentProfiles, SWARM_AGENT_TYPES } from "@zcode/core";
import { describe, expect, it } from "vitest";
import { loadZCodeAgentProfiles } from "../src/subagents.js";
import { inspectZCodeSkill, listZCodeSkills } from "../src/skills.js";

describe("native harness independence from Cursor files", () => {
  it("loads the same ZCode agents, bundled rules, and skills with conflicting .cursor files", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-native-harness-isolation-"));
    const home = join(root, "empty-home");
    const baselineWorkspace = join(root, "baseline-workspace");
    const conflictingWorkspace = join(root, "conflicting-workspace");
    const storageRoot = join(home, ".zcode", "cli");

    try {
      await Promise.all([
        mkdir(home, { recursive: true }),
        mkdir(baselineWorkspace, { recursive: true }),
        mkdir(join(conflictingWorkspace, ".cursor", "agents"), { recursive: true }),
        mkdir(join(conflictingWorkspace, ".cursor", "rules"), { recursive: true }),
        mkdir(join(conflictingWorkspace, ".cursor", "skills", "research"), {
          recursive: true,
        }),
        mkdir(join(conflictingWorkspace, ".cursor", "skills", "cursor-only"), {
          recursive: true,
        }),
      ]);
      expect(await readdir(home)).toEqual([]);

      await Promise.all([
        writeFile(
          join(conflictingWorkspace, ".cursor", "agents", "reviewer.md"),
          "---\nname: reviewer\ndescription: Cursor override\n---\nCURSOR_AGENT_SENTINEL",
        ),
        writeFile(
          join(conflictingWorkspace, ".cursor", "agents", "cursor-only.md"),
          "---\nname: cursor-only\ndescription: Cursor-only profile\n---\nCURSOR_AGENT_ONLY_SENTINEL",
        ),
        writeFile(
          join(conflictingWorkspace, ".cursor", "rules", "always.mdc"),
          "---\ndescription: Cursor override\nalwaysApply: true\n---\nCURSOR_RULE_SENTINEL",
        ),
        writeFile(
          join(conflictingWorkspace, ".cursor", "skills", "research", "SKILL.md"),
          "---\nname: research\ndescription: Cursor override\n---\nCURSOR_SKILL_SENTINEL",
        ),
        writeFile(
          join(conflictingWorkspace, ".cursor", "skills", "cursor-only", "SKILL.md"),
          "---\nname: cursor-only\ndescription: Cursor-only skill\n---\nCURSOR_SKILL_ONLY_SENTINEL",
        ),
      ]);

      const loadRuntimeSurface = async (workingDirectory: string) => {
        const [agentConfig, context, skillCatalog, researchSkill] = await Promise.all([
          loadZCodeAgentProfiles({ storageRoot, workingDirectory }),
          createNodeContextSourceAdapter({ env: { HOME: home } }).resolveContextSources({
            workingDirectory,
          }),
          listZCodeSkills({
            env: { HOME: home, ZCODE_STORAGE_DIR: join(home, ".zcode") },
            skipUserConfig: true,
            workingDirectory,
          }),
          inspectZCodeSkill({
            env: { HOME: home, ZCODE_STORAGE_DIR: join(home, ".zcode") },
            name: "research",
            skipUserConfig: true,
            workingDirectory,
          }),
        ]);

        return {
          agentNames: getSwarmAgentProfiles(agentConfig.profiles).map((profile) => profile.name),
          configuredAgents: agentConfig.profiles.map(({ name, description, source }) => ({
            name,
            description,
            source,
          })),
          bundledRules: context.bundledHarnessRules,
          workspaceRules: context.workspaceRules ?? [],
          skills: skillCatalog.skills.map(({ name, description, source }) => ({
            name,
            description,
            source,
          })),
          researchSkill: researchSkill.skill.content,
        };
      };

      const baseline = await loadRuntimeSurface(baselineWorkspace);
      const withCursorFiles = await loadRuntimeSurface(conflictingWorkspace);

      expect(baseline.agentNames).toEqual([...SWARM_AGENT_TYPES]);
      expect(withCursorFiles.agentNames).toEqual(baseline.agentNames);
      expect(baseline.configuredAgents).toEqual([]);
      expect(withCursorFiles.configuredAgents).toEqual(baseline.configuredAgents);
      expect(baseline.bundledRules?.length).toBeGreaterThan(0);
      expect(withCursorFiles.bundledRules).toEqual(baseline.bundledRules);
      expect(withCursorFiles.workspaceRules).toEqual(baseline.workspaceRules);
      expect(withCursorFiles.workspaceRules).toEqual([]);
      expect(withCursorFiles.skills).toEqual(baseline.skills);
      expect(withCursorFiles.skills.map((skill) => skill.name)).not.toContain("cursor-only");
      expect(withCursorFiles.researchSkill).toEqual(baseline.researchSkill);
      expect(withCursorFiles.researchSkill).not.toContain("CURSOR_SKILL_SENTINEL");
      expect(JSON.stringify(withCursorFiles.bundledRules)).not.toContain("CURSOR_RULE_SENTINEL");
      expect(JSON.stringify(withCursorFiles.agentNames)).not.toContain("cursor-only");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
