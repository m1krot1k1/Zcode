import { PassThrough } from "node:stream";
import { Emitter } from "@zcode/rpc";
import { serializeRemoteAgentNetworkHandoff } from "@zcode/shared";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import {
  applyRemoteAgentNetworkHandoff,
  buildRemoteAgentNetworkHandoffCommand,
  readRemoteAgentNetworkHandoff,
} from "../src/source-server/remoteAgentNetworkHandoff.js";
import { describe, expect, it } from "vitest";

/**
 * How a device relay reaches a daemon the Desktop did not launch.
 *
 * The transport dials an already-running supervisor-started daemon, so there is no
 * spawn whose environment could carry `ZCODE_REMOTE_*`. The handoff is a file the Core
 * re-reads on every agent spawn.
 *
 * The regression this file exists to prevent: the relay's remote loopback port is
 * assigned by the OS on EVERY SSH connection (`forwardIn("127.0.0.1", 0, …)`), so a
 * reconnect legitimately produces a different address. An earlier version treated
 * "bytes changed" as a reason to restart the Core, which meant every reconnect of
 * every SSH workspace — including hosts with working internet — killed running work
 * there. The two cases below therefore use DIFFERENT relay URLs for the reconnect:
 * a fixture that holds the port constant hides exactly this bug.
 */

function completedStream(stdoutText = "", code = 0): StdioStream {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = new Emitter<number>();
  setTimeout(() => {
    stdout.end(stdoutText);
    stderr.end();
    closed.fire(code);
  }, 0);
  return { stdin, stdout, stderr, onClose: closed.event };
}

class HandoffBackend implements IRemoteBackend {
  readonly commands: string[] = [];
  readonly files = new Map<string, string>();
  execExitCode = 0;
  readonly resolveRuntimeProxy?: (proxyUrl: string) => Promise<string>;
  readonly egressRelayFallbackOnly?: boolean;

  constructor(options: { relayUrl?: string; fallbackOnly?: boolean } = {}) {
    if (options.relayUrl !== undefined) {
      this.resolveRuntimeProxy = async (proxyUrl: string) => proxyUrl || options.relayUrl!;
      this.egressRelayFallbackOnly = options.fallbackOnly === true;
    }
  }

  async detect() {
    return { platform: "linux", arch: "x64" };
  }

  async upload(): Promise<void> {}

  async exec(command: string): Promise<StdioStream> {
    this.commands.push(command);
    // Model the remote: a write command actually replaces the file it names.
    const match = /printf %s '([^']*)' > "\$HOME\/([^"]+)"/.exec(command);
    if (match && this.execExitCode === 0) {
      this.files.set(`~/${match[2]}`, `${match[1]}\n`);
    }
    return completedStream("", this.execExitCode);
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async readFile(remotePath: string): Promise<string> {
    const value = this.files.get(remotePath);
    // A missing file is what a backend raises for an ordinary absence.
    if (value === undefined) throw new Error(`ENOENT: ${remotePath}`);
    return value;
  }
}

describe("remote agent network handoff", () => {
  it("writes an atomically replaced file, never an in-place edit", () => {
    const command = buildRemoteAgentNetworkHandoffCommand({
      httpProxy: "http://127.0.0.1:41234",
      fallbackOnly: true,
    });
    // A Core starting mid-write must see old-or-new, never half-written JSON.
    expect(command).toContain("mv -f ");
    expect(command).toContain("remote-agent-network.json");
    expect(command).toContain('"fallbackOnly":true');
    expect(command).toContain("http://127.0.0.1:41234");
    // One line: nothing that splits a remote command on newlines can break it.
    expect(command).not.toContain("\n");
  });

  it("quotes the payload so shell metacharacters stay literal", () => {
    const command = buildRemoteAgentNetworkHandoffCommand({
      httpProxy: "http://127.0.0.1:41234/$(touch /tmp/pwned)",
      fallbackOnly: true,
    });
    // The payload must sit inside a single-quoted word; inside those, `$(...)` is text.
    const payload = command.slice(command.indexOf("printf %s ") + "printf %s ".length);
    expect(payload.startsWith("'")).toBe(true);
    expect(command).toContain("$(touch /tmp/pwned)");
    expect(command).not.toContain('"$(touch');
  });

  it("reports absence rather than throwing when the file was never written", async () => {
    await expect(readRemoteAgentNetworkHandoff(new HandoffBackend())).resolves.toBeUndefined();
  });

  it("returns exactly the bytes the remote holds", async () => {
    const backend = new HandoffBackend();
    backend.files.set(
      "~/.zcode/server/remote-agent-network.json",
      '{"httpProxy":"http://127.0.0.1:9","fallbackOnly":true}\n',
    );
    expect(await readRemoteAgentNetworkHandoff(backend)).toBe(
      '{"httpProxy":"http://127.0.0.1:9","fallbackOnly":true}',
    );
  });
});

describe("applying the handoff", () => {
  const relay = { httpProxy: "http://127.0.0.1:41234", fallbackOnly: true };

  it("writes the handoff when the remote holds nothing", async () => {
    const backend = new HandoffBackend();
    const applied = await applyRemoteAgentNetworkHandoff({ backend, network: relay });
    expect(applied).toEqual({ outcome: "written" });
    expect(backend.files.get("~/.zcode/server/remote-agent-network.json")).toBe(
      serializeRemoteAgentNetworkHandoff(relay),
    );
  });

  it("is idempotent: identical bytes are not rewritten", async () => {
    const backend = new HandoffBackend();
    await applyRemoteAgentNetworkHandoff({ backend, network: relay });
    const writesBefore = backend.commands.length;
    const second = await applyRemoteAgentNetworkHandoff({ backend, network: relay });
    expect(second).toEqual({ outcome: "unchanged" });
    expect(backend.commands.length).toBe(writesBefore);
  });

  /**
   * The reconnect case, with the port CHANGED — which is what a real reconnect does
   * (`forwardIn("127.0.0.1", 0, …)` asks the OS for a fresh port). The new address
   * must be published, and it must be published WITHOUT any signal to restart the
   * Core: the Core reads the file at spawn time, and a restart would kill the work
   * already running on that workspace.
   */
  it("republishes a changed relay address and never asks to restart the Core", async () => {
    const backend = new HandoffBackend();
    await applyRemoteAgentNetworkHandoff({ backend, network: relay });
    const moved = await applyRemoteAgentNetworkHandoff({
      backend,
      network: { httpProxy: "http://127.0.0.1:51000", fallbackOnly: true },
    });
    expect(moved).toEqual({ outcome: "written" });
    // Not just absent from this result: the result cannot express a restart at all.
    expect(moved).not.toHaveProperty("requiresCoreRestart");
    expect(backend.files.get("~/.zcode/server/remote-agent-network.json")).toContain("51000");
    // No restart command reaches the remote, whatever the outcome.
    expect(backend.commands.some((command) => command.includes("restart"))).toBe(false);
  });

  it("writes nothing at all when the device offers no relay", async () => {
    const backend = new HandoffBackend();
    const applied = await applyRemoteAgentNetworkHandoff({ backend, network: undefined });
    expect(applied).toEqual({
      outcome: "skipped",
      reason: "no relay offered",
    });
    expect(backend.commands).toEqual([]);
  });

  it("treats a failed write as no handoff, never as a connection failure", async () => {
    const backend = new HandoffBackend();
    backend.execExitCode = 1;
    const applied = await applyRemoteAgentNetworkHandoff({ backend, network: relay });
    expect(applied).toMatchObject({ outcome: "skipped" });
    expect(applied.reason).toContain("exited with 1");
  });
});
