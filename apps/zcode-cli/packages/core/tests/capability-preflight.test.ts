import { describe, expect, it, vi } from "vitest";
import type { SkillMetadata, SkillPort } from "@zcode/contracts";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { assertRequiredCapabilities } from "../src/tool/handlers/agent.js";

type CapabilityContext = Pick<
  ToolExecutionContext,
  "skillPort" | "capabilityInstallPort" | "workingDirectory" | "traceContext" | "toolCallId"
>;

function skill(name: string, qualifiedName?: string): SkillMetadata {
  return {
    name,
    description: "test",
    path: `/skills/${name}/SKILL.md`,
    directory: `/skills/${name}`,
    rootPath: "/skills",
    scope: "project",
    source: "zcode",
    safeToAutoLoad: false,
    frontmatterKeys: [],
    ...(qualifiedName ? { qualifiedName } : {}),
  };
}

function contextWith(
  discover: SkillPort["discoverSkills"] | null,
  capabilityInstallPort?: CapabilityContext["capabilityInstallPort"],
): CapabilityContext {
  return {
    workingDirectory: "/workspace",
    toolCallId: "call-1",
    ...(discover ? { skillPort: { discoverSkills: discover } as unknown as SkillPort } : {}),
    ...(capabilityInstallPort ? { capabilityInstallPort } : {}),
  } as CapabilityContext;
}

describe("Task capability preflight", () => {
  it("does not touch the skill registry without requires", async () => {
    const discover = vi.fn();
    await expect(assertRequiredCapabilities(undefined, contextWith(discover))).resolves.toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
  });

  it("accepts an installed skill by exact or qualified name", async () => {
    const discover = vi.fn(async () => ({
      skills: [skill("review", "plugin:review")],
      diagnostics: [],
      totalDiscovered: 1,
    }));
    await expect(
      assertRequiredCapabilities(["skill:review"], contextWith(discover)),
    ).resolves.toBeUndefined();
    await expect(
      assertRequiredCapabilities(["skill:plugin:review"], contextWith(discover)),
    ).resolves.toBeUndefined();
  });

  it("rejects the spawn when a required skill is not installed", async () => {
    const discover = vi.fn(async () => ({
      skills: [skill("review")],
      diagnostics: [],
      totalDiscovered: 1,
    }));
    await expect(
      assertRequiredCapabilities(["skill:missing"], contextWith(discover)),
    ).rejects.toThrow(/not installed.*SkillInstall/su);
  });

  it("fails closed for MCP and plugin requirements", async () => {
    await expect(
      assertRequiredCapabilities(["mcp:github"], contextWith(vi.fn())),
    ).rejects.toThrow(/installed through the environment/u);
    await expect(
      assertRequiredCapabilities(["plugin:documents"], contextWith(vi.fn())),
    ).rejects.toThrow(/installed through the environment/u);
  });

  it("rejects unknown capability syntax", async () => {
    await expect(
      assertRequiredCapabilities(["browser:chrome"], contextWith(vi.fn())),
    ).rejects.toThrow(/Unsupported capability requirement/u);
  });

  it("fails closed when skill discovery is unavailable or throws", async () => {
    await expect(
      assertRequiredCapabilities(["skill:review"], contextWith(null)),
    ).rejects.toThrow(/Skill discovery is unavailable/u);

    const failing = vi.fn(async () => {
      throw new Error("registry offline");
    });
    await expect(
      assertRequiredCapabilities(["skill:review"], contextWith(failing)),
    ).rejects.toThrow(/Skill discovery failed: registry offline/u);
  });

  it("accepts installed MCP/plugin and rejects missing ones with InstallCapability hint", async () => {
    const isInstalled = vi.fn(async (_kind: string, id: string) => id === "ready");
    const capabilityInstallPort = {
      isInstalled,
      install: vi.fn(),
    } as unknown as CapabilityContext["capabilityInstallPort"];

    await expect(
      assertRequiredCapabilities(["mcp:ready", "plugin:ready"], contextWith(null, capabilityInstallPort)),
    ).resolves.toBeUndefined();

    await expect(
      assertRequiredCapabilities(["mcp:missing"], contextWith(null, capabilityInstallPort)),
    ).rejects.toThrow(/InstallCapability.*retry the same Task/u);
    expect(isInstalled).toHaveBeenCalledWith("mcp", "missing");
  });

  it("fails closed when MCP/plugin capability cannot be verified without an installer port", async () => {
    await expect(
      assertRequiredCapabilities(["mcp:github"], contextWith(null)),
    ).rejects.toThrow(/no installer port/u);
  });
});
