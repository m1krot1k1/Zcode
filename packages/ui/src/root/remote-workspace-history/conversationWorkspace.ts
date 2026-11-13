import type { AppSettings, IPlatformService, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { logger } from "@/logger.js";
import { buildRemoteTargetFromProfile } from "@/lib/remoteConnectionWizard.js";
import { projectRemoteConversationWorkspacePurpose } from "@/root/remoteWorkspaceSessionPersistence.js";
import { loadConnectionProfileCredentials } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import type { RemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";

export async function openRemoteConversationWorkspace(params: {
  sessionId: string;
  sourceServerId?: string;
  getRemoteWorkspaceSession: (sessionId: string) => RemoteWorkspaceSession | null;
  getSettings: () => Promise<
    Pick<AppSettings, "sourceServerWorkspaceHistory" | "connectionProfiles">
  >;
  loadCredential: (key: string) => Promise<string | null>;
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
  ) => Promise<string>;
  waitForRemoteWorkspaceSessionReady: (sessionId: string) => Promise<void>;
  ensureConversationWorkspace: (sourceServerId: string) => Promise<{ path: string }>;
  selectRemoteWorkspace: (
    sessionId: string,
    workspacePath: string,
    workspacePurpose: "conversation",
  ) => Promise<void>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
}): Promise<void> {
  const initialSession = params.getRemoteWorkspaceSession(params.sessionId);
  let conversationSessionId = params.sessionId;
  let remoteSession = initialSession;
  let resolvedSourceServerId = params.sourceServerId ?? remoteSession?.sourceServerId;
  let ownedConversationSessionId: string | undefined;

  try {
    // 每次新建使用独立 cwd；已绑定的 project / conversation 都必须保留原 logical scope。
    // 本函数创建的新 session
    // 在成功交给 tab 前由本函数独占，任何 ensure/bind/provider 失败都必须在这里回收。
    // Bug 根因：刚连接但尚未 bind 的 session 也携带 bootstrap 根路径；仅凭 workspacePath
    // 会把它误判成 project 并查询不存在的 project history。purpose 才是 logical scope 的权威。
    if (remoteSession?.workspacePath && remoteSession.workspacePurpose) {
      const settings = await params.getSettings();
      const history = (settings.sourceServerWorkspaceHistory ?? []).find(
        (entry) =>
          entry.workspacePath === remoteSession?.workspacePath &&
          entry.workspaceIdentity === remoteSession?.workspaceIdentity,
      );
      const profile = history?.profileId
        ? settings.connectionProfiles?.find(
            (candidate) => candidate.profileId === history.profileId,
          )
        : undefined;
      if (!profile) {
        throw new Error("Remote project connection profile is unavailable");
      }
      const target = buildRemoteTargetFromProfile(profile);
      const credentials = await loadConnectionProfileCredentials({
        profile,
        loadCredential: params.loadCredential,
      });
      const targetWithCredentials =
        target.kind === "ssh" && credentials
          ? {
              ...target,
              ...(credentials.password ? { password: credentials.password } : {}),
              ...(credentials.privateKeyPassphrase
                ? { privateKeyPassphrase: credentials.privateKeyPassphrase }
                : {}),
            }
          : target;
      conversationSessionId = await params.connectRemoteWorkspaceTarget(targetWithCredentials);
      ownedConversationSessionId = conversationSessionId;
      await params.waitForRemoteWorkspaceSessionReady(conversationSessionId);
      remoteSession = params.getRemoteWorkspaceSession(conversationSessionId);
      resolvedSourceServerId = resolvedSourceServerId ?? profile.sourceServerId;
    }
    if (!resolvedSourceServerId) {
      throw new Error("Remote conversation requires an identified Source Server");
    }
    const conversation = await params.ensureConversationWorkspace(resolvedSourceServerId);
    await params.selectRemoteWorkspace(conversationSessionId, conversation.path, "conversation");
    ownedConversationSessionId = undefined;
  } catch (error) {
    if (ownedConversationSessionId) {
      await params
        .disposeRemoteWorkspaceSession(ownedConversationSessionId)
        .catch((disposeError) => {
          logger.warn("[Root] 回收失败的远程 conversation session 失败", {
            sessionId: ownedConversationSessionId,
            error: disposeError,
          });
        });
    }
    throw error;
  }
}

export async function resolveSourceRemoteConversationWorkspaceProjection(params: {
  sourceServerId: string;
  remoteSessions: readonly RemoteWorkspaceSessionEntry[];
  conversationWorkspaceMap: AppSettings["remoteConversationWorkspaceBySourceServerId"];
  ensureConversationWorkspace: (sourceServerId: string) => Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
}): Promise<{
  conversationWorkspaceMap: NonNullable<AppSettings["remoteConversationWorkspaceBySourceServerId"]>;
  remoteSessions: RemoteWorkspaceSessionEntry[];
  updatedEntries: Array<{
    workspacePath: string;
    workspaceIdentity?: string;
  }>;
}> {
  let conversationWorkspaceMap = params.conversationWorkspaceMap ?? {};
  if (!conversationWorkspaceMap[params.sourceServerId]) {
    const conversation = await params.ensureConversationWorkspace(params.sourceServerId);
    conversationWorkspaceMap = {
      ...conversationWorkspaceMap,
      [params.sourceServerId]: {
        workspacePath: conversation.path,
        lastResolvedAt: Date.now(),
      },
    };
  }
  return {
    conversationWorkspaceMap,
    ...projectRemoteConversationWorkspacePurpose(params.remoteSessions, conversationWorkspaceMap),
  };
}
