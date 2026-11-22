import type { AppSettings, SSHProfileTarget } from "@zcode/shared";
import { isActiveProfile, newCredentialKey, routeKey } from "./identity.js";
import type {
  LegacySourceWorkspaceEntry,
  NonServerRemoteTarget,
  SourceServerDirectoryContext,
  SourceServerProfileTarget,
} from "./types.js";

/** SSH Profile 上所有可能存在的凭据引用；非 SSH 目标没有凭据。 */
export function sshCredentialKeys(target: SSHProfileTarget): string[] {
  return [target.passwordCredentialKey, target.privateKeyPassphraseCredentialKey].filter(
    (key): key is string => Boolean(key),
  );
}

export async function restoreCredentials(
  context: SourceServerDirectoryContext,
  previous: ReadonlyMap<string, string | null>,
): Promise<void> {
  await Promise.all(
    [...previous].map(async ([key, value]) => {
      if (value === null) await context.options.credentialService.delete(key);
      else await context.options.credentialService.save(key, value);
    }),
  );
}

export async function copyFirstAvailableCredential(
  context: SourceServerDirectoryContext,
  sourceKeys: readonly string[],
  destinationKey: string,
  previousCredentials?: Map<string, string | null>,
): Promise<boolean> {
  for (const sourceKey of sourceKeys) {
    const value = await context.options.credentialService.load(sourceKey);
    if (value === null) continue;
    // Bug 原因：旧迁移只看最新 workspace 的 key，源值为空时仍生成新的 Profile ref。
    // 同 route 按 lastOpenedAt 顺序寻找首个真实值，且只有复制成功才允许调用方写引用。
    if (previousCredentials && !previousCredentials.has(destinationKey)) {
      previousCredentials.set(
        destinationKey,
        await context.options.credentialService.load(destinationKey),
      );
    }
    await context.options.credentialService.save(destinationKey, value);
    return true;
  }
  return false;
}

export async function persistProfileCredentials(
  context: SourceServerDirectoryContext,
  profileId: string,
  target: NonServerRemoteTarget,
  profileTarget: SourceServerProfileTarget,
): Promise<{
  target: SourceServerProfileTarget;
  rollback: () => Promise<void>;
}> {
  if (target.kind !== "ssh" || profileTarget.kind !== "ssh") {
    return { target: profileTarget, rollback: async () => undefined };
  }
  const passwordCredentialKey = target.password?.length
    ? (profileTarget.passwordCredentialKey ?? newCredentialKey(profileId, "password"))
    : profileTarget.passwordCredentialKey;
  const privateKeyPassphraseCredentialKey = target.privateKeyPassphrase?.length
    ? (profileTarget.privateKeyPassphraseCredentialKey ??
      newCredentialKey(profileId, "private-key-passphrase"))
    : profileTarget.privateKeyPassphraseCredentialKey;
  const writes = [
    ...(target.password?.length && passwordCredentialKey
      ? [{ key: passwordCredentialKey, value: target.password }]
      : []),
    ...(target.privateKeyPassphrase?.length && privateKeyPassphraseCredentialKey
      ? [
          {
            key: privateKeyPassphraseCredentialKey,
            value: target.privateKeyPassphrase,
          },
        ]
      : []),
  ];
  const previous = new Map<string, string | null>();
  try {
    for (const write of writes) {
      previous.set(write.key, await context.options.credentialService.load(write.key));
      await context.options.credentialService.save(write.key, write.value);
    }
  } catch (error) {
    await restoreCredentials(context, previous);
    throw error;
  }
  const nextTarget: SSHProfileTarget = {
    ...profileTarget,
    ...(passwordCredentialKey ? { passwordCredentialKey } : {}),
    ...(privateKeyPassphraseCredentialKey ? { privateKeyPassphraseCredentialKey } : {}),
  };
  const changed =
    nextTarget.passwordCredentialKey !== profileTarget.passwordCredentialKey ||
    nextTarget.privateKeyPassphraseCredentialKey !==
      profileTarget.privateKeyPassphraseCredentialKey;
  return {
    target: changed ? nextTarget : profileTarget,
    rollback: async () => await restoreCredentials(context, previous),
  };
}

