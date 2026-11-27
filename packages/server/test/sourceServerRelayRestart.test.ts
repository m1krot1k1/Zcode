import { PassThrough } from "node:stream";
import { Emitter } from "@zcode/rpc";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import { createSourceServerTransportAdapter } from "../src/source-server/transportAdapter.js";
import { describe, expect, it } from "vitest";

/**
 * An egress-relay reconnect must NEVER restart the remote Core.
 *
 * This file used to prove the opposite — that a relay-driven restart returns the new
 * port and the new token, never a mixed pair. The premise was wrong, and the correction
 * is the point of keeping the file: the relay's remote loopback port is OS-assigned on
 * EVERY SSH connection (`SshEgressExposure.install` calls `forwardIn("127.0.0.1", 0, …)`
 * and `reportDisconnect` resets it), and `create-backend` enables the relay for every
 * SSH target without any isolation check. Restarting on a changed address therefore
 * killed in-flight work on every reconnect of every SSH workspace — including hosts
 * whose own egress works fine and will never use the relay.
 *
 * So the invariant is now negative and cheap to state: `ensureDaemon` performs no
 * restart, and the ingress pair it returns still belongs to one running Core.
 */

function streamOf(stdoutText: string, code = 0): StdioStream {
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

interface RelayScenario {
  /** The relay address the CURRENT tunnel exposes; a reconnect produces a new one. */
  relayUrl: string;
  /** Exact handoff bytes the remote already holds, if any. */
  existingHandoff?: string;
  ingressToken?: string;
}

class RelayBackend implements IRemoteBackend {
  readonly commands: string[] = [];
  readonly files = new Map<string, string>();
  readonly egressRelayFallbackOnly = true;

  constructor(private readonly scenario: RelayScenario) {
    if (scenario.existingHandoff !== undefined) {
      this.files.set("~/.zcode/server/remote-agent-network.json", scenario.existingHandoff);
    }
  }

  async resolveRuntimeProxy(proxyUrl: string): Promise<string> {
    return proxyUrl || this.scenario.relayUrl;
  }

  async detect() {
    return { platform: "linux", arch: "x64" };
  }

  async upload(): Promise<void> {}

  async exec(command: string): Promise<StdioStream> {
    this.commands.push(command);
    const write = /printf %s '([^']*)' > "\$HOME\/([^"]+)"/.exec(command);
    if (write) this.files.set(`~/${write[2]}`, `${write[1]}\n`);
    return streamOf("");
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async readFile(remotePath: string): Promise<string> {
    if (remotePath.endsWith("run/ingress-token")) {
      return this.scenario.ingressToken ?? "ingress-token";
    }
    const value = this.files.get(remotePath);
    if (value === undefined) throw new Error(`ENOENT: ${remotePath}`);
    return value;
  }
}

const target = { kind: "ssh" } as unknown as RemoteTarget;

describe("ensureDaemon never restarts the Core for the relay", () => {
  it("reconnect with a NEW relay port: no restart, current port and token kept", async () => {
    // A fresh tunnel: same daemon, new remote loopback port. This is the case that used
    // to kill running work, because the bytes on disk differed.
    const backend = new RelayBackend({
      relayUrl: "http://127.0.0.1:51000",
      existingHandoff: '{"httpProxy":"http://127.0.0.1:41234","noProxy":null,"fallbackOnly":true}\n',
      ingressToken: "current-token",
    });
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });

    const ingress = await adapter.ensureDaemon(
      target,
      {},
      { observedStatus: { state: "ready", port: 36511 } },
    );

    expect(ingress).toEqual({ port: 36511, ingressToken: "current-token" });
    // No restart, no status round trip: the daemon is untouched.
    expect(backend.commands.some((command) => command.includes("'restart'"))).toBe(false);
    expect(backend.commands.some((command) => command.includes("'status'"))).toBe(false);
    // The new address is published for the NEXT agent spawn.
    expect(backend.files.get("~/.zcode/server/remote-agent-network.json")).toContain("51000");
  });

  it("first connect with no handoff at all: writes it, still no restart", async () => {
    const backend = new RelayBackend({ relayUrl: "http://127.0.0.1:41234" });
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });

    const ingress = await adapter.ensureDaemon(
      target,
      {},
      { observedStatus: { state: "ready", port: 36511 } },
    );

    expect(ingress).toEqual({ port: 36511, ingressToken: "ingress-token" });
    expect(backend.commands.some((command) => command.includes("'restart'"))).toBe(false);
    expect(backend.files.get("~/.zcode/server/remote-agent-network.json")).toContain("41234");
  });

  it("a backend that offers no relay writes nothing and restarts nothing", async () => {
    // WSL without a rewrite, Docker: the remote keeps its own settings. Only the two
    // relay hooks are absent; the backend is otherwise the same object.
    const backend = new RelayBackend({ relayUrl: "http://127.0.0.1:41234" });
    Object.defineProperty(backend, "resolveRuntimeProxy", { value: undefined });
    Object.defineProperty(backend, "egressRelayFallbackOnly", { value: undefined });
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });

    const ingress = await adapter.ensureDaemon(
      target,
      {},
      { observedStatus: { state: "ready", port: 36511 } },
    );

    expect(ingress.port).toBe(36511);
    expect(backend.commands.some((command) => command.includes("'restart'"))).toBe(false);
    // And nothing was written: no relay was offered to publish.
    expect(backend.files.has("~/.zcode/server/remote-agent-network.json")).toBe(false);
  });
});
