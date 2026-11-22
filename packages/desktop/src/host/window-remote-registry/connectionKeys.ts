import { buildSshRemoteHostKey, stripRemoteTargetSecrets, type RemoteTarget } from "@zcode/shared";
import type { LogicalSession, WindowRemoteLogicalSessionSnapshot } from "./types.js";

export function normalizeWslSegment(value: string | undefined): string {
  return value?.trim() || "<default>";
}

export function normalizeServerConnectionUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/\/+$/u, "");
    url.pathname = path.endsWith("/ws/host")
      ? path.slice(0, -"/ws/host".length) || "/"
      : path.endsWith("/ws")
        ? path.slice(0, -"/ws".length) || "/"
        : path || "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

export function buildConnectionKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${normalizeWslSegment(target.distro)}\0${normalizeWslSegment(target.user)}`;
    case "docker":
      return `docker:${target.container.trim()}`;
    case "server":
      return `server:${target.serverId?.trim() || normalizeServerConnectionUrl(target.url)}`;
  }
}

export function toSessionSnapshot<TServices, TCapabilities>(
  session: LogicalSession<TServices, TCapabilities>,
): WindowRemoteLogicalSessionSnapshot {
  return {
    ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
    remoteSessionId: session.remoteSessionId,
    requestId: session.requestId,
    target: stripRemoteTargetSecrets(session.target),
    ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
    ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    ...(session.workspacePurpose ? { workspacePurpose: session.workspacePurpose } : {}),
    generation: session.generation,
    state: session.state,
    sourceAvailability: session.sourceAvailability,
  };
}
