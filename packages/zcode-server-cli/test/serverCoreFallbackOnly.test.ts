import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REMOTE_AGENT_NETWORK_HANDOFF_FILE,
  ZCODE_HTTP_PROXY_FALLBACK_ONLY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  parseRemoteAgentNetworkHandoff,
  serializeRemoteAgentNetworkHandoff,
} from "@zcode/shared";
import { describe, expect, it } from "vitest";
import {
  createAgentNetworkResolver,
  resolveServerCoreAgentNetwork,
} from "../src/server-core/remoteAgentNetwork.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

/**
 * The full hop chain the remote workspace actually executes:
 *
 *   Desktop handoff (launch env or handoff file)
 *     -> Source Server core resolver (server-core/remoteAgentNetwork.ts)
 *     -> createServerHostServices({remoteAgentNetwork}) -> resolveSpawnEnv
 *     -> buildAgentRuntimeEnv(fallbackOnly) -> the Agent child's environment
 *
 * The link that was broken: the resolver only ever ran in `entry-stdio.ts`, which the
 * remote does not run, so `ZCODE_HTTP_PROXY_FALLBACK_ONLY` never reached an Agent on a
 * supervisor-started daemon, and `createServerHostServices` hardcoded
 * `standalone-server` without forwarding a network at all.
 *
 * The parts are asserted where each lives: the typed value here, the spawn-env patch in
 * `services/test/agentProxyFallbackOnly.test.ts`, and the removal of the
 * `isDesktopAttachedRemote` gate in `services/test/agentProxyEnv.test.ts`. Together they
 * cover the chain without a mock rig that would test the rig.
 */
async function coreNetworkFor(input: {
  env: Record<string, string | undefined>;
  handoff?: Record<string, unknown>;
}) {
  const serverRoot = await mkdtemp(join(tmpdir(), "zcode-relay-chain-"));
  try {
    await mkdir(serverRoot, { recursive: true });
    if (input.handoff) {
      await writeFile(
        join(serverRoot, REMOTE_AGENT_NETWORK_HANDOFF_FILE),
        JSON.stringify(input.handoff),
        "utf8",
      );
    }
    return await resolveServerCoreAgentNetwork(resolveServerLayout(serverRoot), input.env);
  } finally {
    await rm(serverRoot, { recursive: true, force: true });
  }
}

describe("the Source Server core receives fallback-only for a remote workspace", () => {
  it("carries the flag from a supervisor-started daemon's handoff file", async () => {
    const resolved = await coreNetworkFor({
      env: {},
      handoff: { httpProxy: "http://127.0.0.1:41234", noProxy: null, fallbackOnly: true },
    });
    expect(resolved.source).toBe("handoff-file");
    // This typed value is what createServerHostServices forwards to resolveSpawnEnv.
    expect(resolved.network).toEqual({
      httpProxy: "http://127.0.0.1:41234",
      noProxy: undefined,
      fallbackOnly: true,
    });
  });

  it("carries the flag from a launch environment, the path a Desktop-launched core uses", async () => {
    const resolved = await coreNetworkFor({
      env: {
        [ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]: "1",
        [ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]: "http://127.0.0.1:41234",
        [ZCODE_HTTP_PROXY_FALLBACK_ONLY_ENV_KEY]: "1",
      },
    });
    expect(resolved.source).toBe("env");
    expect(resolved.network?.fallbackOnly).toBe(true);
  });

  it("leaves a host without a relay completely unchanged (the inert default)", async () => {
    const resolved = await coreNetworkFor({ env: {} });
    // undefined means `resolveSpawnEnv` takes its ordinary settings branch: the remote
    // keeps whatever the owner configured, exactly as before this change.
    expect(resolved.network).toBeUndefined();
    expect(resolved.source).toBe("none");
  });

  it("does not mark an owner-configured proxy as a fallback", async () => {
    const resolved = await coreNetworkFor({
      env: {
        [ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]: "1",
        [ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]: "http://10.0.0.5:3128",
      },
    });
    expect(resolved.network?.httpProxy).toBe("http://10.0.0.5:3128");
    expect(resolved.network?.fallbackOnly).toBe(false);
  });
});

