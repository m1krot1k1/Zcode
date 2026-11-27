import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REMOTE_AGENT_NETWORK_HANDOFF_FILE,
  parseRemoteAgentNetworkHandoff,
  resolveRemoteAgentNetworkFromEnv,
  type RemoteAgentNetworkOptions,
} from "@zcode/shared";
import type { ServerLayout } from "../runtime/paths.js";

export interface ServerCoreAgentNetwork {
  network: RemoteAgentNetworkOptions | undefined;
  /** Where the value came from: diagnostics only, never a grant. */
  source: "env" | "handoff-file" | "none";
  /** Why a handoff file that exists could not be used; undefined when none was needed. */
  handoffProblem?: string;
}

/**
 * Resolve the Agent network handoff for a Source Server core.
 *
 * Two carriers, one meaning:
 * - the process environment, which is how a Desktop launches the legacy stdio
 *   entry (`entry-stdio.ts`) and how the R3 bootstrap launches a fresh daemon;
 * - `~/.zcode/server/remote-agent-network.json`, written by the Desktop before it
 *   starts the daemon. It exists because the common deployment on an SSH host is a
 *   *supervisor-started* daemon (systemd/launchd user service) whose environment
 *   was fixed at boot, long before any Desktop connected. That process can never
 *   see a later `ZCODE_REMOTE_*` variable, but it can read a file at core start.
 *
 * A missing or malformed handoff yields `undefined`, so the previous behaviour —
 * the remote's own saved proxy settings — is untouched.
 */
export async function resolveServerCoreAgentNetwork(
  layout: ServerLayout,
  env: Record<string, string | undefined> = process.env,
): Promise<ServerCoreAgentNetwork> {
  const fromEnv = resolveRemoteAgentNetworkFromEnv(env);
  if (fromEnv) {
    return { network: fromEnv, source: "env" };
  }
  const handoffPath = join(layout.serverRoot, REMOTE_AGENT_NETWORK_HANDOFF_FILE);
  let text: string;
  try {
    text = await readFile(handoffPath, "utf8");
  } catch (error) {
    // Absence is the ordinary case: a host whose Desktop never offered a relay,
    // or one whose owner configured a proxy directly.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { network: undefined, source: "none" };
    }
    return {
      network: undefined,
      source: "none",
      handoffProblem: error instanceof Error ? error.message : String(error),
    };
  }
  const network = parseRemoteAgentNetworkHandoff(text);
  if (!network) {
    return { network: undefined, source: "none", handoffProblem: "unusable handoff content" };
  }
  return { network, source: "handoff-file" };
}
