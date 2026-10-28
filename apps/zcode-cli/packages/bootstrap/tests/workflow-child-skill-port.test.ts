import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillRoot } from "@zcode/contracts";
import { createWorkflowChildSkillPort } from "../src/app/workflow-facade.js";

describe("workflow child skill roots", () => {
  it("inherits plugin and bundled skills while withholding dynamic workflow authoring", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-workflow-skills-"));
    const bundledRoot = join(root, "bundled", "skills");
    const pluginRoot = join(root, "plugin", "skills");

    try {
      await writeSkill(bundledRoot, "completion-gate");
      await writeSkill(bundledRoot, "dynamic-workflows");
      await writeSkill(pluginRoot, "plugin-review");

      const bundledSkillRoots: SkillRoot[] = [
        { path: bundledRoot, scope: "system", source: "bundled", priority: 100 },
      ];
      const pluginSkillRoots: SkillRoot[] = [
        {
          path: pluginRoot,
          scope: "admin",
          source: "plugin",
          priority: 50,
          pluginId: "test-plugin",
        },
      ];
      const skillPort = createWorkflowChildSkillPort({
        bundledSkillRoots,
        configuredRoots: [],
        disabledPaths: [],
        enabled: true,
        pluginSkillRoots,
      });

      const discovered = await skillPort?.discoverSkills({ workingDirectory: root });
      const skills = discovered?.skills ?? [];
      expect(skills.map((skill) => skill.name)).toContain("completion-gate");
      expect(skills.map((skill) => skill.name)).toContain("plugin-review");
      expect(skills.map((skill) => skill.name)).not.toContain("dynamic-workflows");
      expect(skills.find((skill) => skill.name === "completion-gate")?.source).toBe("bundled");
      expect(skills.find((skill) => skill.name === "plugin-review")?.source).toBe("plugin");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps skills disabled when the feature is off", () => {
    expect(
      createWorkflowChildSkillPort({
        bundledSkillRoots: [],
        configuredRoots: [],
        disabledPaths: [],
        enabled: false,
        pluginSkillRoots: [],
      }),
    ).toBeUndefined();
  });
});

async function writeSkill(root: string, name: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${name} workflow guidance`, "---", "", `# ${name}`].join(
      "\n",
    ),
  );
}
