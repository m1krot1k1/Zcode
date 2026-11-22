import type {
  IPlatformService,
  RemoteSessionClosedEvent,
  RemoteWorkspaceSessionEntry,
  SourceServerConnectionState,
} from "@zcode/shared";
import { buildSshRemoteHostKey, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import { buildWorkspaceSessionKey } from "@/lib/remoteWorkspaceHistory.js";
import { isWorkspaceTab, type WindowTabState, type WorkspaceTabState } from "@/store/tabStore.js";
import {
  getRemoteWorkspaceSession,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import type { ReconnectRemoteWorkspaceOptions } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import type { RemoteWorkspaceTabStoreReader } from "@/root/remote-workspace-history/types.js";

export function updateRemoteWorkspaceRecoveringKeys(
  currentKeys: string[],
  tabs: WorkspaceTabState[],
  recovering: boolean,
): string[] {
  const workspaceKeys = new Set(tabs.map((tab) => buildWorkspaceSessionKey(tab)));
  if (recovering) return [...new Set([...currentKeys, ...workspaceKeys])];
  return currentKeys.filter((key) => !workspaceKeys.has(key));
}

export function shouldAttemptStartupReconnectForSourceState(
  state: SourceServerConnectionState,
): boolean {
  return state === "online";
}

export function shouldAttemptStartupReconnectForTabChange(
  tabs: readonly WindowTabState[],
  previousTabs: readonly WindowTabState[],
): boolean {
  const previousWorkspaceKeys = new Set(
    previousTabs.filter(isWorkspaceTab).map((tab) => buildWorkspaceSessionKey(tab)),
  );
  return tabs.some(
    (tab) =>
      isWorkspaceTab(tab) &&
      !tab.remoteSessionId &&
      parseRemoteWorkspaceIdentity(tab.workspaceIdentity ?? "")?.kind === "server" &&
      !previousWorkspaceKeys.has(buildWorkspaceSessionKey(tab)),
  );
}

/** 无错误的 Source 主动关闭是中性离线，不能制造未知连接失败并阻断原地重连。 */
export function isRemoteWorkspaceCloseFailure(
  event: Pick<
    RemoteSessionClosedEvent,
    "error" | "reasonCode" | "exitCode" | "signal" | "recoveryBudgetExhausted"
  >,
): boolean {
  return Boolean(
    event.error ||
    event.reasonCode ||
    event.recoveryBudgetExhausted ||
    (event.exitCode != null && event.exitCode !== 0) ||
    event.signal,
  );
}

export function resolveRemoteWorkspaceClosedFallback(params: {
  event: Pick<
    RemoteSessionClosedEvent,
    "error" | "recoveryAttempt" | "recoveryBudgetExhausted" | "recoveryLimit"
  >;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  defaultFallback?: string;
}): string {
  if (params.event.recoveryBudgetExhausted) {
    return params.formatMessage(
      { id: "remote.error.recoveryBudgetExhausted" },
      {
        attempt: params.event.recoveryAttempt ?? "?",
        limit: params.event.recoveryLimit ?? "?",
      },
    );
  }
  return (
    params.event.error?.trim() ||
    params.defaultFallback ||
    params.formatMessage({ id: "remote.error.connectionClosed" })
  );
}

export async function bindRemoteWorkspaceContextAndGetSession(params: {
  platform: Pick<IPlatformService, "bindRemoteWorkspaceSessionContext">;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: "project" | "conversation";
}): Promise<RemoteWorkspaceSession> {
  if (!getRemoteWorkspaceSession(params.sessionId)) {
    throw new Error(`远程 workspace session 不存在: ${params.sessionId}`);
  }
  const binding = await params.platform.bindRemoteWorkspaceSessionContext?.({
    remoteSessionId: params.sessionId,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    workspacePurpose: params.workspacePurpose,
  });
  // bind 会让同一 remoteSessionId 的 attachment/services 从 A 换代到 B。
  // bind 前捕获的对象仍指向 A，因此必须在 ready ACK 后按 sessionId 重新读取当前 services。
  const currentSession = getRemoteWorkspaceSession(params.sessionId);
  if (!currentSession) {
    throw new Error(`远程 workspace session 不存在: ${params.sessionId}`);
  }
  const workspaceIdentity =
    binding?.workspaceIdentity?.trim() ||
    currentSession.workspaceIdentity?.trim() ||
    params.workspaceIdentity?.trim();
  if (!workspaceIdentity) {
    throw new Error(`远程 workspace bind 未返回权威 identity: ${params.sessionId}`);
  }
  return {
    ...currentSession,
    ...(binding?.sourceServerId ? { sourceServerId: binding.sourceServerId } : {}),
    workspacePath: binding?.workspacePath ?? currentSession.workspacePath ?? params.workspacePath,
    workspaceIdentity,
    ...(binding?.workspacePurpose
      ? { workspacePurpose: binding.workspacePurpose }
      : params.workspacePurpose
        ? { workspacePurpose: params.workspacePurpose }
        : {}),
    ...(binding?.previousWorkspaceIdentity
      ? { previousWorkspaceIdentity: binding.previousWorkspaceIdentity }
      : {}),
  };
}

export function shouldPersistRemoteWorkspaceFailure(params: {
  pendingReconnectRequestIds: ReadonlyMap<string, string>;
  sessionEntry: RemoteWorkspaceSessionEntry;
  workspaceKey: string;
}): boolean {
  if (params.sessionEntry.target.kind !== "wsl") {
    return true;
  }

  // WSL 偶发断连时，旧 session 的关闭事件可能会晚于手动重连流程。
  // 只要当前 workspace 已经有 pending reconnect，就先别把 failed 写死到 setting，
  // 让最终结果由这次重连成功/失败决定。
  return !params.pendingReconnectRequestIds.has(params.workspaceKey);
}

interface ReconnectRemoteWorkspaceByKeyParams {
  workspaceKey: string;
  canUseRemoteWorkspace: boolean;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  runReconnectRemoteWorkspace: (
    sessionEntry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<void>;
  options?: ReconnectRemoteWorkspaceOptions;
}

export async function reconnectRemoteWorkspaceByKey({
  workspaceKey,
  canUseRemoteWorkspace,
  getRemoteSessions,
  runReconnectRemoteWorkspace,
  options,
}: ReconnectRemoteWorkspaceByKeyParams): Promise<boolean> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    throw new Error(`远程 workspace 不在当前窗口中，无法重连: ${workspaceKey}`);
  }

  await runReconnectRemoteWorkspace(sessionEntry, options);
  return true;
}

export function collectSshReconnectGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  sessions: RemoteWorkspaceSessionEntry[];
  tabs: WindowTabState[];
}): RemoteWorkspaceSessionEntry[] {
  if (params.selected.target.kind !== "ssh") {
    return [params.selected];
  }
  const remoteHostKey = buildSshRemoteHostKey(params.selected.target);
  const disconnectedWorkspaceKeys = new Set(
    params.tabs.flatMap((tab) => {
      if (!isWorkspaceTab(tab) || tab.remoteSessionId) {
        return [];
      }
      return [buildWorkspaceSessionKey(tab)];
    }),
  );
  const reconnectGroup = params.sessions.filter(
    (entry) =>
      entry.target.kind === "ssh" &&
      buildSshRemoteHostKey(entry.target) === remoteHostKey &&
      disconnectedWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
  );
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  if (!reconnectGroup.some((entry) => buildWorkspaceSessionKey(entry) === selectedWorkspaceKey)) {
    return [params.selected];
  }

  // 历史记录顺序不代表本次重连发起者。initiator 必须固定在首位，
  // 否则并发加载凭据时 sibling 可能先创建共享 Host，导致整组误用旧凭据。
  return [
    params.selected,
    ...reconnectGroup.filter((entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey),
  ];
}

export function collectStartupRemoteWorkspaceReconnectGroups(params: {
  sessions: RemoteWorkspaceSessionEntry[];
  manuallyOpeningWorkspaceTabId?: string;
  tabs: WindowTabState[];
  attemptedWorkspaceKeys: ReadonlySet<string>;
  onlineSourceServerIds: ReadonlySet<string>;
  currentRendererDisconnectedSourceServerIds?: ReadonlySet<string>;
  pendingTerminallyDisconnectedSourceServerIds?: ReadonlySet<string>;
}): Array<{ sourceServerId: string; entries: RemoteWorkspaceSessionEntry[] }> {
  // Bug 原因：设备级 7 天门禁已由 Host 启动重连按 lastOnlineAt 执行；这里再按工作区
  // lastOpenedAt 过滤，只会让同一设备下部分 tab 上线、部分停留在未连接。Renderer 挂回
  // 只看 open membership、稳定 identity 与设备 online，不再按工作区年龄过滤。
  const disconnectedWorkspaceKeys = new Set(
    params.tabs.flatMap((tab) => {
      // 手动向导持有该 tab 的绑定意图，Source online 不能同时重复创建 attachment。
      if (tab.id === params.manuallyOpeningWorkspaceTabId) return [];
      if (!isWorkspaceTab(tab) || tab.remoteSessionId || tab.workspacePurpose === "conversation")
        return [];
      return [buildWorkspaceSessionKey(tab)];
    }),
  );
  const resolveEligibleSourceServerId = (session: RemoteWorkspaceSessionEntry): string | null => {
    if (session.workspacePurpose === "conversation") return null;
    const workspaceKey = buildWorkspaceSessionKey(session);
    const parsed = session.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(session.workspaceIdentity)
      : null;
    const sourceServerId = parsed?.kind === "server" ? parsed.sourceServerId : undefined;
    const disconnectedInCurrentRenderer = Boolean(
      sourceServerId && params.currentRendererDisconnectedSourceServerIds?.has(sourceServerId),
    );
    if (
      (sourceServerId &&
        params.pendingTerminallyDisconnectedSourceServerIds?.has(sourceServerId)) ||
      !disconnectedWorkspaceKeys.has(workspaceKey) ||
      (params.attemptedWorkspaceKeys.has(workspaceKey) && !disconnectedInCurrentRenderer)
    ) {
      return null;
    }
    return sourceServerId && params.onlineSourceServerIds.has(sourceServerId)
      ? sourceServerId
      : null;
  };
  const groups = new Map<string, RemoteWorkspaceSessionEntry[]>();
  for (const session of params.sessions) {
    const sourceServerId = resolveEligibleSourceServerId(session);
    if (!sourceServerId) {
      continue;
    }
    // Bug 根因：断开会把保留工作区全部写成 failed，冷启动再以 connected 历史准入会
    // 永久跳过已 online 的设备。Host online 是连接权威，历史结果不再否决 open attachment 恢复。
    const entries = groups.get(sourceServerId) ?? [];
    entries.push(session);
    groups.set(sourceServerId, entries);
  }
  return [...groups].map(([sourceServerId, entries]) => ({
    sourceServerId,
    entries,
  }));
}

export function updateStartupRemoteWorkspaceReconnectAttemptsForSourceState(params: {
  state: {
    state: SourceServerConnectionState;
    sourceServerId?: string;
  };
  onlineSourceServerIds: ReadonlySet<string>;
  sessions: readonly RemoteWorkspaceSessionEntry[];
  attemptedWorkspaceKeys: Set<string>;
}): void {
  const sourceServerId = params.state.sourceServerId;
  if (
    !sourceServerId ||
    params.state.state === "online" ||
    params.onlineSourceServerIds.has(sourceServerId)
  ) {
    return;
  }
  // Bug 原因：启动恢复的去重标记过去覆盖整个 Renderer 生命周期，设备断开后仍未失效。
  // 下一次 Source 虽然恢复为 online，已有 workspace 会继续被当成“尝试过”而跳过重挂。
  // 设备真正离开 online 时只清理该 Source 的标记，保留同一连接周期内的一次性防重语义。
  for (const session of params.sessions) {
    const parsed = session.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(session.workspaceIdentity)
      : null;
    if (parsed?.kind === "server" && parsed.sourceServerId === sourceServerId) {
      params.attemptedWorkspaceKeys.delete(buildWorkspaceSessionKey(session));
    }
  }
}

export function shouldKeepRemoteWorkspaceInTabs(params: {
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  workspacePath: string;
  workspaceIdentity?: string;
}): boolean {
  const reconnectWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  return params.tabStoreApi
    .getState()
    .tabs.some(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) &&
        ((tab.workspaceIdentity?.trim() || tab.workspacePath) === reconnectWorkspaceKey ||
          tab.workspacePath === params.workspacePath),
    );
}
