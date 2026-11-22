import { isValidWslUser, type ConnectionProfile, type SSHProfileTarget } from "@zcode/shared";
import type { UpdateConnectionProfileInput } from "@zcode/services";
import { persistProfileCredentials, restoreCredentials, sshCredentialKeys } from "./credentials.js";
import { isActiveProfile, newCredentialKey, profileTargetIdentityKey } from "./identity.js";
import { readSnapshot } from "./queries.js";
import { profileTargetFromRemote, resolveSilentTarget } from "./targets.js";
import type { NonServerRemoteTarget, SourceServerDirectoryContext } from "./types.js";

export async function ensureProfile(
  context: SourceServerDirectoryContext,
  target: NonServerRemoteTarget,
  options: { deferCredentials?: boolean } = {},
): Promise<ConnectionProfile> {
  await context.initialize();
  return await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const normalizedTarget = profileTargetFromRemote(target);
    const targetKey = profileTargetIdentityKey(normalizedTarget);
    const existing = (settings.connectionProfiles ?? []).find(
      (profile) =>
        isActiveProfile(profile) &&
        profile.transport === target.kind &&
        profileTargetIdentityKey(profile.target) === targetKey,
    );
    // 连接结果尚未确定时不能覆盖凭据；在线 Source 可能完全跳过本次认证。
    if (existing && options.deferCredentials) return existing;
    if (existing) {
      const credentialMutation = await persistProfileCredentials(
        context,
        existing.profileId,
        target,
        existing.target,
      );
      const nextTarget =
        normalizedTarget.kind === "ssh" && credentialMutation.target.kind === "ssh"
          ? {
              ...normalizedTarget,
              ...(credentialMutation.target.passwordCredentialKey
                ? {
                    passwordCredentialKey: credentialMutation.target.passwordCredentialKey,
                  }
                : {}),
              ...(normalizedTarget.privateKeyPath &&
              credentialMutation.target.privateKeyPassphraseCredentialKey
                ? {
                    privateKeyPassphraseCredentialKey:
                      credentialMutation.target.privateKeyPassphraseCredentialKey,
                  }
                : {}),
            }
          : credentialMutation.target;
      if (JSON.stringify(nextTarget) === JSON.stringify(existing.target)) {
        return existing;
      }
      const updated = {
        ...existing,
        target: nextTarget,
      } as ConnectionProfile;
      try {
        await context.persistSettings({
          connectionProfiles: (settings.connectionProfiles ?? []).map((profile) =>
            profile.profileId === existing.profileId ? updated : profile,
          ),
        });
        return updated;
      } catch (error) {
        await credentialMutation.rollback();
        throw error;
      }
    }
    const profileId = context.createProfileId();
    const credentialMutation = options.deferCredentials
      ? { target: normalizedTarget, rollback: async () => undefined }
      : await persistProfileCredentials(context, profileId, target, normalizedTarget);
    const profile = {
      profileId,
      transport: target.kind,
      target: credentialMutation.target,
      displayName:
        normalizedTarget.kind === "ssh"
          ? (normalizedTarget.sshConfigAlias ?? normalizedTarget.host)
          : normalizedTarget.kind === "wsl"
            ? (normalizedTarget.distro ?? "WSL")
            : normalizedTarget.container,
      createdAt: context.now(),
    } as ConnectionProfile;
    try {
      await context.persistSettings({
        connectionProfiles: [...(settings.connectionProfiles ?? []), profile],
      });
      return profile;
    } catch (error) {
      await credentialMutation.rollback();
      throw error;
    }
  });
}

export async function renameProfile(
  context: SourceServerDirectoryContext,
  profileId: string,
  displayName: string,
): Promise<void> {
  await context.initialize();
  const normalized = displayName.trim();
  if (!normalized) throw new Error("Connection Profile display name is required");
  await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const profiles = [...(settings.connectionProfiles ?? [])];
    const index = profiles.findIndex((profile) => profile.profileId === profileId);
    if (index < 0) throw new Error(`Unknown Connection Profile: ${profileId}`);
    profiles[index] = {
      ...profiles[index]!,
      displayName: normalized,
    } as ConnectionProfile;
    await context.persistSettings({
      connectionProfiles: profiles,
    });
  });
}

