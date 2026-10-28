import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { inspectZCodeSkill, listZCodeSkills } from "../src/skills.js";

const bundledSkillNames = [
  "anti-loop",
  "code-craft",
  "reference-first",
  "self-improvement",
  "zcode-swarm",
  "zcode-verification",
  "zcode-systematic-debugging",
  "zcode-test-driven-development",
  "research",
  "domain-modeling",
  "ui-craft",
  "merge-conflict-resolution",
  "handoff",
  "performance-tuning",
  "mcp-authoring",
] as const;

const bundledSkillHeadings: Record<(typeof bundledSkillNames)[number], string> = {
  "anti-loop": "Anti-loop delegation",
  "code-craft": "Code craft",
  "reference-first": "Reference first",
  "self-improvement": "Evidence-driven harness improvement",
  "zcode-swarm": "ZCode swarm coordination",
  "zcode-verification": "ZCode verification",
  "zcode-systematic-debugging": "ZCode systematic debugging",
  "zcode-test-driven-development": "ZCode test-driven development",
  research: "Evidence-led research",
  "domain-modeling": "Domain modeling",
  "ui-craft": "UI craft",
  "merge-conflict-resolution": "Merge conflict resolution",
  handoff: "Handoff",
  "performance-tuning": "Performance tuning",
  "mcp-authoring": "MCP authoring in ZCode",
};

describe("bundled ZCode agent skills", () => {
  it("has matching skill metadata and describes ZCode-owned behavior", async () => {
    for (const name of bundledSkillNames) {
      const body = await readFile(
        new URL(`../../bundled-skills/skills/${name}/SKILL.md`, import.meta.url),
        "utf8",
      );
      const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
      const skillName = frontmatter.match(/^name:\s*(.+)$/mu)?.[1]?.trim();
      const description = frontmatter.match(/^description:\s*(.+)$/mu)?.[1]?.trim();

      expect(skillName).toBe(name);
      expect(description).toBeTruthy();
      expect(description!.length).toBeLessThan(1024);
      expect(description!.slice(0, 250)).toMatch(/ZCode|ZCode Agent/iu);
      expect(body).not.toMatch(/\bTask\s*\(|\.cursor-dev|Cursor product|remaining_spawns/iu);
    }
  });

  it("discovers and loads each skill through the regular bundled SkillPort", async () => {
    const outcome = await listZCodeSkills({
      env: {},
      skipUserConfig: true,
      workingDirectory: process.cwd(),
    });

    for (const name of bundledSkillNames) {
      expect(outcome.skills.find((skill) => skill.name === name)).toMatchObject({
        scope: "system",
        source: "bundled",
      });
      const inspection = await inspectZCodeSkill({
        env: {},
        name,
        skipUserConfig: true,
        workingDirectory: process.cwd(),
      });
      expect(inspection.skill.content).toContain(`# ${bundledSkillHeadings[name]}`);
    }
  });

  it("keeps bootstrap, SEA, Desktop staging, and shipped skill files aligned", async () => {
    const [bootstrapSource, seaSource, desktopSource, remoteSource] = await Promise.all([
      readFile(new URL("../src/app/bundled-skills.ts", import.meta.url), "utf8"),
      readFile(new URL("../../cli/scripts/sea-bundled-skill-assets.mjs", import.meta.url), "utf8"),
      readFile(
        new URL("../../../../../packages/desktop/scripts/stage-agent-bundle.mjs", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../../../packages/server/src/remote/zcodeAgentOfficialPluginAssets.ts", import.meta.url),
        "utf8",
      ),
    ]);
    const extract = (source: string, declaration: string): string[] => {
      const start = source.indexOf(declaration);
      expect(start, `missing ${declaration}`).toBeGreaterThanOrEqual(0);
      const arrayStart = source.indexOf("[", start);
      const arrayEnd = source.indexOf("]", arrayStart);
      expect(arrayEnd).toBeGreaterThan(arrayStart);
      return [...source.slice(arrayStart, arrayEnd).matchAll(/`([^`]+)`|"([^"]+)"/gu)].map(
        (match) => (match[1] ?? match[2]!).replace("${DYNAMIC_WORKFLOW_SKILL_NAME}", "dynamic-workflows"),
      );
    };
    const bootstrapPaths = extract(bootstrapSource, "BUNDLED_SKILL_PACK_REQUIRED_PATHS =");
    const seaPaths = extract(seaSource, "bundledSkillPackRequiredPaths =");
    const desktopPaths = extract(desktopSource, "BUNDLED_SKILL_PACK_REQUIRED_PATHS =");
    const remoteHarnessPaths = [
      ...remoteSource.matchAll(/"(bundled-skills\/[^"]+)"/gu),
    ].map((match) => match[1]!);
    const skillDirectories = await readdir(
      new URL("../../bundled-skills/skills/", import.meta.url),
      { withFileTypes: true },
    );
    const ruleFiles = await readdir(new URL("../../bundled-skills/rules/", import.meta.url), {
      withFileTypes: true,
    });
    const shippedPaths = (
      await Promise.all(
        skillDirectories
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const files = await readdir(
              new URL(`../../bundled-skills/skills/${entry.name}/`, import.meta.url),
              { withFileTypes: true },
            );
            return files
              .filter((file) => file.isFile())
              .map((file) => `skills/${entry.name}/${file.name}`);
          }),
      )
    )
      .flat()
      .concat(
        ruleFiles
          .filter((entry) => entry.isFile())
          .map((entry) => `rules/${entry.name}`),
      )
      .toSorted();

    expect(seaPaths.toSorted()).toEqual(bootstrapPaths.toSorted());
    expect(desktopPaths.toSorted()).toEqual(bootstrapPaths.toSorted());
    expect(remoteHarnessPaths.toSorted()).toEqual(
      bootstrapPaths.map((path) => `bundled-skills/${path}`).toSorted(),
    );
    expect(bootstrapPaths.toSorted()).toEqual(shippedPaths);
  });
});