describe("the Agent spawn path re-reads the handoff every time", () => {
  /**
   * The regression this covers. The relay's REMOTE loopback port is OS-assigned per SSH
   * connection (`forwardIn("127.0.0.1", 0, …)`), so a reconnect of the same workspace
   * legitimately produces a different address. A Core that captured the handoff once at
   * boot would hand every later Agent a dead port; the earlier version instead signalled
   * a Core restart whenever the bytes changed, which killed running work on EVERY
   * reconnect of EVERY SSH workspace — including hosts whose own egress works fine.
   * Re-reading per spawn fixes both: the new address applies, nothing restarts.
   */
  it("picks up an address that changed after the Core started, without a restart", async () => {
    const serverRoot = await mkdtemp(join(tmpdir(), "zcode-relay-respawn-"));
    try {
      await mkdir(serverRoot, { recursive: true });
      const layout = resolveServerLayout(serverRoot);
      const handoffPath = join(serverRoot, REMOTE_AGENT_NETWORK_HANDOFF_FILE);
      await writeFile(
        handoffPath,
        JSON.stringify({ httpProxy: "http://127.0.0.1:41234", fallbackOnly: true }),
        "utf8",
      );
      const resolve = createAgentNetworkResolver(layout, {});
      // First agent spawn on this Core.
      expect((await resolve())?.httpProxy).toBe("http://127.0.0.1:41234");
      // The Desktop reconnects: its tunnel comes back on a NEW remote port.
      await writeFile(
        handoffPath,
        JSON.stringify({ httpProxy: "http://127.0.0.1:51000", fallbackOnly: true }),
        "utf8",
      );
      // The next spawn sees the new port. Same Core, no restart in between.
      expect(await resolve()).toEqual({
        httpProxy: "http://127.0.0.1:51000",
        noProxy: undefined,
        fallbackOnly: true,
      });
    } finally {
      await rm(serverRoot, { recursive: true, force: true });
    }
  });

  it("yields undefined, not a stale address, once the relay is gone", async () => {
    const serverRoot = await mkdtemp(join(tmpdir(), "zcode-relay-gone-"));
    try {
      await mkdir(serverRoot, { recursive: true });
      const layout = resolveServerLayout(serverRoot);
      const handoffPath = join(serverRoot, REMOTE_AGENT_NETWORK_HANDOFF_FILE);
      await writeFile(
        handoffPath,
        JSON.stringify({ httpProxy: "http://127.0.0.1:41234", fallbackOnly: true }),
        "utf8",
      );
      const resolve = createAgentNetworkResolver(layout, {});
      expect(await resolve()).toBeDefined();
      await rm(handoffPath);
      // The owner then gets its own saved proxy settings back, never a dead relay.
      await expect(resolve()).resolves.toBeUndefined();
    } finally {
      await rm(serverRoot, { recursive: true, force: true });
    }
  });

  it("keeps the launch environment as the first carrier", async () => {
    const serverRoot = await mkdtemp(join(tmpdir(), "zcode-relay-env-"));
    try {
      await mkdir(serverRoot, { recursive: true });
      const layout = resolveServerLayout(serverRoot);
      const resolve = createAgentNetworkResolver(layout, {
        [ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]: "1",
        [ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]: "http://127.0.0.1:42000",
        [ZCODE_HTTP_PROXY_FALLBACK_ONLY_ENV_KEY]: "1",
      });
      expect((await resolve())?.fallbackOnly).toBe(true);
    } finally {
      await rm(serverRoot, { recursive: true, force: true });
    }
  });
});

describe("the handoff file format is one contract", () => {
  it("round-trips exactly what a reader needs and nothing else", async () => {
    const serialized = serializeRemoteAgentNetworkHandoff({
      httpProxy: "http://127.0.0.1:41234",
      noProxy: "localhost,127.0.0.1",
      fallbackOnly: true,
    });
    expect(JSON.parse(serialized)).toEqual({
      httpProxy: "http://127.0.0.1:41234",
      noProxy: "localhost,127.0.0.1",
      fallbackOnly: true,
    });
    expect(parseRemoteAgentNetworkHandoff(serialized)).toEqual({
      httpProxy: "http://127.0.0.1:41234",
      noProxy: "localhost,127.0.0.1",
      fallbackOnly: true,
    });
  });

  it("refuses a relay flag with no address, so a stray flag cannot reroute a direct host", async () => {
    expect(parseRemoteAgentNetworkHandoff(JSON.stringify({ fallbackOnly: true }))).toBeUndefined();
    expect(parseRemoteAgentNetworkHandoff("not json")).toBeUndefined();
    expect(parseRemoteAgentNetworkHandoff("[]")).toBeUndefined();
  });
});

describe("one resolver, both entries", () => {
  it("is the same implementation the stdio entry re-exports", async () => {
    // The stdio surface must export the shared function itself, not a copy: a second
    // implementation is exactly how the consumer half ended up on an entry the remote
    // does not run. Asserted from the server package, where both live in one tree.
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const stdioSource = await readFile(join(repoRoot, "packages/server/src/stdioServices.ts"), "utf8");
    expect(stdioSource).toContain("export { resolveRemoteAgentNetworkFromEnv }");
    expect(stdioSource).not.toContain("export function resolveRemoteAgentNetworkFromEnv");
    // And the core imports the same symbol from @zcode/shared.
    const coreSource = await readFile(
      join(import.meta.dirname, "../src/server-core/remoteAgentNetwork.ts"),
      "utf8",
    );
    expect(coreSource).toContain("resolveRemoteAgentNetworkFromEnv");
    expect(coreSource).toContain('from "@zcode/shared"');
  });
});
