import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeAcpRuntime } from "../src/opencode-acp-runtime/adapters/openCodeAcpRuntime.js";
import {
  OPEN_CODE_WINGET_INSTALL_ARGS,
  resolveOpenCodeCli,
  resolveOpenCodeWingetExecutable,
} from "../src/opencode-acp-runtime/adapters/cliResolver.js";

const temporaryPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "zcode-opencode-acp-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Windows OpenCode command resolution", () => {
  it("chooses a native executable using PATH and PATHEXT order", async () => {
    const files = new Set([
      win32.join("C:\\tools", "opencode.exe"),
      win32.join("C:\\tools", "opencode.cmd"),
    ]);
    const result = await resolveOpenCodeCli({
      platform: "win32",
      pathValue: '"C:\\tools";C:\\other',
      pathExtValue: ".EXE;.CMD;.BAT",
      homeDirectory: "C:\\Users\\test",
      isExecutableFile: async (candidate) => files.has(candidate),
    });

    expect(result).toEqual({
      status: "resolved",
      executablePath: win32.join("C:\\tools", "opencode.exe"),
      spec: {
        command: win32.join("C:\\tools", "opencode.exe"),
        prefixArgs: [],
      },
    });
  });

  it("refuses command shims instead of spawning them through a shell", async () => {
    const shim = win32.join("C:\\npm", "opencode.cmd");
    const result = await resolveOpenCodeCli({
      platform: "win32",
      pathValue: "C:\\npm",
      pathExtValue: ".CMD;.BAT;.EXE",
      homeDirectory: "C:\\Users\\test",
      isExecutableFile: async (candidate) => candidate === shim,
    });

    expect(result).toEqual({
      status: "unsupported",
      diagnostic: "opencode.windows-cli-shim-unsupported",
      installSupported: false,
    });
  });

  it("reports a missing binary without treating an empty PATH as an installable CLI", async () => {
    await expect(
      resolveOpenCodeCli({
        platform: "win32",
        pathValue: undefined,
        homeDirectory: "C:\\Users\\test",
        isExecutableFile: async () => false,
      }),
    ).resolves.toMatchObject({
      status: "missing",
      installSupported: false,
    });
  });

  it("accepts an explicit absolute native executable and rejects explicit command shims", async () => {
    const native = "C:\\Users\\test\\AppData\\Local\\ZCode\\OpenCode\\opencode.exe";
    await expect(
      resolveOpenCodeCli({
        platform: "win32",
        pathValue: "",
        homeDirectory: "C:\\Users\\test",
        explicitPath: native,
        isExecutableFile: async (candidate) => candidate === native,
      }),
    ).resolves.toMatchObject({ status: "resolved", executablePath: native });
    await expect(
      resolveOpenCodeCli({
        platform: "win32",
        pathValue: "",
        homeDirectory: "C:\\Users\\test",
        explicitPath: "C:\\npm\\opencode.cmd",
        isExecutableFile: async () => true,
      }),
    ).resolves.toMatchObject({
      status: "unsupported",
      diagnostic: "opencode.windows-cli-shim-unsupported",
    });
  });

  it("finds OpenCode in the WinGet portable Links directory when Host PATH is narrow", async () => {
    const localAppData = "C:\\Users\\test\\AppData\\Local";
    const executable = win32.join(localAppData, "Microsoft", "WinGet", "Links", "opencode.exe");
    await expect(
      resolveOpenCodeCli({
        platform: "win32",
        pathValue: "C:\\Windows\\System32",
        homeDirectory: "C:\\Users\\test",
        env: { LOCALAPPDATA: localAppData },
        isExecutableFile: async (candidate) => candidate === executable,
      }),
    ).resolves.toMatchObject({
      status: "resolved",
      executablePath: executable,
    });
  });

  it("resolves only the native winget.exe command, never a command shim", async () => {
    const native = win32.join("C:\\WindowsApps", "winget.exe");
    const inspected: string[] = [];
    await expect(
      resolveOpenCodeWingetExecutable({
        pathValue: "C:\\WindowsApps",
        pathExtValue: ".CMD;.EXE",
        isExecutableFile: async (candidate) => {
          inspected.push(candidate);
          return candidate === native;
        },
      }),
    ).resolves.toBe(native);
    expect(inspected).toEqual([native]);

    await expect(
      resolveOpenCodeWingetExecutable({
        pathValue: "C:\\WindowsApps",
        pathExtValue: ".CMD;.BAT",
        isExecutableFile: async () => true,
      }),
    ).resolves.toBeUndefined();

    const appExecutionAlias = win32.join(
      "C:\\Users\\test\\AppData\\Local",
      "Microsoft",
      "WindowsApps",
      "winget.exe",
    );
    await expect(
      resolveOpenCodeWingetExecutable({
        pathValue: undefined,
        localAppData: "C:\\Users\\test\\AppData\\Local",
        isExecutableFile: async (candidate) => candidate === appExecutionAlias,
      }),
    ).resolves.toBe(appExecutionAlias);
  });
});