export async function migrateProfileTarget(
  context: SourceServerDirectoryContext,
  profileId: string,
  target: LegacySourceWorkspaceEntry["target"],
  previousCredentials: Map<string, string | null>,
  credentialSources: readonly LegacySourceWorkspaceEntry["target"][] = [target],
): Promise<SourceServerProfileTarget> {
  if (target.kind === "ssh") {
    const nextPasswordCredentialKey = newCredentialKey(profileId, "password");
    const nextPrivateKeyPassphraseCredentialKey = newCredentialKey(
      profileId,
      "private-key-passphrase",
    );
    const passwordCopied = await copyFirstAvailableCredential(
      context,
      credentialSources.flatMap((candidate) =>
        candidate.kind === "ssh" && candidate.passwordCredentialKey
          ? [candidate.passwordCredentialKey]
          : [],
      ),
      nextPasswordCredentialKey,
      previousCredentials,
    );
    // 两类凭据必须顺序等待：并行 Promise 提前 reject 时，另一条迟到 save 可能越过
    // migration rollback 再落盘，重新制造无人引用的 key。
    const privateKeyPassphraseCopied = target.privateKeyPath
      ? await copyFirstAvailableCredential(
          context,
          credentialSources.flatMap((candidate) =>
            candidate.kind === "ssh" &&
            candidate.privateKeyPath &&
            candidate.privateKeyPassphraseCredentialKey
              ? [candidate.privateKeyPassphraseCredentialKey]
              : [],
          ),
          nextPrivateKeyPassphraseCredentialKey,
          previousCredentials,
        )
      : false;
    // Bug 原因：旧 snapshot 可能在密码认证时仍携带私钥口令 ref。
    // 口令只有在 privateKeyPath 存在时才属于当前认证方式，否则迁移后会平白阻断完整密码。
    // 实际私钥认证的 ref 仍保留：若对应值缺失，它必须继续触发交互凭据，不能静默降级。
    return {
      kind: "ssh",
      host: target.host.trim().toLowerCase(),
      port: target.port ?? 22,
      username: target.username.trim(),
      ...(target.sshConfigAlias ? { sshConfigAlias: target.sshConfigAlias } : {}),
      ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
      ...(target.assetInstallMode ? { assetInstallMode: target.assetInstallMode } : {}),
      ...(passwordCopied ? { passwordCredentialKey: nextPasswordCredentialKey } : {}),
      ...(privateKeyPassphraseCopied
        ? {
            privateKeyPassphraseCredentialKey: nextPrivateKeyPassphraseCredentialKey,
          }
        : {}),
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

export async function repairDanglingProfileCredentials(
  context: SourceServerDirectoryContext,
  settings: AppSettings,
): Promise<void> {
  // Bug 原因：旧 Desktop 写回 settings 会剥离 Source Directory，新版再次迁移时可能已把
  // 空 legacy key 变成 canonical Profile ref。migrationVersion=1 也必须按精确 route 幂等
  // 审计并恢复真实 value；禁止根据 alias/hostname 猜测其它连接的 secret。
  const legacyEntriesByRoute = new Map<string, LegacySourceWorkspaceEntry[]>();
  for (const entry of settings.lastWorkspaceSession ?? []) {
    if (entry.kind !== "remote" || entry.target.kind === "server") continue;
    const key = routeKey(entry);
    if (!key) continue;
    const entries = legacyEntriesByRoute.get(key) ?? [];
    entries.push(entry as LegacySourceWorkspaceEntry);
    legacyEntriesByRoute.set(key, entries);
  }
  for (const entries of legacyEntriesByRoute.values()) {
    entries.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
  }

  for (const profile of settings.connectionProfiles ?? []) {
    if (!isActiveProfile(profile) || profile.target.kind !== "ssh") continue;
    const entries = legacyEntriesByRoute.get(
      [
        "ssh",
        profile.target.host.trim().toLowerCase(),
        String(profile.target.port ?? 22),
        profile.target.username.trim(),
        profile.target.privateKeyPath?.trim() ?? "",
      ].join("\u0000"),
    );
    if (!entries?.length) continue;

    const passwordCredentialKey = profile.target.passwordCredentialKey;
    if (
      passwordCredentialKey &&
      (await context.options.credentialService.load(passwordCredentialKey)) === null
    ) {
      await copyFirstAvailableCredential(
        context,
        entries.flatMap((entry) =>
          entry.target.kind === "ssh" && entry.target.passwordCredentialKey
            ? [entry.target.passwordCredentialKey]
            : [],
        ),
        passwordCredentialKey,
      );
    }

    const privateKeyPassphraseCredentialKey =
      profile.target.privateKeyPath && profile.target.privateKeyPassphraseCredentialKey;
    if (
      privateKeyPassphraseCredentialKey &&
      (await context.options.credentialService.load(privateKeyPassphraseCredentialKey)) === null
    ) {
      await copyFirstAvailableCredential(
        context,
        entries.flatMap((entry) =>
          entry.target.kind === "ssh" &&
          entry.target.privateKeyPath &&
          entry.target.privateKeyPassphraseCredentialKey
            ? [entry.target.privateKeyPassphraseCredentialKey]
            : [],
        ),
        privateKeyPassphraseCredentialKey,
      );
    }
  }
}