export async function updateProfile(
  context: SourceServerDirectoryContext,
  input: UpdateConnectionProfileInput,
): Promise<void> {
  await context.initialize();
  const profileDisplayName = input.profileDisplayName.trim();
  const sourceDisplayName = input.sourceDisplayName?.trim();
  if (!profileDisplayName) {
    throw new Error("Connection Profile display name is required");
  }
  if (input.sourceDisplayName !== undefined && !sourceDisplayName) {
    throw new Error("Source Server display name is required");
  }

  await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const profiles = [...(settings.connectionProfiles ?? [])];
    const profileIndex = profiles.findIndex((profile) => profile.profileId === input.profileId);
    if (profileIndex < 0) {
      throw new Error(`Unknown Connection Profile: ${input.profileId}`);
    }
    const currentProfile = profiles[profileIndex]!;
    if (!isActiveProfile(currentProfile)) {
      throw new Error(`Connection Profile is retired: ${input.profileId}`);
    }
    if (currentProfile.transport !== input.target.kind) {
      throw new Error("Connection Profile transport cannot be changed");
    }

    const normalizedTarget = profileTargetFromRemote(input.target);
    if (
      normalizedTarget.kind === "ssh" &&
      (!normalizedTarget.host ||
        !normalizedTarget.username ||
        normalizedTarget.port === undefined ||
        !Number.isInteger(normalizedTarget.port) ||
        normalizedTarget.port <= 0 ||
        normalizedTarget.port > 65_535)
    ) {
      throw new Error("SSH connection details are invalid");
    }
    if (
      normalizedTarget.kind === "wsl" &&
      normalizedTarget.user &&
      !isValidWslUser(normalizedTarget.user)
    ) {
      throw new Error("WSL user is invalid");
    }
    if (normalizedTarget.kind === "docker" && !normalizedTarget.container) {
      throw new Error("Docker container is required");
    }
    const previousCredentials = new Map<string, string | null>();
    const rememberCredential = async (key: string) => {
      if (previousCredentials.has(key)) return;
      previousCredentials.set(key, await context.options.credentialService.load(key));
    };
    const saveCredential = async (key: string, value: string) => {
      await rememberCredential(key);
      await context.options.credentialService.save(key, value);
    };
    const deleteCredential = async (key?: string) => {
      if (!key) return;
      await rememberCredential(key);
      await context.options.credentialService.delete(key);
    };

    let nextTarget = normalizedTarget;
    try {
      if (
        currentProfile.target.kind === "ssh" &&
        normalizedTarget.kind === "ssh" &&
        input.target.kind === "ssh"
      ) {
        if (!input.sshAuthMethod) {
          throw new Error("SSH authentication method is required");
        }
        if (input.sshAuthMethod === "password") {
          const { privateKeyPath: _privateKeyPath, ...passwordTarget } = normalizedTarget;
          const passwordCredentialKey =
            currentProfile.target.passwordCredentialKey ??
            newCredentialKey(input.profileId, "password");
          const password = input.target.password?.trim();
          const savedPassword = currentProfile.target.passwordCredentialKey
            ? await context.options.credentialService.load(
                currentProfile.target.passwordCredentialKey,
              )
            : null;
          if (!password && !savedPassword) {
            throw new Error("SSH password is required");
          }
          if (password) {
            await saveCredential(passwordCredentialKey, password);
          }
          await deleteCredential(currentProfile.target.privateKeyPassphraseCredentialKey);
          nextTarget = {
            ...passwordTarget,
            passwordCredentialKey,
          } as SSHProfileTarget;
        } else {
          if (!normalizedTarget.privateKeyPath?.trim()) {
            throw new Error("SSH private key path is required");
          }
          await deleteCredential(currentProfile.target.passwordCredentialKey);
          let privateKeyPassphraseCredentialKey: string | undefined;
          const privateKeyPassphrase = input.target.privateKeyPassphrase?.trim();
          if (privateKeyPassphrase) {
            privateKeyPassphraseCredentialKey =
              currentProfile.target.privateKeyPassphraseCredentialKey ??
              newCredentialKey(input.profileId, "private-key-passphrase");
            await saveCredential(privateKeyPassphraseCredentialKey, privateKeyPassphrase);
          } else if (
            currentProfile.target.privateKeyPath === normalizedTarget.privateKeyPath &&
            currentProfile.target.privateKeyPassphraseCredentialKey
          ) {
            privateKeyPassphraseCredentialKey =
              currentProfile.target.privateKeyPassphraseCredentialKey;
          } else {
            await deleteCredential(currentProfile.target.privateKeyPassphraseCredentialKey);
          }
          nextTarget = {
            ...normalizedTarget,
            ...(privateKeyPassphraseCredentialKey ? { privateKeyPassphraseCredentialKey } : {}),
          } as SSHProfileTarget;
        }
      }

      profiles[profileIndex] = {
        ...currentProfile,
        displayName: profileDisplayName,
        target: nextTarget,
        lastConnectError: undefined,
      } as ConnectionProfile;

      let servers = settings.sourceServers;
      if (sourceDisplayName !== undefined) {
        if (!currentProfile.sourceServerId) {
          throw new Error("Unidentified Connection Profile cannot rename a Source Server");
        }
        servers = [...(settings.sourceServers ?? [])];
        const serverIndex = servers.findIndex(
          (server) => server.sourceServerId === currentProfile.sourceServerId,
        );
        if (serverIndex < 0) {
          throw new Error(`Unknown Source Server: ${currentProfile.sourceServerId}`);
        }
        servers[serverIndex] = {
          ...servers[serverIndex]!,
          displayName: sourceDisplayName,
        };
      }

      // 根因：旧管理面只能改线路别名，用户修改地址时只能新建 Profile，进而把同一
      // Source 的 workspace/task 历史割裂。这里原位更新 Profile，并把凭据与 settings
      // 放在同一回滚边界内，确保 profileId/sourceServerId/history 全部保持稳定。
      await context.persistSettings({
        connectionProfiles: profiles,
        ...(servers ? { sourceServers: servers } : {}),
      });
    } catch (error) {
      await restoreCredentials(context, previousCredentials);
      throw error;
    }
  });
}

