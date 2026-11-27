import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMOTE_AGENT_NETWORK_HANDOFF_FILE,
  ZCODE_HTTP_PROXY_FALLBACK_ONLY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@zcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import { resolveServerCoreAgentNetwork } from "../src/server-core/remoteAgentNetwork.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

/**
 * The Source Server core is the entry a remote workspace actually runs — not the
 * legacy stdio entry (`entry-stdio.ts`). Before this resolver existed the network
 * handoff was read only by the stdio entry, so a supervisor-started daemon never saw
 * the relay and fallback-only never reached the agent.
 *
 * Both cases matter: with the handoff the relay is carried as a typed value, and
 * WITHOUT it nothing changes — a host whose owner configured a proxy keeps using its
 * own settings, first-choice.
 */
describe("Source Server core agent network handoff", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function makeServerRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "zcode-server-core-network-"));
    roots.push(root);
    await mkdir(root, { recursive: true });
    return root;
  }

  it("reads the handoff written by the Desktop for a supervisor-started daemon", async () => {
    const serverRoot = await makeServerRoot();
    const layout = resolveServerLayout(serverRoot);
    await writeFile(
      join(serverRoot, REMOTE_AGENT_NETWORK_HANDOFF_FILE),
      JSON.stringify({ httpProxy: "http://127.0.0.1:41234", noProxy: null, fallbackOnly: true }),
      "utf8",
    );

    const resolved = await resolveServerCoreAgentNetwork(layout, {});
    expect(resolved.source).toBe("handoff-file");
    expect(resolved.network).toEqual({
      httpProxy: "http://127.0.0.1:41234",
      noProxy: undefined,
      fallbackOnly: true,
    });
  });

  it("prefers the process environment when the Desktop launched the core itself", async () => {
    const serverRoot = await makeServerRoot();
    const layout = resolveServerLayout(serverRoot);
    await writeFile(
      join(serverRoot, REMOTE_AGENT_NETWORK_HANDOFF_FILE),
      JSON.stringify({ httpProxy: "http://127.0.0.1:1", fallbackOnly: false }),
      "utf8",
    );

    const resolved = await resolveServerCoreAgentNetwork(layout, {
      [ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]: "1",
      [ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]: "http://127.0.0.1:41234",
      [ZCODE_REMOTE_NO_PROXY_ENV_KEY]: "localhost",
      [ZCODE_HTTP_PROXY_FALLBACK_ONLY_ENV_KEY]: "1",
    });
    expect(resolved.source).toBe("env");
    expect(resolved.network).toEqual({
      httpProxy: "http://127.0.0.1:41234",
      noProxy: "localhost",
      fallbackOnly: true,
    });
  });

  it("leaves behaviour unchanged when no handoff was offered", async () => {
    const serverRoot = await makeServerRoot();
    const resolver = await resolveServerCoreAgentNetwork(resolveServerLayout(serverRoot), {});
    expect(resolver).toMatchObject({ network: undefined, source: "none" });
    expect(resolver.handoffProblem).toBeUndefined();
  });

  it("treats an unusable handoff as no handoff instead of inventing an address", async () => {
    const serverRoot = await makeServerRoot();
    const layout = resolveServerLayout(serverRoot);
    await writeFile(join(serverRoot, REMOTE_AGENT_NETWORK_HANDOFF_FILE), "{not json", "utf8");
    const malformed = await resolveServerCoreAgentNetwork(layout, {});
    expect(malformed.network).toBeUndefined();
    expect(malformed.handoffProblem).toBe("unusable handoff content");

    // A handoff without a proxy cannot make the agent use one.
    await writeFile(
      join(serverRoot, REMOTE_AGENT_NETWORK_HANDOFF_FILE),
      JSON.stringify({ fallbackOnly: true }),
      "utf8",
    );
    const empty = await resolveServerCoreAgentNetwork(layout, {});
    expect(empty.network).toBeUndefined();
    expect(empty.handoffProblem).toBe("unusable handoff content");
  });

  it("surfaces a read failure that is not plain absence", async () => {
    const serverRoot = await makeServerRoot();
    const layout = resolveServerLayout(serverRoot);
    // A directory where the file belongs is readable-absent nowhere: it is a real fault.
    await mkdir(join(serverRoot, REMOTE_AGENT_NETWORK_HANDOFF_FILE), { recursive: true });
    const resolved = await resolveServerCoreAgentNetwork(layout, {});
    expect(resolved.network).toBeUndefined();
    expect(resolved.handoffProblem).toBeTruthy();
  });
});
