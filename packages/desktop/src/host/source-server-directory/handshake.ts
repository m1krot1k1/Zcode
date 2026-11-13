import {
  buildServerRemoteWorkspaceIdentity,
  type AppSettings,
  type ConnectionProfile,
  type SourceServerRecord,
} from "@zcode/shared";
import {
  isActiveProfile,
  newCredentialKey,
  projectDeclaredWorkspaces,
  resolveDefaultSourceDisplayName,
} from "./identity.js";
import type {
  SourceServerDirectoryContext,
  SourceServerHandshakeRecord,
  SourceServerHandshakeResult,
} from "./types.js";

export async function recordLastOnline(
  context: SourceServerDirectoryContext,
  sourceServerId: string,
  timestamp: number,
): Promise<void> {
  await context.initialize();
  await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const server = settings.sourceServers?.find((entry) => entry.sourceServerId === sourceServerId);
    // 断线事件可能晚于重连握手或删除；只推进已存在设备的时间，不能倒退或复活记录。
    if (!server || timestamp <= (server.lastOnlineAt ?? 0)) return;
    await context.persistSettings({
      sourceServers: settings.sourceServers!.map((entry) =>
        entry === server ? { ...entry, lastOnlineAt: timestamp } : entry,
      ),
    });
  });
}

export async function recordHandshake(
  context: SourceServerDirectoryContext,
  profileId: string,
  handshake: SourceServerHandshakeRecord,
  options: { confirmIdentityChange?: boolean } = {},
): Promise<SourceServerHandshakeResult> {
  await context.initialize();
  return await context.enqueue(async () => {
    const settings = await context.options.settingService.get();
    const profiles = [...(settings.connectionProfiles ?? [])];
    const profileIndex = profiles.findIndex((profile) => profile.profileId === profileId);
    if (profileIndex < 0) throw new Error(`Unknown Connection Profile: ${profileId}`);
    const connectedAt = handshake.connectedAt ?? context.now();
    const currentProfile = profiles[profileIndex]!;
    if (!isActiveProfile(currentProfile)) {
      throw new Error(`Connection Profile is retired: ${profileId}`);
    }
    const previousSourceServerId = currentProfile.sourceServerId;
    const identityChanged =
      Boolean(previousSourceServerId) && previousSourceServerId !== handshake.sourceServerId;
    if (identityChanged && options.confirmIdentityChange !== true) {
      // Bug 根因：旧实现先改绑 Profile/history，再把 identityChanged 返回给上层，用户确认
      // 已经来不及。pending 阶段必须严格零写入。
      return {
        identityChanged: true,
        migrationFailures: [],
        effectiveProfileId: profileId,
        effectiveProfile: currentProfile,
      };
    }
    if (identityChanged) {
      return await commitIdentityReplacement(context, {
        settings,
        currentProfile,
        handshake,
        connectedAt,
      });
    }
    profiles[profileIndex] = {
      ...currentProfile,
      sourceServerId: handshake.sourceServerId,
      lastConnectedAt: connectedAt,
      lastConnectError: undefined,
      lifecycleState: "active",
    } as ConnectionProfile;

    const servers = [...(settings.sourceServers ?? [])];
    const serverIndex = servers.findIndex(
      (server) => server.sourceServerId === handshake.sourceServerId,
    );
    const defaultDisplayName = resolveDefaultSourceDisplayName(currentProfile, handshake);
    const previousServer = serverIndex >= 0 ? servers[serverIndex] : undefined;
    const nextServer: SourceServerRecord = {
      sourceServerId: handshake.sourceServerId,
      displayName: previousServer?.displayName ?? defaultDisplayName,
      ...(handshake.osUser ? { osUser: handshake.osUser } : {}),
      ...(handshake.hostname ? { hostname: handshake.hostname } : {}),
      lastSeenVersion: handshake.version,
      lastOnlineAt: connectedAt,
      preferredProfileId: previousServer?.preferredProfileId ?? profileId,
      installState: "installed",
      declaredWorkspaces: projectDeclaredWorkspaces(
        handshake.sourceServerId,
        handshake.workspaces ?? [],
        context.options.logDebug,
      ),
    };
    if (serverIndex >= 0) servers[serverIndex] = nextServer;
    else servers.push(nextServer);

    const workspaceHistory = (settings.sourceServerWorkspaceHistory ?? []).map((entry) =>
      entry.profileId === profileId
        ? {
            ...entry,
            sourceServerId: handshake.sourceServerId,
            workspaceIdentity: buildServerRemoteWorkspaceIdentity({
              serverId: handshake.sourceServerId,
              workspacePath: entry.workspacePath,
            }),
          }
        : entry,
    );
    const migrationFailures: string[] = [];
    for (const entry of workspaceHistory) {
      if (
        entry.profileId !== profileId ||
        !entry.legacyWorkspaceIdentity ||
        !entry.workspaceIdentity ||
        entry.legacyWorkspaceIdentity === entry.workspaceIdentity
      ) {
        continue;
      }
      const report = await context.migrateControllerIdentity({
        oldWorkspaceKey: entry.legacyWorkspaceIdentity,
        newWorkspaceKey: entry.workspaceIdentity,
      });
      if (report.status === "failed") {
        migrationFailures.push(report.error ?? entry.workspacePath);
      }
    }
    await context.persistSettings({
      connectionProfiles: profiles,
      sourceServers: servers,
      sourceServerWorkspaceHistory: workspaceHistory,
    });
    return {
      identityChanged: false,
      migrationFailures,
      effectiveProfileId: profileId,
      effectiveProfile: profiles[profileIndex]!,
    };
  });
}

