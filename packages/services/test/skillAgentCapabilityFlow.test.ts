import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePromptEnhanceCapabilities } from "@zcode/shared";
import { createSkillsService } from "../src/skills/skillsService.js";
import { createSubagentsService } from "../src/subagents/subagentsService.js";
import { resolveUserSubagentRoot } from "../src/subagents/subagentStorage.js";
import { createPromptEnhancerCapabilityIndexProvider } from "../src/node/prompt-enhancer-ports.js";

const originalHome = process.env.HOME;
const tempRoots: string[] = [];

async function makeTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "zcode-skill-agent-e2e-"));
  tempRoots.push(home);
  return home;
}

async function writeMarketplaceSkill(workspacePath: string, name: string): Promise<void> {
  const directory = join(workspacePath, ".agents", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      "description: Manage Yandex Direct ad campaigns and budgets",
      "---",
      "",
      `Use ${name} to plan and verify advertising work.`,
    ].join("\n"),
    "utf8",
  );
}

afterEach(async () => {
  process.env.HOME = originalHome;
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("skill → agent → capability resolver E2E flow", () => {
  it("backfills the same-name agent and reports the capability as installed", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    await writeMarketplaceSkill(workspacePath, "yandex-direct");

    const subagentsService = createSubagentsService({
      homeDir: home,
      isDesktopRuntime: true,
    });
    const skillsService = createSkillsService({
      isDesktopRuntime: true,
      onSkillsListed: async ({ workspacePath: listedWorkspace, skills }) => {
        for (const skill of skills) {
          if (skill.scope === "plugin" || skill.pluginName) continue;
          if (!/[\\/]\.agents[\\/]skills[\\/]/u.test(skill.path)) continue;
          await (
            await import("../src/subagents/subagentsService.js")
          ).provisionSkillAgentProfile({
            skillName: skill.name,
            description: skill.description,
            homeDir: home,
          });
        }
        void listedWorkspace;
      },
    });

    await skillsService.list({ workspacePath, provider: "glm" });

    const agentPath = join(await resolveUserSubagentRoot({ homeDir: home }), "yandex-direct.md");
    const markdown = await readFile(agentPath, "utf8");
    expect(markdown).toContain('name: "yandex-direct"');
    expect(markdown).toContain("yandex-direct");

    const agents = await subagentsService.list({
      workspacePath,
      mode: "settingsUserOnly",
    });
    expect(agents.userAgents).toEqual([
      expect.objectContaining({
        name: "yandex-direct",
        source: "user",
        skills: ["yandex-direct"],
      }),
    ]);

    const provider = createPromptEnhancerCapabilityIndexProvider({
      skillsService,
      subagentsService,
    });
    const entries = await provider.list({ workspacePath });
    expect(entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(
      expect.arrayContaining(["skill:yandex-direct", "agent:yandex-direct"]),
    );

    const suggestions = resolvePromptEnhanceCapabilities({
      draftText: "Set up Yandex Direct campaigns for the new offer and report the budget",
      classification: { domain: "marketing", taskKind: "planning" },
      index: entries,
    });
    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "yandex-direct",
          installed: true,
          requiresConsent: true,
        }),
      ]),
    );
  });

  it("does not overwrite a hand-edited profile on a later backfill pass", async () => {
    const home = await makeTempHome();
    const workspacePath = join(home, "workspace");
    process.env.HOME = home;
    await writeMarketplaceSkill(workspacePath, "frontend-design");
    const agentRoot = await resolveUserSubagentRoot({ homeDir: home });
    await mkdir(agentRoot, { recursive: true });
    const handEdited = [
      "---",
      'name: "frontend-design"',
      "description: Hand-edited specialist",
      "tools:",
      '  - "Read"',
      "skills:",
      '  - "frontend-design"',
      "---",
      "",
      "Keep my custom instructions.",
    ].join("\n");
    await writeFile(join(agentRoot, "frontend-design.md"), handEdited, "utf8");

    const service = createSkillsService({
      isDesktopRuntime: true,
      onSkillsListed: async ({ skills }) => {
        for (const skill of skills) {
          if (!/[\\/]\.agents[\\/]skills[\\/]/u.test(skill.path)) continue;
          await (
            await import("../src/subagents/subagentsService.js")
          ).provisionSkillAgentProfile({
            skillName: skill.name,
            description: skill.description,
            homeDir: home,
          });
        }
      },
    });

    await service.list({ workspacePath, provider: "glm" });
    await expect(readFile(join(agentRoot, "frontend-design.md"), "utf8")).resolves.toBe(handEdited);
  });
});
