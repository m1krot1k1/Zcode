import type { ConnectionProfile } from "@zcode/shared";
import type {
  NonServerRemoteTarget,
  SourceServerDirectoryContext,
  SourceServerProfileTarget,
} from "./types.js";

export function profileTargetFromRemote(target: NonServerRemoteTarget): SourceServerProfileTarget {
  if (target.kind === "ssh") {
    return {
      kind: "ssh",
      host: target.host.trim().toLowerCase(),
      port: target.port ?? 22,
      username: target.username.trim(),
      ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
      ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
      ...(target.assetInstallMode ? { assetInstallMode: target.assetInstallMode } : {}),
    };
  }
  if (target.kind === "wsl") {
    return {
      kind: "wsl",
      ...(target.distro ? { distro: target.distro.trim() } : {}),
      ...(target.user ? { user: target.user.trim() } : {}),
    };
  }
  return { kind: "docker", container: target.container.trim() };
}

export async function resolveSilentTarget(
  context: SourceServerDirectoryContext,
  profile: ConnectionProfile,
): Promise<NonServerRemoteTarget | null> {
  if (profile.target.kind === "wsl" || profile.target.kind === "docker") {
    return profile.target;
  }
  const password = profile.target.passwordCredentialKey
    ? await context.options.credentialService.load(profile.target.passwordCredentialKey)
    : null;
  const privateKeyPassphrase =
    profile.target.privateKeyPath && profile.target.privateKeyPassphraseCredentialKey
      ? await context.options.credentialService.load(
          profile.target.privateKeyPassphraseCredentialKey,
        )
      : null;
  // Bug 原因：legacy workspace 迁移可能留下没有 privateKeyPath 的私钥口令引用。
  // 旧逻辑要求所有引用都有值，把已完整的密码认证也误判为需要交互凭据。
  // SSH 密码和私钥是可替代方案；只要其中一条认证链完整即可静默连接。
  const hasPasswordAuth = Boolean(password);
  const hasPrivateKeyAuth = Boolean(
    profile.target.privateKeyPath &&
    (!profile.target.privateKeyPassphraseCredentialKey || privateKeyPassphrase),
  );
  if (!hasPasswordAuth && !hasPrivateKeyAuth) return null;
  return {
    kind: "ssh",
    host: profile.target.host,
    port: profile.target.port,
    username: profile.target.username,
    ...(profile.target.sshConfigAlias ? { sshConfigAlias: profile.target.sshConfigAlias } : {}),
    ...(hasPrivateKeyAuth && profile.target.privateKeyPath
      ? { privateKeyPath: profile.target.privateKeyPath }
      : {}),
    ...(profile.target.assetInstallMode
      ? { assetInstallMode: profile.target.assetInstallMode }
      : {}),
    ...(password ? { password } : {}),
    ...(hasPrivateKeyAuth && privateKeyPassphrase ? { privateKeyPassphrase } : {}),
  };
}