async function commitIdentityReplacement(
  context: SourceServerDirectoryContext,
  input: {
    settings: AppSettings;
    currentProfile: ConnectionProfile;
    handshake: SourceServerHandshakeRecord;
    connectedAt: number;
  },
): Promise<SourceServerHandshakeResult> {
  const previousSourceServerId = input.currentProfile.sourceServerId!;
  const newProfileId = context.createProfileId();
  if (newProfileId === input.currentProfile.profileId) {
    throw new Error("Identity replacement requires a new Connection Profile id");
  }
  const createdCredentialKeys: string[] = [];
  let target = input.currentProfile.target;
  try {
    if (input.currentProfile.target.kind === "ssh") {
      const password = input.currentProfile.target.passwordCredentialKey
        ? await context.options.credentialService.load(
            input.currentProfile.target.passwordCredentialKey,
          )
        : null;
      const passphrase = input.currentProfile.target.privateKeyPassphraseCredentialKey
        ? await context.options.credentialService.load(
            input.currentProfile.target.privateKeyPassphraseCredentialKey,
          )
        : null;
      const passwordCredentialKey =
        password === null ? undefined : newCredentialKey(newProfileId, "password");
      const privateKeyPassphraseCredentialKey =
        passphrase === null ? undefined : newCredentialKey(newProfileId, "private-key-passphrase");
      if (passwordCredentialKey) {
        createdCredentialKeys.push(passwordCredentialKey);
        await context.options.credentialService.save(passwordCredentialKey, password!);
      }
      if (privateKeyPassphraseCredentialKey) {
        createdCredentialKeys.push(privateKeyPassphraseCredentialKey);
        await context.options.credentialService.save(
          privateKeyPassphraseCredentialKey,
          passphrase!,
        );
      }
      target = {
        ...input.currentProfile.target,
        passwordCredentialKey,
        privateKeyPassphraseCredentialKey,
      };
    }

    const retiredProfile: ConnectionProfile = {
      ...input.currentProfile,
      lifecycleState: "retired",
      retiredReason: "source-reinstalled",
      retiredAt: input.connectedAt,
    };
    const newProfile: ConnectionProfile = {
      ...input.currentProfile,
      profileId: newProfileId,
      sourceServerId: input.handshake.sourceServerId,
      target,
      lifecycleState: "active",
      retiredReason: undefined,
      retiredAt: undefined,
      lastConnectedAt: input.connectedAt,
      lastConnectError: undefined,
      createdAt: input.connectedAt,
    } as ConnectionProfile;
    const profiles = (input.settings.connectionProfiles ?? []).map((profile) =>
      profile.profileId === input.currentProfile.profileId ? retiredProfile : profile,
    );
    profiles.push(newProfile);
    const defaultDisplayName = resolveDefaultSourceDisplayName(newProfile, input.handshake);
    const servers = [...(input.settings.sourceServers ?? [])];
    const oldServerIndex = servers.findIndex(
      (server) => server.sourceServerId === previousSourceServerId,
    );
    if (oldServerIndex >= 0) {
      const oldServer = servers[oldServerIndex]!;
      servers[oldServerIndex] = {
        ...oldServer,
        installState: "uninstalled",
        preferredProfileId: profiles.find(
          (profile) =>
            isActiveProfile(profile) && profile.sourceServerId === previousSourceServerId,
        )?.profileId,
      };
    }
    const newServerIndex = servers.findIndex(
      (server) => server.sourceServerId === input.handshake.sourceServerId,
    );
    const existingNewServer = newServerIndex >= 0 ? servers[newServerIndex] : undefined;
    const newServer: SourceServerRecord = {
      sourceServerId: input.handshake.sourceServerId,
      displayName: existingNewServer?.displayName ?? defaultDisplayName,
      ...(input.handshake.osUser ? { osUser: input.handshake.osUser } : {}),
      ...(input.handshake.hostname ? { hostname: input.handshake.hostname } : {}),
      lastSeenVersion: input.handshake.version,
      lastOnlineAt: input.connectedAt,
      preferredProfileId: newProfileId,
      installState: "installed",
      declaredWorkspaces: projectDeclaredWorkspaces(
        input.handshake.sourceServerId,
        input.handshake.workspaces ?? [],
        context.options.logDebug,
      ),
    };
    if (newServerIndex >= 0) servers[newServerIndex] = newServer;
    else servers.push(newServer);
    await context.persistSettings({
      connectionProfiles: profiles,
      sourceServers: servers,
      // 旧 history 保持旧 Source/Profile 身份，不允许随新安装静默改写。
      sourceServerWorkspaceHistory: input.settings.sourceServerWorkspaceHistory ?? [],
    });
    return {
      identityChanged: true,
      migrationFailures: [],
      effectiveProfileId: newProfileId,
      effectiveProfile: newProfile,
    };
  } catch (error) {
    await Promise.all(
      createdCredentialKeys.map(
        async (key) => await context.options.credentialService.delete(key).catch(() => undefined),
      ),
    );
    throw error;
  }
}