describe("POSIX OpenCode command resolution", () => {
  it("finds the official per-user install when a GUI Host has a narrow PATH", async () => {
    const officialInstall = join("/Users/test", ".opencode", "bin", "opencode");
    await expect(
      resolveOpenCodeCli({
        platform: "darwin",
        pathValue: "/usr/bin:/bin",
        homeDirectory: "/Users/test",
        isExecutableFile: async (candidate) => candidate === officialInstall,
      }),
    ).resolves.toMatchObject({ status: "resolved", executablePath: officialInstall });
  });

  it("searches inherited PATH before deterministic Homebrew and global install locations", async () => {
    const homebrew = "/opt/homebrew/bin/opencode";
    const candidates = new Set([homebrew]);
    await expect(
      resolveOpenCodeCli({
        platform: "darwin",
        pathValue: "/usr/bin",
        homeDirectory: "/Users/test",
        isExecutableFile: async (candidate) => candidates.has(candidate),
      }),
    ).resolves.toMatchObject({ status: "resolved", executablePath: homebrew });

    await expect(
      resolveOpenCodeCli({
        platform: "linux",
        pathValue: "/usr/bin",
        homeDirectory: "/Users/test",
        env: { MISE_DATA_DIR: "/custom/mise/data" },
        isExecutableFile: async (candidate) => candidate === "/custom/mise/data/shims/opencode",
      }),
    ).resolves.toMatchObject({
      status: "resolved",
      executablePath: "/custom/mise/data/shims/opencode",
    });
  });

  it("uses an explicit absolute path only when it is an executable file", async () => {
    const explicitPath = "/Applications/OpenCode/bin/opencode";
    await expect(
      resolveOpenCodeCli({
        platform: "darwin",
        pathValue: "/usr/bin",
        homeDirectory: "/Users/test",
        explicitPath,
        isExecutableFile: async (candidate) => candidate === explicitPath,
      }),
    ).resolves.toMatchObject({
      status: "resolved",
      executablePath: explicitPath,
    });
    await expect(
      resolveOpenCodeCli({
        platform: "darwin",
        pathValue: "/Applications/OpenCode/bin",
        homeDirectory: "/Users/test",
        explicitPath: "relative/opencode",
        isExecutableFile: async () => true,
      }),
    ).resolves.toMatchObject({ status: "invalid-explicit-path" });
  });
});

