import {
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type AppSettings,
  type ConnectionProfile,
  type DockerProfileTarget,
  type SourceServerDeclaredWorkspaceWire,
  type SourceServerRecord,
  type SSHProfileTarget,
  type WSLProfileTarget,
} from "@zcode/shared";
import type { SourceServerHandshakeRecord } from "./types.js";

export function isActiveProfile(profile: ConnectionProfile): boolean {
  return profile.lifecycleState !== "retired";
}

export function resolveDefaultSourceDisplayName(
  profile: ConnectionProfile,
  handshake: SourceServerHandshakeRecord,
): string {
  // Bug 原因：SSH alias 已持久化在线路 Profile 中，但设备首次握手只用 hostname/osUser 生成名称，
  // 导致用户精心维护的可读 alias 被随机容器 hostname 覆盖。alias 只作为首次展示默认值，
  // 已存在设备仍由调用方优先保留 displayName，且这里不参与任何 identity 计算。
  const sshAlias =
    profile.target.kind === "ssh" ? profile.target.sshConfigAlias?.trim() : undefined;
  return (
    sshAlias ||
    [handshake.hostname, handshake.osUser]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" · ") ||
    handshake.sourceServerId
  );
}

export function routeKey(
  entry: Extract<NonNullable<AppSettings["lastWorkspaceSession"]>[number], { kind: "remote" }>,
): string | null {
  const target = entry.target;
  switch (target.kind) {
    case "ssh":
      return [
        "ssh",
        target.host.trim().toLowerCase(),
        String(target.port ?? 22),
        target.username.trim(),
        target.privateKeyPath?.trim() ?? "",
      ].join("\u0000");
    case "wsl":
      return [
        "wsl",
        target.distro?.trim().toLowerCase() ?? "default",
        target.user?.trim().toLowerCase() ?? "",
      ].join("\u0000");
    case "docker":
      return ["docker", target.container.trim()].join("\u0000");
    case "server":
      return null;
  }
}

export function profileTargetIdentityKey(
  target: SSHProfileTarget | WSLProfileTarget | DockerProfileTarget,
): string {
  switch (target.kind) {
    case "ssh":
      // assetInstallMode、alias 和 resourcePackages 只影响部署/展示，不是连接身份。
      return JSON.stringify({
        kind: "ssh",
        host: target.host.trim().toLowerCase(),
        port: target.port ?? 22,
        username: target.username.trim(),
        privateKeyPath: target.privateKeyPath?.trim() ?? "",
      });
    case "wsl":
      return JSON.stringify({
        kind: "wsl",
        distro: target.distro?.trim() ?? "",
        user: target.user?.trim() ?? "",
      });
    case "docker":
      return JSON.stringify({
        kind: "docker",
        container: target.container.trim(),
      });
  }
}

export function newCredentialKey(
  profileId: string,
  kind: "password" | "private-key-passphrase",
): string {
  return `connection-profile:${profileId}:${kind}`;
}

export function projectDeclaredWorkspaces(
  sourceServerId: string,
  workspaces: readonly SourceServerDeclaredWorkspaceWire[],
  logDebug?: (message: string) => void,
): SourceServerRecord["declaredWorkspaces"] {
  const canonicalServerIdentity = buildServerRemoteWorkspaceIdentity({
    serverId: sourceServerId,
    workspacePath: "/",
  });
  const canonicalServerId = parseRemoteWorkspaceIdentity(canonicalServerIdentity)?.sourceServerId;
  const result: NonNullable<SourceServerRecord["declaredWorkspaces"]> = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    const workspacePath = workspace.path.trim();
    if (!workspacePath) continue;
    const canonicalIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: sourceServerId,
      workspacePath,
    });
    const parsedIdentity = workspace.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(workspace.workspaceIdentity)
      : null;
    const identityIsValid =
      parsedIdentity?.kind === "server" &&
      parsedIdentity.sourceServerId === canonicalServerId &&
      parsedIdentity.workspacePath ===
        parseRemoteWorkspaceIdentity(canonicalIdentity)?.workspacePath;
    // 设备记录必须使用设备级 canonical identity；不信任远端传回的线路级或跨设备 identity。
    const workspaceIdentity =
      identityIsValid && workspace.workspaceIdentity === canonicalIdentity
        ? workspace.workspaceIdentity
        : canonicalIdentity;
    // 合同 §8.1.1：远端 identity 校验不通过被 canonical 覆盖时仅记 debug 日志、不报错。
    if (workspace.workspaceIdentity && workspace.workspaceIdentity !== workspaceIdentity) {
      logDebug?.(
        `Source Server declared workspace identity overridden by canonical: server=${sourceServerId} path=${workspacePath} remote=${workspace.workspaceIdentity}`,
      );
    }
    if (seen.has(workspaceIdentity)) continue;
    seen.add(workspaceIdentity);
    result.push({
      workspacePath,
      workspaceIdentity,
      ...(workspace.label ? { label: workspace.label } : {}),
    });
    if (result.length >= 20) break;
  }
  return result;
}
