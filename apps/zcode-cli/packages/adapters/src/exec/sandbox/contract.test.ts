import { describe, expect, it } from "vitest";

import { cliExecSandboxModule } from "./module.js";
import type { SandboxCapability } from "./contract.js";
import { ExecutionSandbox, buildSandboxEnv, isPathInside } from "./execution-sandbox.js";
import { buildBwrapCommand, buildLimitCommand } from "./linux-bwrap.js";
import { buildSeatbeltCommand, buildSeatbeltProfile } from "./macos-seatbelt.js";

const unavailableBwrap: SandboxCapability = {
  mode: "degraded",
  available: false,
  reason: "bubblewrap (bwrap) is not installed",
  supportedFlags: [],
  probedAt: 0,
  probeDurationMs: 0,
};

const availableBwrap: SandboxCapability = {
  mode: "bwrap",
  available: true,
  version: "bubblewrap 0.9.0",
  supportedFlags: ["--ro-bind", "--bind", "--dev", "--proc", "--tmpfs", "--unshare-net"],
  probedAt: 0,
  probeDurationMs: 1,
};

const availableSeatbelt: SandboxCapability = {
  mode: "seatbelt",
  available: true,
  supportedFlags: ["-p", "-f", "-D"],
  probedAt: 0,
  probeDurationMs: 1,
};

function sandboxWith(
  capability: SandboxCapability,
  options: { platform?: NodeJS.Platform; exists?: (path: string) => boolean } = {},
): ExecutionSandbox {
  return new ExecutionSandbox({
    platform: options.platform ?? "linux",
    processEnv: { PATH: "/usr/bin", HOME: "/home/dev", SECRET_TOKEN: "nope" },
    probe: async () => capability,
    exists: options.exists ?? (() => true),
  });
}

const WRAP_POLICY = {
  profile: "workspace-write" as const,
  cwd: "/work/project/src",
  workspacePath: "/work/project",
  networkAccess: "deny" as const,
  env: { CI: "1" },
};

describe("cli-exec-sandbox contract", () => {
  it("declares its module manifest", () => {
    expect(cliExecSandboxModule.id).toBe("cli-exec-sandbox");
    expect(cliExecSandboxModule.publicEntrypoints).toContain("contract.ts");
  });

  it("uses bwrap and marks real filesystem and network isolation", async () => {
    const wrapped = await sandboxWith(availableBwrap).wrap(
      { file: "/bin/sh", args: ["-c", "true"] },
      WRAP_POLICY,
    );

    expect(wrapped.sandboxMode).toBe("bwrap");
    expect(wrapped.filesystemIsolated).toBe(true);
    expect(wrapped.networkIsolated).toBe(true);
    expect(wrapped.args).toContain("--unshare-net");
    expect(wrapped.args).toContain("--die-with-parent");
    expect(wrapped.args.slice(-3)).toEqual(["--", "/bin/sh", "-c"]);
    expect(wrapped.cwd).toBe("/work/project/src");
  });

  it("falls back to degraded with an explicit reason when bwrap is missing", async () => {
    const wrapped = await sandboxWith(unavailableBwrap).wrap(
      { file: "/bin/sh", args: ["-c", "rm -rf /tmp/x"] },
      WRAP_POLICY,
    );

    expect(wrapped.sandboxMode).toBe("degraded");
    expect(wrapped.sandboxReason).toBe("bubblewrap (bwrap) is not installed");
    expect(wrapped.filesystemIsolated).toBe(false);
    expect(wrapped.networkIsolated).toBe(false);
    // Реальная защита: команда идёт тем же argv, cwd ограничен workspace.
    expect(wrapped.file).toBe("/bin/sh");
    expect(wrapped.cwd).toBe("/work/project/src");
  });

  it("collapses cwd outside the workspace instead of leaving the boundary", async () => {
    const wrapped = await sandboxWith(unavailableBwrap).wrap(
      { file: "/bin/sh", args: ["-c", "true"] },
      { ...WRAP_POLICY, cwd: "/etc" },
    );

    expect(wrapped.cwd).toBe("/work/project");
  });

  it("passes only whitelisted environment variables into the sandbox", async () => {
    const wrapped = await sandboxWith(availableBwrap).wrap(
      { file: "/bin/sh", args: ["-c", "true"] },
      WRAP_POLICY,
    );

    expect(wrapped.env).toEqual({ PATH: "/usr/bin", HOME: "/home/dev", CI: "1" });
    expect(wrapped.env).not.toHaveProperty("SECRET_TOKEN");
  });

  it("drops inheritance entirely when envIsolated is requested", () => {
    const env = buildSandboxEnv(
      { PATH: "/usr/bin", HOME: "/home/dev" },
      { ...WRAP_POLICY, envIsolated: true },
    );
    expect(env).toEqual({ CI: "1" });
  });

  it("reports sandboxMode none on win32 without changing the command", async () => {
    const wrapped = await sandboxWith(availableBwrap, { platform: "win32" }).wrap(
      { file: "cmd.exe", args: ["/c", "dir"] },
      { ...WRAP_POLICY, cwd: "C:\\work", workspacePath: "C:\\work" },
    );

    expect(wrapped.sandboxMode).toBe("none");
    expect(wrapped.file).toBe("cmd.exe");
    expect(wrapped.args).toEqual(["/c", "dir"]);
  });

  it("caches the probe result instead of re-running the self-test", async () => {
    let probes = 0;
    const sandbox = new ExecutionSandbox({
      platform: "linux",
      probe: async () => {
        probes += 1;
        return availableBwrap;
      },
    });

    await sandbox.probe();
    await sandbox.probe();
    expect(probes).toBe(1);

    await sandbox.probe({ force: true });
    expect(probes).toBe(2);
  });
});