describe("OpenCode ACP runtime", () => {
  it("classifies bounded startup failures without exposing child stderr", async () => {
    const directory = await makeTempDir();
    const secretMarker = "test-only-opencode-stderr-secret";
    const scenarios = [
      {
        stderr: `${secretMarker}${"x".repeat(5_000)}\nError: listen EADDRNOTAVAIL 127.0.0.1`,
        diagnostic: "opencode.acp-local-server-unavailable",
      },
      {
        stderr: `${secretMarker}failed before ACP initialize`,
        diagnostic: "opencode.acp-process-exited",
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const fakeAgentPath = join(directory, `fake-acp-startup-failure-${index}.mjs`);
      await writeFile(
        fakeAgentPath,
        `if (process.argv[2] === "--version") process.stdout.write("Fake OpenCode CLI\\n"); else { process.stderr.write(${JSON.stringify(scenario.stderr)}); process.exit(19); }\n`,
        "utf8",
      );
      const runtime = createOpenCodeAcpRuntime({
        resolveCli: () => ({
          status: "resolved",
          executablePath: process.execPath,
          spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
        }),
        runVersion: async () => ({
          status: "available",
          version: "Fake OpenCode CLI",
          executablePath: process.execPath,
        }),
        requestTimeoutMs: 2_000,
      });

      try {
        const error = await runtime.startSession({ cwd: directory }).then(
          () => new Error("Expected ACP startup to fail"),
          (reason: unknown) => reason,
        );
        expect(error).toMatchObject({ message: scenario.diagnostic });
        expect(String(error)).not.toContain(secretMarker);
      } finally {
        await runtime.disposeAllAndWait();
      }
    }
  });

  it.each(["opencode.injected-secret-value", "opencode.cli-missing"])(
    "does not accept an ACP peer error (%s) as a local diagnostic code",
    async (peerError) => {
      const directory = await makeTempDir();
      const fakeAgentPath = join(directory, "fake-acp-forged-diagnostic.mjs");
      const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk");
      await writeFile(
        fakeAgentPath,
        fakeAcpAgentSource(sdkUrl, { initializeError: peerError }),
        "utf8",
      );
      const runtime = createOpenCodeAcpRuntime({
        resolveCli: () => ({
          status: "resolved",
          executablePath: process.execPath,
          spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
        }),
        requestTimeoutMs: 2_000,
      });

      try {
        const error = await runtime.startSession({ cwd: directory }).then(
          () => new Error("Expected ACP initialize to fail"),
          (reason: unknown) => reason,
        );
        expect(error).toMatchObject({ message: "opencode.acp-initialize-failed" });
        expect(String(error)).not.toContain(peerError);
      } finally {
        await runtime.disposeAllAndWait();
      }
    },
  );

  it("preserves the local connection-closed diagnostic while a failed ACP process remains alive", async () => {
    const directory = await makeTempDir();
    const fakeAgentPath = join(directory, "fake-acp-closed-transport.mjs");
    const pidCapturePath = join(directory, "acp-child-pid.txt");
    const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk");
    await writeFile(
      fakeAgentPath,
      fakeAcpAgentSource(sdkUrl, { closeTransportDuringInitialize: true, pidCapturePath }),
      "utf8",
    );
    const runtime = createOpenCodeAcpRuntime({
      resolveCli: () => ({
        status: "resolved",
        executablePath: process.execPath,
        spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
      }),
      requestTimeoutMs: 2_000,
    });

    try {
      const error = await runtime.startSession({ cwd: directory }).then(
        () => new Error("Expected ACP transport to close during initialize"),
        (reason: unknown) => reason,
      );
      expect(error).toMatchObject({ message: "opencode.acp-connection-closed" });
      expect(Number(await readFile(pidCapturePath, "utf8"))).toBeGreaterThan(0);
    } finally {
      await runtime.disposeAllAndWait();
    }
  });

  it.skipIf(process.platform === "win32")(
    "starts bounded cleanup without waiting for a descendant-held stdio pipe",
    async () => {
      const directory = await makeTempDir();
      const fakeAgentPath = join(directory, "fake-acp-descendant-held-stdio.mjs");
      await writeFile(
        fakeAgentPath,
        `import { spawn } from "node:child_process";\nif (process.argv[2] === "--version") process.stdout.write("Fake OpenCode CLI\\n"); else { const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "inherit" }); descendant.unref(); process.stderr.write("fake startup failure\\n"); process.exit(19); }\n`,
        "utf8",
      );
      let spawnedChild: import("node:child_process").ChildProcess | undefined;
      let childClosed = false;
      const terminateProcessTreeAndWait = vi.fn(
        async (child: import("node:child_process").ChildProcess) => {
          spawnedChild = child;
          child.once("close", () => {
            childClosed = true;
          });
          return { remainingPids: [] };
        },
      );
      const runtime = createOpenCodeAcpRuntime({
        resolveCli: () => ({
          status: "resolved",
          executablePath: process.execPath,
          spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
        }),
        runVersion: async () => ({
          status: "available",
          version: "Fake OpenCode CLI",
          executablePath: process.execPath,
        }),
        requestTimeoutMs: 2_000,
        terminateProcessTreeAndWait,
      });

      try {
        await expect(runtime.startSession({ cwd: directory })).rejects.toMatchObject({
          message: "opencode.acp-process-exited",
        });
        expect(terminateProcessTreeAndWait).toHaveBeenCalledTimes(1);
        expect(spawnedChild?.pid).toBeDefined();
        expect(childClosed).toBe(false);
      } finally {
        if (spawnedChild?.pid) {
          try {
            process.kill(-spawnedChild.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          if (!childClosed) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2_000);
              spawnedChild?.once("close", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
        }
        await runtime.disposeAllAndWait();
      }
    },
  );

  it("uses live ACP selectors, streams updates, cancels prompts, and disposes its child", async () => {
    const directory = await makeTempDir();
    const fakeAgentPath = join(directory, "fake-acp-agent.mjs");
    const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk");
    await writeFile(fakeAgentPath, fakeAcpAgentSource(sdkUrl), "utf8");

    const runtime = createOpenCodeAcpRuntime({
      resolveCli: () => ({
        status: "resolved",
        executablePath: process.execPath,
        spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
      }),
      requestTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });

    try {
      await expect(runtime.getCliStatus()).resolves.toMatchObject({
        status: "available",
        version: "Fake OpenCode CLI",
      });
      const session = await runtime.startSession({ cwd: directory });
      expect(session.configOptions.map((option) => option.id)).toEqual(["model", "mode"]);

      const modelUpdate = await runtime.setConfigOption({
        sessionId: session.sessionId,
        configId: "model",
        value: "zen/free-model",
      });
      expect(modelUpdate.configOptions[0]).toMatchObject({
        id: "model",
        currentValue: "zen/free-model",
      });
      const modeUpdate = await runtime.setConfigOption({
        sessionId: session.sessionId,
        configId: "mode",
        value: "plan",
      });
      expect(modeUpdate.configOptions[1]).toMatchObject({
        id: "mode",
        currentValue: "plan",
      });

      const updates: unknown[] = [];
      const subscription = runtime.onSessionUpdate({
        sessionId: session.sessionId,
      })((update) => updates.push(update));
      const prompt = runtime.prompt({
        sessionId: session.sessionId,
        text: "hold until cancelled",
      });
      await vi.waitFor(() => expect(updates).toHaveLength(1));
      expect(updates[0]).toMatchObject({
        sessionUpdate: "agent_message_chunk",
      });
      await runtime.cancel({ sessionId: session.sessionId });
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      subscription.dispose();

      await runtime.closeSession({ sessionId: session.sessionId });
      await runtime.disposeAllAndWait();
      await expect(runtime.startSession({ cwd: directory })).rejects.toThrow(
        "opencode.runtime-disposed",
      );
    } finally {
      await runtime.disposeAllAndWait();
    }
  });

  it.skipIf(process.platform === "win32")(
    "passes only allowlisted environment variables to ACP and npm child processes",
    async () => {
      const directory = await makeTempDir();
      const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk");
      const acpEnvironmentPath = join(directory, "acp-environment.json");
      const fakeAgentPath = join(directory, "fake-acp-agent.mjs");
      await writeFile(
        fakeAgentPath,
        fakeAcpAgentSource(sdkUrl, { envCapturePath: acpEnvironmentPath }),
        "utf8",
      );
      const fakeNpmPath = join(directory, "npm");
      const npmEnvironmentPath = join(directory, "npm-environment.json");
      await writeFile(
        fakeNpmPath,
        `#!/usr/bin/env node\nimport { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(npmEnvironmentPath)}, JSON.stringify(Object.keys(process.env)));\n`,
        "utf8",
      );
      await chmod(fakeNpmPath, 0o755);

      const processEnv: NodeJS.ProcessEnv = {
        PATH: `${directory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        HOME: directory,
        USER: "test-user",
        TMPDIR: directory,
        NPM_CONFIG_PREFIX: join(directory, "npm-prefix"),
        OPENAI_API_KEY: "test-only-secret-marker",
        GITHUB_TOKEN: "test-only-secret-marker",
        GH_TOKEN: "test-only-secret-marker",
        AWS_SECRET_ACCESS_KEY: "test-only-secret-marker",
        NPM_CONFIG_USERCONFIG: join(directory, "secret-npmrc"),
        ZCODE_SECRET_TEST_MARKER: "test-only-secret-marker",
      };
      const fakeResolution = {
        status: "resolved" as const,
        executablePath: process.execPath,
        spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
      };
      const runtime = createOpenCodeAcpRuntime({
        resolveCli: async () => fakeResolution,
        runVersion: async () => ({
          status: "available",
          version: "Fake OpenCode CLI",
          executablePath: process.execPath,
        }),
        processEnv,
      });

      try {
        const session = await runtime.startSession({ cwd: directory });
        const acpEnvironment = JSON.parse(await readFile(acpEnvironmentPath, "utf8")) as string[];
        expect(acpEnvironment).toContain("PATH");
        expect(acpEnvironment).toContain("HOME");
        expect(acpEnvironment).toContain("NPM_CONFIG_PREFIX");
        expect(acpEnvironment).not.toContain("OPENAI_API_KEY");
        expect(acpEnvironment).not.toContain("GITHUB_TOKEN");
        expect(acpEnvironment).not.toContain("GH_TOKEN");
        expect(acpEnvironment).not.toContain("AWS_SECRET_ACCESS_KEY");
        expect(acpEnvironment).not.toContain("NPM_CONFIG_USERCONFIG");
        expect(acpEnvironment).not.toContain("ZCODE_SECRET_TEST_MARKER");
        await runtime.closeSession({ sessionId: session.sessionId });
      } finally {
        await runtime.disposeAllAndWait();
      }

      const resolveInstalledCli = vi
        .fn()
        .mockResolvedValueOnce(fakeResolution)
        .mockResolvedValueOnce({
          status: "missing",
          diagnostic: "opencode.cli-missing",
          installSupported: true,
        })
        .mockResolvedValueOnce(fakeResolution);
      const runVersion = vi
        .fn()
        .mockResolvedValueOnce({
          status: "missing",
          diagnostic: "opencode.cli-missing",
        })
        .mockResolvedValueOnce({
          status: "available",
          version: "Fake OpenCode CLI",
          executablePath: process.execPath,
        });
      const installer = createOpenCodeAcpRuntime({
        resolveCli: resolveInstalledCli,
        runVersion,
        processEnv,
      });
      try {
        await expect(installer.installCli()).resolves.toMatchObject({
          status: "installed",
        });
        const npmEnvironment = JSON.parse(await readFile(npmEnvironmentPath, "utf8")) as string[];
        expect(npmEnvironment).toContain("PATH");
        expect(npmEnvironment).toContain("HOME");
        expect(npmEnvironment).toContain("NPM_CONFIG_PREFIX");
        expect(npmEnvironment).not.toContain("OPENAI_API_KEY");
        expect(npmEnvironment).not.toContain("GITHUB_TOKEN");
        expect(npmEnvironment).not.toContain("GH_TOKEN");
        expect(npmEnvironment).not.toContain("AWS_SECRET_ACCESS_KEY");
        expect(npmEnvironment).not.toContain("NPM_CONFIG_USERCONFIG");
        expect(npmEnvironment).not.toContain("ZCODE_SECRET_TEST_MARKER");
      } finally {
        await installer.disposeAllAndWait();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "bounds hanging cancel and close requests during disposal and terminates the child",
    async () => {
      const directory = await makeTempDir();
      const fakeAgentPath = join(directory, "fake-acp-agent.mjs");
      const childPidPath = join(directory, "child-pid");
      const tracePath = join(directory, "acp-trace.txt");
      const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk");
      await writeFile(
        fakeAgentPath,
        fakeAcpAgentSource(sdkUrl, {
          hangCancel: true,
          hangClose: true,
          pidCapturePath: childPidPath,
          tracePath,
        }),
        "utf8",
      );
      const terminateProcessTreeAndWait = vi.fn(
        async (child: import("node:child_process").ChildProcess) => {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill("SIGKILL");
          await closed;
          return { remainingPids: [] };
        },
      );
      const runtime = createOpenCodeAcpRuntime({
        resolveCli: () => ({
          status: "resolved",
          executablePath: process.execPath,
          spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
        }),
        cleanupRequestTimeoutMs: 75,
        promptTimeoutMs: 10_000,
        terminateProcessTreeAndWait,
      });

      try {
        const session = await runtime.startSession({ cwd: directory });
        const prompt = runtime.prompt({
          sessionId: session.sessionId,
          text: "hold until cancelled",
        });
        void prompt.catch(() => undefined);
        await vi.waitFor(async () => {
          expect(await readFile(tracePath, "utf8").catch(() => "")).toContain("prompt:start");
        });
        const childPid = Number(await readFile(childPidPath, "utf8"));
        expect(childPid).toBeGreaterThan(0);
        const stopStartedAt = Date.now();
        await expect(runtime.disposeAllAndWait()).resolves.toBeUndefined();
        expect(Date.now() - stopStartedAt).toBeLessThan(1_000);
        expect(terminateProcessTreeAndWait).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => {
          let childAlive = true;
          try {
            process.kill(childPid, 0);
          } catch (error) {
            childAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
          }
          expect(childAlive, `OpenCode ACP child ${childPid} should be gone after dispose`).toBe(
            false,
          );
        });
      } finally {
        await runtime.disposeAllAndWait();
      }
    },
  );

  it("shares one initialize handshake and sends no session/new before it succeeds", async () => {
    const directory = await makeTempDir();
    const fakeAgentPath = join(directory, "fake-acp-agent.mjs");
    const initializeGatePath = join(directory, "release-initialize");
    const tracePath = join(directory, "acp-trace.txt");
    const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk");
    await writeFile(
      fakeAgentPath,
      fakeAcpAgentSource(sdkUrl, { initializeGatePath, tracePath }),
      "utf8",
    );
    const runtime = createOpenCodeAcpRuntime({
      resolveCli: () => ({
        status: "resolved",
        executablePath: process.execPath,
        spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
      }),
      requestTimeoutMs: 5_000,
    });

    try {
      const starts = [
        runtime.startSession({ cwd: directory }),
        runtime.startSession({ cwd: directory }),
      ];
      await vi.waitFor(async () => {
        expect(await readFile(tracePath, "utf8").catch(() => "")).toContain("initialize:start");
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await readFile(tracePath, "utf8")).toBe("initialize:start\n");
      await writeFile(initializeGatePath, "ready", "utf8");
      const sessions = await Promise.all(starts);
      expect(sessions).toHaveLength(2);
      const trace = (await readFile(tracePath, "utf8")).trim().split("\n");
      expect(trace.filter((entry) => entry === "initialize:start")).toHaveLength(1);
      expect(trace.indexOf("initialize:end")).toBeLessThan(trace.indexOf("session:new:1"));
      expect(trace.indexOf("initialize:end")).toBeLessThan(trace.indexOf("session:new:2"));
    } finally {
      await runtime.disposeAllAndWait();
    }
  });

  it("discards a failed initialize shared by concurrent starts before retrying", async () => {
    const directory = await makeTempDir();
    const fakeAgentPath = join(directory, "fake-acp-agent.mjs");
    const initializeAttemptPath = join(directory, "initialize-attempts.txt");
    const tracePath = join(directory, "acp-trace.txt");
    const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk");
    await writeFile(
      fakeAgentPath,
      fakeAcpAgentSource(sdkUrl, {
        initializeAttemptPath,
        failFirstInitialize: true,
        tracePath,
      }),
      "utf8",
    );
    const runtime = createOpenCodeAcpRuntime({
      resolveCli: () => ({
        status: "resolved",
        executablePath: process.execPath,
        spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
      }),
      requestTimeoutMs: 2_000,
    });

    try {
      const failedStarts = await Promise.allSettled([
        runtime.startSession({ cwd: directory }),
        runtime.startSession({ cwd: directory }),
      ]);
      expect(failedStarts).toHaveLength(2);
      expect(failedStarts.every((result) => result.status === "rejected")).toBe(true);
      for (const result of failedStarts) {
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({
            message: "opencode.acp-initialize-failed",
          });
        }
      }
      expect(await readFile(initializeAttemptPath, "utf8")).toBe("1");
      expect(await readFile(tracePath, "utf8")).not.toContain("session:new:");

      const session = await runtime.startSession({ cwd: directory });
      expect(session.sessionId).toBe("fake-session-1");
      expect(await readFile(initializeAttemptPath, "utf8")).toBe("2");
      const trace = (await readFile(tracePath, "utf8")).trim().split("\n");
      expect(trace.filter((entry) => entry === "initialize:start")).toHaveLength(2);
      expect(trace.indexOf("session:new:1")).toBeGreaterThan(trace.lastIndexOf("initialize:end"));
      await runtime.closeSession({ sessionId: session.sessionId });
    } finally {
      await runtime.disposeAllAndWait();
    }
  });

  it("never calls the installer for a CLI that is already present", async () => {
    const installPackage = vi.fn(async () => true);
    const runtime = createOpenCodeAcpRuntime({
      resolveCli: () => ({
        status: "resolved",
        executablePath: "opencode",
        spec: { command: "opencode", prefixArgs: [] },
      }),
      runVersion: async () => ({
        status: "available",
        version: "OpenCode 1.19.3",
        executablePath: "opencode",
      }),
      installPackage,
    });

    await expect(runtime.installCli()).resolves.toEqual({
      status: "already-installed",
      version: "OpenCode 1.19.3",
      executablePath: "opencode",
    });
    expect(installPackage).not.toHaveBeenCalled();
    await runtime.disposeAllAndWait();
  });

  it("rechecks for a CLI that appears before the installer runs", async () => {
    const executablePath = "/usr/local/bin/opencode";
    const missing = {
      status: "missing" as const,
      diagnostic: "opencode.cli-missing",
      installSupported: true,
    };
    const resolved = {
      status: "resolved" as const,
      executablePath,
      spec: { command: executablePath, prefixArgs: [] },
    };

    for (const platform of ["darwin", "linux"] as const) {
      const resolveCli = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(resolved);
      const installPackage = vi.fn(async () => true);
      const runtime = createOpenCodeAcpRuntime({
        platform,
        resolveCli,
        runVersion: async () => ({
          status: "available",
          version: "OpenCode 1.19.3",
          executablePath,
        }),
        installPackage,
      });

      await expect(runtime.installCli()).resolves.toEqual({
        status: "already-installed",
        version: "OpenCode 1.19.3",
        executablePath,
      });
      expect(resolveCli).toHaveBeenCalledTimes(2);
      expect(installPackage).not.toHaveBeenCalled();
      await runtime.disposeAllAndWait();
    }

    const resolveWindowsCli = vi
      .fn()
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(resolved);
    const installWingetPackage = vi.fn(async () => true);
    const windowsRuntime = createOpenCodeAcpRuntime({
      platform: "win32",
      resolveCli: resolveWindowsCli,
      resolveWinget: async () => "C:\\WindowsApps\\winget.exe",
      runVersion: async () => ({
        status: "available",
        version: "OpenCode 1.19.3",
        executablePath,
      }),
      installWingetPackage,
    });
    await expect(windowsRuntime.installCli()).resolves.toEqual({
      status: "already-installed",
      version: "OpenCode 1.19.3",
      executablePath,
    });
    expect(installWingetPackage).not.toHaveBeenCalled();
    await windowsRuntime.disposeAllAndWait();
  });

  it("installs a missing POSIX CLI from the explicit Install action on macOS and Linux", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const executablePath =
        platform === "darwin" ? "/opt/homebrew/bin/opencode" : "/usr/bin/opencode";
      const resolveCli = vi
        .fn()
        .mockResolvedValueOnce({
          status: "missing",
          diagnostic: "opencode.cli-missing",
          installSupported: true,
        })
        .mockResolvedValueOnce({
          status: "missing",
          diagnostic: "opencode.cli-missing",
          installSupported: true,
        })
        .mockResolvedValueOnce({
          status: "resolved",
          executablePath,
          spec: { command: executablePath, prefixArgs: [] },
        });
      const installPackage = vi.fn(async () => true);
      const runVersion = vi.fn(async () => ({
        status: "available" as const,
        version: "OpenCode 1.19.3",
        executablePath,
      }));
      const runtime = createOpenCodeAcpRuntime({
        platform,
        resolveCli,
        installPackage,
        runVersion,
      });

      await expect(runtime.installCli()).resolves.toEqual({
        status: "installed",
        version: "OpenCode 1.19.3",
        executablePath,
      });
      expect(installPackage).toHaveBeenCalledOnce();
      expect(resolveCli).toHaveBeenCalledTimes(3);
      expect(runVersion).toHaveBeenCalledOnce();
      await runtime.disposeAllAndWait();
    }
  });

  it("starts ACP even when the unrelated serve command has no stdio flag", async () => {
    const directory = await makeTempDir();
    const fakeAgentPath = join(directory, "fake-acp-agent.mjs");
    const tracePath = join(directory, "acp-trace.txt");
    const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk");
    await writeFile(
      fakeAgentPath,
      fakeAcpAgentSource(sdkUrl, { tracePath, serveSupportsStdio: false }),
      "utf8",
    );
    const runtime = createOpenCodeAcpRuntime({
      resolveCli: () => ({
        status: "resolved",
        executablePath: process.execPath,
        spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
      }),
      runVersion: async () => ({
        status: "available",
        version: "OpenCode 1.19.3",
        executablePath: process.execPath,
      }),
    });

    try {
      const session = await runtime.startSession({ cwd: directory });
      expect(session.configOptions.map((option) => option.id)).toContain("model");
      expect(await readFile(tracePath, "utf8")).toContain("initialize:end");
      await runtime.closeSession({ sessionId: session.sessionId });
    } finally {
      await runtime.disposeAllAndWait();
    }
  });

  it("uses the fixed WinGet V2 package without upgrading an already detected CLI", async () => {
    expect([...OPEN_CODE_WINGET_INSTALL_ARGS]).toEqual([
      "install",
      "--id",
      "Anomaly.OpenCode",
      "--exact",
      "--source",
      "winget",
      "--accept-source-agreements",
      "--accept-package-agreements",
      "--no-upgrade",
      "--silent",
      "--disable-interactivity",
    ]);

    const executablePath =
      "C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\opencode.exe";
    const installWingetPackage = vi.fn(async () => true);
    const resolveCli = vi
      .fn<
        () => Promise<
          | { status: "missing"; diagnostic: string; installSupported: boolean }
          | {
              status: "resolved";
              executablePath: string;
              spec: { command: string; prefixArgs: string[] };
            }
        >
      >()
      .mockResolvedValueOnce({
        status: "missing",
        diagnostic: "opencode.cli-missing",
        installSupported: true,
      })
      .mockResolvedValueOnce({
        status: "missing",
        diagnostic: "opencode.cli-missing",
        installSupported: true,
      })
      .mockResolvedValueOnce({
        status: "resolved",
        executablePath,
        spec: { command: executablePath, prefixArgs: [] },
      });
    const runVersion = vi.fn(async () => ({
      status: "available" as const,
      version: "OpenCode 2.1.1",
      executablePath,
    }));
    const runtime = createOpenCodeAcpRuntime({
      platform: "win32",
      resolveCli,
      resolveWinget: async () => "C:\\WindowsApps\\winget.exe",
      installWingetPackage,
      runVersion,
    });

    await expect(runtime.installCli()).resolves.toEqual({
      status: "installed",
      version: "OpenCode 2.1.1",
      executablePath,
    });
    expect(installWingetPackage).toHaveBeenCalledWith(
      "C:\\WindowsApps\\winget.exe",
      expect.any(Number),
    );
    expect(resolveCli).toHaveBeenCalledTimes(3);

    const existingCliInstall = createOpenCodeAcpRuntime({
      platform: "win32",
      resolveCli: async () => ({
        status: "resolved",
        executablePath,
        spec: { command: executablePath, prefixArgs: [] },
      }),
      runVersion: async () => ({
        status: "available",
        version: "OpenCode 1.19.3",
        executablePath,
      }),
      resolveWinget: async () => "C:\\WindowsApps\\winget.exe",
      installWingetPackage,
    });
    await expect(existingCliInstall.installCli()).resolves.toEqual({
      status: "already-installed",
      version: "OpenCode 1.19.3",
      executablePath,
    });
    expect(installWingetPackage).toHaveBeenCalledTimes(1);
    await runtime.disposeAllAndWait();
    await existingCliInstall.disposeAllAndWait();
  });

  it("offers Windows install only when a native winget.exe is discoverable", async () => {
    const resolveCli = async () => ({
      status: "missing" as const,
      diagnostic: "opencode.cli-missing",
      installSupported: false,
    });
    const withWinget = createOpenCodeAcpRuntime({
      platform: "win32",
      resolveCli,
      resolveWinget: async () => "C:\\WindowsApps\\winget.exe",
    });
    const withoutWinget = createOpenCodeAcpRuntime({
      platform: "win32",
      resolveCli,
      resolveWinget: async () => undefined,
    });

    await expect(withWinget.getCliStatus()).resolves.toMatchObject({
      status: "missing",
      installSupported: true,
    });
    await expect(withoutWinget.getCliStatus()).resolves.toMatchObject({
      status: "missing",
      installSupported: false,
    });
    await withWinget.disposeAllAndWait();
    await withoutWinget.disposeAllAndWait();
  });

  it("shows permission requests, accepts only advertised options, and answers an explicit selection", async () => {
    const directory = await makeTempDir();
    const fakeAgentPath = join(directory, "fake-acp-agent.mjs");
    const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk");
    await writeFile(fakeAgentPath, fakeAcpAgentSource(sdkUrl), "utf8");
    const runtime = createOpenCodeAcpRuntime({
      resolveCli: () => ({
        status: "resolved",
        executablePath: process.execPath,
        spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
      }),
      requestTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });

    try {
      const session = await runtime.startSession({ cwd: directory });
      const events: unknown[] = [];
      let resolvePermissionRequest!: (request: {
        requestId: string;
        options: Array<{ optionId: string; kind: string; name: string }>;
      }) => void;
      const permissionRequest = new Promise<{
        requestId: string;
        options: Array<{ optionId: string; kind: string; name: string }>;
      }>((resolve) => (resolvePermissionRequest = resolve));
      const subscription = runtime.onPermissionEvent({
        sessionId: session.sessionId,
      })((event) => {
        events.push(event);
        if (event.type === "requested") resolvePermissionRequest(event.request);
      });
      const prompt = runtime.prompt({
        sessionId: session.sessionId,
        text: "request permission",
      });
      const request = await permissionRequest;
      expect(request).toMatchObject({
        sessionId: session.sessionId,
        toolTitle: "Run shell command",
        toolKind: "execute",
        inputSummary: '{"command":"echo approved"}',
      });
      expect(request.options.map((option) => option.kind)).toEqual([
        "allow_once",
        "allow_always",
        "reject_once",
      ]);
      await expect(
        runtime.respondToPermission({
          sessionId: session.sessionId,
          requestId: request.requestId,
          optionId: "not-advertised",
        }),
      ).rejects.toThrow("opencode.permission-option-invalid");
      await runtime.respondToPermission({
        sessionId: session.sessionId,
        requestId: request.requestId,
        optionId: "allow-once",
      });
      await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
      expect(events).toEqual([
        expect.objectContaining({ type: "requested" }),
        expect.objectContaining({
          type: "resolved",
          requestId: request.requestId,
        }),
      ]);
      subscription.dispose();
      await runtime.closeSession({ sessionId: session.sessionId });
    } finally {
      await runtime.disposeAllAndWait();
    }
  });

  it("answers pending ACP permissions as cancelled before cancelling or disposing the session", async () => {
    const directory = await makeTempDir();
    const fakeAgentPath = join(directory, "fake-acp-agent.mjs");
    const sdkUrl = import.meta.resolve("@agentclientprotocol/sdk");
    await writeFile(fakeAgentPath, fakeAcpAgentSource(sdkUrl), "utf8");
    const runtime = createOpenCodeAcpRuntime({
      resolveCli: () => ({
        status: "resolved",
        executablePath: process.execPath,
        spec: { command: process.execPath, prefixArgs: [fakeAgentPath] },
      }),
      requestTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
    });

    try {
      const session = await runtime.startSession({ cwd: directory });
      const events: unknown[] = [];
      const subscription = runtime.onPermissionEvent({
        sessionId: session.sessionId,
      })((event) => events.push(event));
      const prompt = runtime.prompt({
        sessionId: session.sessionId,
        text: "request permission",
      });
      await vi.waitFor(() =>
        expect(events).toEqual([expect.objectContaining({ type: "requested" })]),
      );
      await runtime.cancel({ sessionId: session.sessionId });
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
      expect(events).toEqual([
        expect.objectContaining({ type: "requested" }),
        expect.objectContaining({ type: "resolved" }),
      ]);
      subscription.dispose();
      await runtime.closeSession({ sessionId: session.sessionId });
    } finally {
      await runtime.disposeAllAndWait();
    }
  });
});

interface FakeAcpAgentOptions {
  initializeGatePath?: string;
  initializeAttemptPath?: string;
  tracePath?: string;
  envCapturePath?: string;
  pidCapturePath?: string;
  initializeError?: string;
  closeTransportDuringInitialize?: boolean;
  failFirstInitialize?: boolean;
  hangCancel?: boolean;
  hangClose?: boolean;
  serveSupportsStdio?: boolean;
}

function fakeAcpAgentSource(sdkUrl: string, options: FakeAcpAgentOptions = {}): string {
  return `
import * as acp from ${JSON.stringify(sdkUrl)};
import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

const initializeGatePath = ${JSON.stringify(options.initializeGatePath ?? null)};
const initializeAttemptPath = ${JSON.stringify(options.initializeAttemptPath ?? null)};
const tracePath = ${JSON.stringify(options.tracePath ?? null)};
const envCapturePath = ${JSON.stringify(options.envCapturePath ?? null)};
const pidCapturePath = ${JSON.stringify(options.pidCapturePath ?? null)};
const initializeError = ${JSON.stringify(options.initializeError ?? null)};
const closeTransportDuringInitialize = ${JSON.stringify(options.closeTransportDuringInitialize ?? false)};
const failFirstInitialize = ${JSON.stringify(options.failFirstInitialize ?? false)};
const hangCancel = ${JSON.stringify(options.hangCancel ?? false)};
const hangClose = ${JSON.stringify(options.hangClose ?? false)};
const serveSupportsStdio = ${JSON.stringify(options.serveSupportsStdio ?? true)};
const log = async (entry) => {
  if (tracePath) await appendFile(tracePath, entry + "\\n");
};

const configOptions = () => [
  {
    id: "model", name: "Model", category: "model", type: "select", currentValue: model,
    options: [{ value: "zen/free-model", name: "Free model" }, { value: "local/test", name: "Local test" }],
  },
  {
    id: "mode", name: "Agent", category: "mode", type: "select", currentValue: mode,
    options: [{ value: "build", name: "Build" }, { value: "plan", name: "Plan" }],
  },
];
let model = "local/test";
let mode = "build";
let sessionNumber = 0;
const pendingPrompts = new Map();

if (process.argv[2] === "--version") {
  process.stdout.write("Fake OpenCode CLI\\n");
} else if (process.argv.includes("serve")) {
  process.stdout.write(serveSupportsStdio ? "Options: --stdio --port\\n" : "Options: --port --hostname\\n");
} else {
  if (envCapturePath) await writeFile(envCapturePath, JSON.stringify(Object.keys(process.env)));
  if (pidCapturePath) await writeFile(pidCapturePath, String(process.pid));
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  new acp.AgentSideConnection((connection) => ({
    async initialize() {
      await log("initialize:start");
      if (closeTransportDuringInitialize) {
        process.stdout.end();
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }
      let initializeAttempt = 1;
      if (initializeAttemptPath) {
        initializeAttempt = Number(await readFile(initializeAttemptPath, "utf8").catch(() => "0")) + 1;
        await writeFile(initializeAttemptPath, String(initializeAttempt));
      }
      if (initializeGatePath) {
        while (true) {
          try {
            await access(initializeGatePath);
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
      }
      if (failFirstInitialize && initializeAttempt === 1) {
        await log("initialize:failed");
        throw new Error("fake initialize failure");
      }
      if (initializeError && initializeAttempt === 1) {
        await log("initialize:failed");
        throw new Error(initializeError);
      }
      await log("initialize:end");
      return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { close: {} } } };
    },
    async newSession() {
      sessionNumber += 1;
      await log("session:new:" + sessionNumber);
      return { sessionId: "fake-session-" + sessionNumber, configOptions: configOptions() };
    },
    async setSessionConfigOption(params) {
      if (params.configId === "model") model = params.value;
      if (params.configId === "mode") mode = params.value;
      return { configOptions: configOptions() };
    },
    async prompt(params) {
      await log("prompt:start");
      if (params.prompt[0]?.text === "request permission") {
        const response = await connection.requestPermission({
          sessionId: params.sessionId,
          options: [
            { optionId: "allow-once", kind: "allow_once", name: "Allow this command once" },
            { optionId: "allow-always", kind: "allow_always", name: "Always allow this command" },
            { optionId: "reject-once", kind: "reject_once", name: "Reject this command once" },
          ],
          toolCall: {
            toolCallId: "tool-shell-1",
            title: "Run shell command",
            kind: "execute",
            status: "pending",
            rawInput: { command: "echo approved" },
          },
        });
        return { stopReason: response.outcome.outcome === "selected" ? "end_turn" : "cancelled" };
      }
      await connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake response" } },
      });
      return await new Promise((resolve) => pendingPrompts.set(params.sessionId, resolve));
    },
    async cancel(params) {
      if (hangCancel) return await new Promise(() => {});
      pendingPrompts.get(params.sessionId)?.({ stopReason: "cancelled" });
      pendingPrompts.delete(params.sessionId);
    },
    async closeSession(params) {
      if (hangClose) return await new Promise(() => {});
      pendingPrompts.delete(params.sessionId);
      return {};
    },
  }), stream);
}
`;
}
