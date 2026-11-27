import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import {
  REMOTE_AGENT_NETWORK_HANDOFF_FILE,
  serializeRemoteAgentNetworkHandoff,
  type RemoteAgentNetworkOptions,
} from "@zcode/shared";
import {
  collectCommand,
  quoteShellArg,
} from "@zcode/server/source-server/sourceServerTransportRuntime.js";

/**
 * How the Desktop hands a synthesized egress relay to a Source Server it did not launch.
 *
 * The common deployment on an SSH host is a supervisor-started daemon: a systemd
 * user unit (or launchd agent) started at login, whose environment was fixed at
 * boot. A Desktop that connects an hour later cannot put `ZCODE_REMOTE_*` into that
 * process — the R3 transport does not spawn the server at all, it dials an ingress
 * port. So the handoff travels as a file the Core reads when it starts, and the
 * Desktop asks the *Core* to restart when the file's content actually changed. The
 * supervisor keeps running, so the tunnel and the process identity survive.
 *
 * Nothing here invents a proxy: a backend that offers no relay (WSL without a
 * rewrite, Docker) produces no handoff and the remote keeps its own settings.
 */
export const REMOTE_AGENT_NETWORK_HANDOFF_REMOTE_PATH = `~/.zcode/server/${REMOTE_AGENT_NETWORK_HANDOFF_FILE}`;

/** One shell command that replaces the handoff file atomically. */
export function buildRemoteAgentNetworkHandoffCommand(network: RemoteAgentNetworkOptions): string {
  const handoffPath = `"$HOME/.zcode/server/${REMOTE_AGENT_NETWORK_HANDOFF_FILE}"`;
  const stagingPath = `${handoffPath}.tmp-$(date +%s)-$$`;
  return [
    "set -eu",
    'mkdir -p "$HOME/.zcode/server"',
    // The serialized text ends with a newline for the file's sake; the shell word gets
    // the trimmed form so the whole command stays one line.
    `printf %s ${quoteShellArg(serializeRemoteAgentNetworkHandoff(network).trim())} > ${stagingPath}`,
    // Rename, not in-place write: a Core starting mid-write must see either the old
    // handoff or the new one, never a half-written JSON that would read as "no relay".
    `mv -f ${stagingPath} ${handoffPath}`,
  ].join(" && ");
}

/** The exact text a backend already holds, or undefined when it holds nothing usable. */
export async function readRemoteAgentNetworkHandoff(
  backend: IRemoteBackend,
): Promise<string | undefined> {
  try {
    const text = (await backend.readFile(REMOTE_AGENT_NETWORK_HANDOFF_REMOTE_PATH)).trim();
    return text || undefined;
  } catch {
    // Missing or unreadable is the ordinary case on a host the Desktop never handed a
    // relay to; it must not fail the connection.
    return undefined;
  }
}

export interface ApplyRemoteAgentNetworkHandoffResult {
  /** "written" only when the remote bytes changed. */
  outcome: "written" | "unchanged" | "skipped";
  /** True when a running Core must restart to see a changed handoff. */
  requiresCoreRestart: boolean;
  reason?: string;
}

/**
 * Write the handoff when it differs from what the remote already has.
 *
 * Idempotent by design: a connection that finds its own previous handoff unchanged
 * writes nothing and restarts nothing, so reconnecting a healthy workspace costs one
 * file read and no service disruption.
 */
export async function applyRemoteAgentNetworkHandoff(input: {
  backend: IRemoteBackend;
  network: RemoteAgentNetworkOptions | undefined;
  log?: (message: string) => void;
}): Promise<ApplyRemoteAgentNetworkHandoffResult> {
  const { backend, network, log } = input;
  if (!network?.httpProxy) {
    return { outcome: "skipped", requiresCoreRestart: false, reason: "no relay offered" };
  }
  const desired = serializeRemoteAgentNetworkHandoff(network).trim();
  const current = await readRemoteAgentNetworkHandoff(backend);
  if (current === desired) {
    return { outcome: "unchanged", requiresCoreRestart: false };
  }
  const result = await collectCommand(
    await backend.exec(buildRemoteAgentNetworkHandoffCommand(network)),
  );
  if (result.exitCode !== 0) {
    // A relay that could not be recorded is not a connection failure: the remote
    // keeps its own settings and reports the network error itself.
    log?.(
      `egress relay handoff could not be written (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
    return {
      outcome: "skipped",
      requiresCoreRestart: false,
      reason: `handoff write exited with ${result.exitCode}`,
    };
  }
  log?.("egress relay handoff written for a supervisor-started Source Server");
  return { outcome: "written", requiresCoreRestart: true };
}
