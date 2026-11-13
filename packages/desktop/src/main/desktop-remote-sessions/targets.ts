import type { RemoteTarget } from "@zcode/shared";
import { buildSshRemoteHostKey } from "@zcode/shared";

function normalizeServerRemoteUrlForComparison(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    const normalizedPath = parsed.pathname.replace(/\/+$/g, "");
    parsed.pathname = normalizedPath.endsWith("/ws")
      ? normalizedPath.slice(0, -"/ws".length) || "/"
      : normalizedPath || "/";
    return parsed.toString().replace(/\/$/g, "");
  } catch {
    return url.trim().replace(/\/+$/g, "");
  }
}

export function isSameRemoteTarget(left: RemoteTarget, right: RemoteTarget): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "ssh":
      return (
        right.kind === "ssh" &&
        left.host.trim().toLowerCase() === right.host.trim().toLowerCase() &&
        (left.port ?? 22) === (right.port ?? 22) &&
        left.username.trim() === right.username.trim() &&
        (left.privateKeyPath ?? "") === (right.privateKeyPath ?? "")
      );
    case "wsl":
      return (
        right.kind === "wsl" &&
        (left.distro?.trim() || "default") === (right.distro?.trim() || "default") &&
        (left.user?.trim() ?? "") === (right.user?.trim() ?? "")
      );
    case "docker":
      return right.kind === "docker" && left.container === right.container;
    case "server":
      return (
        right.kind === "server" &&
        normalizeServerRemoteUrlForComparison(left.url) ===
          normalizeServerRemoteUrlForComparison(right.url)
      );
  }
}

export function buildRemoteTargetTelemetryKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${target.distro?.trim() || "default"}\0${target.user?.trim() ?? ""}`;
    case "docker":
      return `docker:${target.container}`;
    case "server":
      return `server:${normalizeServerRemoteUrlForComparison(target.url)}`;
  }
}
