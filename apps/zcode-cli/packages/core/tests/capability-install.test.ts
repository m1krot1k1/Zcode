import { describe, expect, it, vi } from "vitest";
import type { CapabilityInstallPort } from "@zcode/contracts";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { capabilityInstallToolEntry } from "../src/tool/handlers/capability-install.js";

type InstallerContext = Pick<
  ToolExecutionContext,
  "capabilityInstallPort" | "abortSignal" | "toolCallId"
>;

function contextWith(port: CapabilityInstallPort | undefined): InstallerContext {
  return {
    abortSignal: new AbortController().signal,
    toolCallId: "call-install-1",
    ...(port ? { capabilityInstallPort: port } : {}),
  } as InstallerContext;
}

describe("InstallCapability tool", () => {
  it("requires explicit user approval in every permission mode", () => {
    expect(capabilityInstallToolEntry.permission).toMatchObject({
      alwaysAsk: true,
      needsApproval: true,
      riskLevel: "high",
      sideEffectScope: "user",
    });
    expect(capabilityInstallToolEntry.metadata.name).toBe("InstallCapability");
  });

  it("delegates the approved request to the host installer port", async () => {
    const install = vi.fn(async (request) => ({
      kind: request.kind,
      id: request.id,
      status: "installed" as const,
      requiresReload: true,
      evidence: "connected",
    }));
    const port = { install, isInstalled: vi.fn() } as unknown as CapabilityInstallPort;

    const result = await capabilityInstallToolEntry.handler(
      { kind: "mcp", id: "github", config: { type: "http", url: "https://example.test" } },
      contextWith(port) as unknown as ToolExecutionContext,
    );

    expect(result).toMatchObject({
      kind: "mcp",
      id: "github",
      status: "installed",
      requiresReload: true,
      evidence: "connected",
    });
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "mcp", id: "github" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("fails closed when the runtime has no installer port", async () => {
    await expect(
      capabilityInstallToolEntry.handler(
        { kind: "plugin", id: "documents@zcode-plugins-official" },
        contextWith(undefined) as unknown as ToolExecutionContext,
      ),
    ).rejects.toThrow(/Capability installer is unavailable/u);
  });
});