export async function setPreferredProfile(
  context: SourceServerDirectoryContext,
  sourceServerId: string,
  profileId: string,
): Promise<void> {
  await context.initialize();
  await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const profile = (settings.connectionProfiles ?? []).find(
      (candidate) => candidate.profileId === profileId && isActiveProfile(candidate),
    );
    if (!profile || profile.sourceServerId !== sourceServerId) {
      throw new Error(`Connection Profile ${profileId} does not belong to ${sourceServerId}`);
    }
    const servers = [...(settings.sourceServers ?? [])];
    const index = servers.findIndex((server) => server.sourceServerId === sourceServerId);
    if (index < 0) throw new Error(`Unknown Source Server: ${sourceServerId}`);
    servers[index] = { ...servers[index]!, preferredProfileId: profileId };
    await context.persistSettings({ sourceServers: servers });
  });
}

export async function resolveProfileTarget(
  context: SourceServerDirectoryContext,
  profileOrId: string | ConnectionProfile,
): Promise<NonServerRemoteTarget> {
  // 更新入口传入已核验的同一 Profile，避免凭据异步读取前再次按 ID 改选执行目标。
  const profile =
    typeof profileOrId === "string"
      ? (await readSnapshot(context)).profiles.find(
          (candidate) => candidate.profileId === profileOrId,
        )
      : profileOrId;
  if (!profile) throw new Error(`Unknown Connection Profile: ${profileOrId}`);
  const profileId = profile.profileId;
  if (!isActiveProfile(profile)) throw new Error(`Connection Profile is retired: ${profileId}`);
  const target = await resolveSilentTarget(context, profile);
  if (!target)
    // 普通 Error 丢失“需要人工凭据”的语义，项目入口无法交接向导；沿用公开认证码。
    throw Object.assign(
      new Error(`Connection Profile requires interactive credentials: ${profileId}`),
      { code: "credentials-required" },
    );
  return target;
}

export async function removeProfile(
  context: SourceServerDirectoryContext,
  profileId: string,
): Promise<void> {
  await context.initialize();
  await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const profiles = [...(settings.connectionProfiles ?? [])];
    const profile = profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) return;
    const credentialKeys = profile.target.kind === "ssh" ? sshCredentialKeys(profile.target) : [];
    const previousCredentials = new Map<string, string | null>();
    try {
      for (const key of credentialKeys) {
        previousCredentials.set(key, await context.options.credentialService.load(key));
        await context.options.credentialService.delete(key);
      }
      const remainingProfiles = profiles.filter((candidate) => candidate.profileId !== profileId);
      await context.persistSettings({
        connectionProfiles: remainingProfiles,
        sourceServerWorkspaceHistory: (settings.sourceServerWorkspaceHistory ?? []).filter(
          (entry) => entry.profileId !== profileId,
        ),
        sourceServers: (settings.sourceServers ?? []).map((server) =>
          server.preferredProfileId === profileId
            ? {
                ...server,
                preferredProfileId: remainingProfiles.find(
                  (candidate) =>
                    isActiveProfile(candidate) &&
                    candidate.sourceServerId === server.sourceServerId,
                )?.profileId,
              }
            : server,
        ),
      });
    } catch (error) {
      await restoreCredentials(context, previousCredentials);
      throw error;
    }
  });
}
