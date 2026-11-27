import { PassThrough } from "node:stream";
import { Emitter } from "@zcode/rpc";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import { createSourceServerTransportAdapter } from "../src/source-server/transportAdapter.js";
import { describe, expect, it } from "vitest";

/**
 * A Core replacement changes TWO values the transport must read afterwards: the ingress
 * port and the ingress token. `createIngressToken` mints a fresh random token on every
 * Core start (`server-core/ingressToken.ts`), so a token read before the restart settles
 * belongs to the Core that is about to die — the pair would be "new port + old token" and
 * every request answers 401.
 *
 * `restart --json` only acknowledges: `Supervisor.startAcknowledgedLifecycleOperation`
 * defers the actual operation, so an early status poll still sees the OLD Core reporting
 * `ready` on the OLD port. Waiting for the word `ready` is not enough; the process
 * identity (`startedAt`) has to change.
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

const HANDOFF_PATH = "~/.zcode/server/remote-agent-network.json";

interface RestartScenario {
  /** Status answers in order; the last one repeats. */
  statuses: Array<{ state: string; port: number | null; startedAt: number | null }>;
  /** Token before and after the Core was replaced. */
  oldToken: string;
  newToken: string;
  restartExitCode?: number;
}

class RestartBackend implements IRemoteBackend {
  readonly commands: string[] = [];
  readonly files = new Map<string, string>();
  /** Set by exec("restart") — from then on readFile reports the NEW token. */
  private coreReplaced = false;
  private statusIndex = 0;
  private readonly relayUrl = "http://127.0.0.1:41234";
  readonly egressRelayFallbackOnly = true;

  constructor(private readonly scenario: RestartScenario) {}

  async resolveRuntimeProxy(proxyUrl: string): Promise<string> {
    return proxyUrl || this.relayUrl;
  }

  async detect() {
    return { platform: "linux", arch: "x64" };
  }

  async upload(): Promise<void> {}

  async exec(command: string): Promise<StdioStream> {
    this.commands.push(command);
    // The adapter builds a shell command (`"$HOME/.zcode/server/bin/zcode" 'restart' '--json'`),
    // so match the quoted subcommands it composes, not a bare argv.
    if (command.includes("'restart'")) {
      // Acknowledgement only: the Core has NOT been replaced yet at this point.
      return streamOf(JSON.stringify({ restarting: true }));
    }
    if (command.includes("'status'")) {
      const status =
        this.scenario.statuses[Math.min(this.statusIndex++, this.scenario.statuses.length - 1)]!;
      // The replacement becomes observable only once a status reports a new startedAt.
      if (status.startedAt !== this.scenario.statuses[0]!.startedAt) {
        this.coreReplaced = true;
      }
      return streamOf(JSON.stringify(status));
    }
    const write = /printf %s '([^']*)' > "\$HOME\/([^"]+)"/.exec(command);
    if (write) this.files.set(`~/${write[2]}`, `${write[1]}\n`);
    return streamOf("");
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async readFile(remotePath: string): Promise<string> {
    if (remotePath.endsWith("run/ingress-token")) {
      // THE defect this test exists for: the token follows the Core, not the caller.
      return this.coreReplaced ? this.scenario.newToken : this.scenario.oldToken;
    }
    const value = this.files.get(remotePath);
    if (value === undefined) throw new Error(`ENOENT: ${remotePath}`);
    return value;
  }
}

const target = { kind: "ssh" } as unknown as RemoteTarget;

describe("ensureDaemon after a relay-driven Core restart", () => {
  it("returns the NEW port and the NEW token, never a mixed pair", async () => {
    const backend = new RestartBackend({
      // ready(old) is what the ack window looks like before the supervisor moves.
      statuses: [
        { state: "ready", port: 36511, startedAt: 1000 },
        { state: "ready", port: 36511, startedAt: 1000 },
        { state: "stopping", port: 36511, startedAt: 1000 },
        { state: "ready", port: 40123, startedAt: 2000 },
      ],
      oldToken: "old-token",
      newToken: "new-token",
    });
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });

    const ingress = await adapter.ensureDaemon(
      target,
      {},
      { observedStatus: { state: "ready", port: 36511 } },
    );

    expect(ingress).toEqual({ port: 40123, ingressToken: "new-token" });
  });

  it("refuses to fall back to the old port when the Core cannot come back", async () => {
    const backend = new RestartBackend({
      statuses: [
        { state: "ready", port: 36511, startedAt: 1000 },
        { state: "crash-loop-stopped", port: null, startedAt: null },
      ],
      oldToken: "old-token",
      newToken: "new-token",
    });
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });

    await expect(
      adapter.ensureDaemon(target, {}, { observedStatus: { state: "ready", port: 36511 } }),
    ).rejects.toThrow(/could not restart/);
  });
});

/**
 * The handoff only asks for a restart when the remote bytes actually changed, so a
 * healthy reconnect must not disturb the daemon at all.
 */
describe("no restart without a changed handoff", () => {
  it("keeps the current port and does not ask for a restart", async () => {
    const backend = new RestartBackend({
      statuses: [{ state: "ready", port: 36511, startedAt: 1000 }],
      oldToken: "current-token",
      newToken: "unused",
    });
    // Pre-seed the exact handoff the device would write: unchanged, so no restart.
    backend.files.set(
      HANDOFF_PATH,
      '{"httpProxy":"http://127.0.0.1:41234","noProxy":null,"fallbackOnly":true}\n',
    );
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });

    const ingress = await adapter.ensureDaemon(
      target,
      {},
      { observedStatus: { state: "ready", port: 36511 } },
    );

    expect(ingress).toEqual({ port: 36511, ingressToken: "current-token" });
    expect(backend.commands.some((command) => command.includes("restart"))).toBe(false);
  });
});
