import {
  ZCODE_HTTP_PROXY_FALLBACK_ONLY_ENV_KEY,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "./runtimeEnv.js";

/**
 * The one Agent network handoff a Desktop can give a remote workspace.
 *
 * Two different entries consume it — the legacy stdio entry (`entry-stdio.ts`) and
 * the Source Server core (`zcode-server-cli/src/server-core/core.ts`) — so the
 * resolver lives here once. Keeping a second copy is how the consumer half ended
 * up wired to an entry the remote does not run.
 *
 * `fallbackOnly` has to be a typed field rather than something read from the
 * environment at spawn time: the runtime env scrub removes
 * `ZCODE_HTTP_PROXY_FALLBACK_ONLY` (and the other `ZCODE_REMOTE_*` keys) before
 * any Agent spawn, so the value exists only at the moment this resolver runs.
 */
export interface RemoteAgentNetworkOptions {
  httpProxy?: string;
  httpProxyList?: string;
  noProxy?: string;
  /**
   * The proxy is a last resort: the agent tries its own egress first and reaches
   * it only after a network failure. Only a relay synthesized by the device gets
   * this; an owner-configured proxy keeps first-choice semantics.
   */
  fallbackOnly?: boolean;
}

/**
 * Absolute-from-server-root path where the device leaves the handoff for a
 * supervisor-started Source Server, whose environment was fixed at boot and
 * cannot be re-injected without a relaunch.
 */
export const REMOTE_AGENT_NETWORK_HANDOFF_FILE = "remote-agent-network.json";

/** Read the handoff from the remote server's process environment. */
export function resolveRemoteAgentNetworkFromEnv(
  env: Record<string, string | undefined>,
): RemoteAgentNetworkOptions | undefined {
  if (env[ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]?.trim() !== "1") {
    return undefined;
  }
  return {
    httpProxy: env[ZCODE_REMOTE_HTTP_PROXY_ENV_KEY]?.trim() || undefined,
    noProxy: env[ZCODE_REMOTE_NO_PROXY_ENV_KEY]?.trim() || undefined,
    // Read the flag here, not at spawn: the runtime scrub removes the key.
    fallbackOnly: env[ZCODE_HTTP_PROXY_FALLBACK_ONLY_ENV_KEY]?.trim() === "1",
  };
}

/**
 * The exact JSON the device writes; no other field is meaningful to a reader.
 *
 * Compact on purpose: this text is embedded in one single-quoted shell word, and a
 * payload without newlines cannot be broken by anything that splits a remote command
 * on lines. It is also the byte string compared with the remote's current file, so one
 * canonical form means one stable comparison.
 */
export function serializeRemoteAgentNetworkHandoff(
  network: RemoteAgentNetworkOptions,
): string {
  return `${JSON.stringify({
    httpProxy: network.httpProxy ?? null,
    noProxy: network.noProxy ?? null,
    fallbackOnly: network.fallbackOnly === true,
  })}\n`;
}

/**
 * Parse a handoff file. Anything unreadable, malformed or without a proxy is
 * `undefined` — an absent handoff must leave the previous behaviour untouched,
 * never fall back to some other address.
 */
export function parseRemoteAgentNetworkHandoff(
  text: string,
): RemoteAgentNetworkOptions | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const readString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const httpProxy = readString(record.httpProxy);
  if (!httpProxy) return undefined;
  return {
    httpProxy,
    noProxy: readString(record.noProxy),
    fallbackOnly: record.fallbackOnly === true,
  };
}