describe("cli-exec-sandbox wrappers", () => {
  it("keeps the workspace writable and protects git hooks with a later ro-bind", () => {
    const built = buildBwrapCommand({
      command: { file: "/bin/sh", args: ["-c", "true"] },
      policy: WRAP_POLICY,
      capability: availableBwrap,
      exists: () => true,
    });

    const args = built.command!.args;
    const bindIndex = args.indexOf("/work/project");
    const hooksIndex = args.indexOf("/work/project/.git/hooks");
    expect(args[bindIndex - 1]).toBe("--bind");
    expect(args[hooksIndex - 1]).toBe("--ro-bind");
    expect(hooksIndex).toBeGreaterThan(bindIndex);
  });

  it("translates limits into a POSIX ulimit command", () => {
    expect(
      buildLimitCommand({ cpuSeconds: 5, memoryBytes: 256 * 1024 * 1024, maxFileSizeBytes: 1024 }),
    ).toBe("ulimit -t 5; ulimit -v 262144; ulimit -f 2");
    expect(buildLimitCommand({})).toBeUndefined();
  });

  it("denies writes outside declared roots in the Seatbelt profile", () => {
    const profile = buildSeatbeltProfile({ policy: { ...WRAP_POLICY, workspacePath: "/work/project" } });

    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/work/project")');
    expect(profile).toContain("(deny network-outbound)");
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:*"))');
  });

  it("uses sandbox-exec with the profile when Seatbelt is available", () => {
    const built = buildSeatbeltCommand({
      command: { file: "/bin/sh", args: ["-c", "true"] },
      policy: WRAP_POLICY,
      capability: availableSeatbelt,
      exists: () => true,
    });

    expect(built.command!.file).toBe("/usr/bin/sandbox-exec");
    expect(built.command!.args[0]).toBe("-p");
    expect(built.command!.args.at(-3)).toBe("/bin/sh");
    expect(built.command!.networkIsolated).toBe(true);
  });

  it("refuses to build a command when the mechanism is unavailable", () => {
    const built = buildBwrapCommand({
      command: { file: "/bin/sh", args: [] },
      policy: WRAP_POLICY,
      capability: unavailableBwrap,
    });
    expect(built.command).toBeUndefined();
    expect(built.reason).toBe("bubblewrap (bwrap) is not installed");
  });

  it("detects paths inside the workspace boundary", () => {
    expect(isPathInside("/work/project/src", "/work/project")).toBe(true);
    expect(isPathInside("/work/project", "/work/project")).toBe(true);
    expect(isPathInside("/work/project-other", "/work/project")).toBe(false);
    expect(isPathInside("/etc", "/work/project")).toBe(false);
  });
});
