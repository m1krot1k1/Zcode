import type { Dispatch, SetStateAction } from "react";
import type { IPlatformService, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { stripRemoteTargetSecrets } from "@zcode/shared";
import type { IServiceAccessor } from "../contract.ts";
import {
  buildWorkspaceSessionKey,
  buildRemoteWorkspaceSessionMutation,
} from "@/lib/remoteWorkspaceHistory.js";
import { isWorkspaceTab, type WindowTabState } from "@/store/tabStore.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  clearRemoteWorkspaceConnectionState,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { reconnectRemoteWorkspaceHistoryEntry } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { shouldKeepRemoteWorkspaceInTabs } from "@/root/remote-workspace-history/reconnectPlanning.js";
import type {
  BoundRemoteWorkspaceScope,
  RemoteWorkspaceTabStoreReader,
} from "@/root/remote-workspace-history/types.js";

interface OpenRemoteWorkspaceFromHistoryParams {
  workspaceKey: string;
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  inflightReconnectWorkspaceKeys: Set<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  bindRemoteWorkspaceScope: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<BoundRemoteWorkspaceScope>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      previousWorkspaceIdentity?: string;
      localWorkspacePath?: string;
      workspacePurpose?: "project" | "conversation";
    },
  ) => void;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  resetLogsForWorkspaceKey: (workspaceKey: string) => void;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
  }) => void;
  createReconnectRequestId?: () => string;
  pendingReconnectRequestIds?: Map<string, string>;
  reconnectImpl?: typeof reconnectRemoteWorkspaceHistoryEntry;
}

export async function openRemoteWorkspaceFromHistoryEntry({
  workspaceKey,
  tabStoreApi,
  getRemoteSessions,
  inflightReconnectWorkspaceKeys,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  connectRemoteWorkspaceTarget,
  resolveRemoteWorkspaceCanonicalPath,
  bindRemoteWorkspaceScope,
  disposeRemoteWorkspaceSession,
  addTab,
  commitRemoteWorkspaceSessionMutation,
  resetLogsForWorkspaceKey,
  createReconnectRequestId,
  pendingReconnectRequestIds,
  reconnectImpl = reconnectRemoteWorkspaceHistoryEntry,
  onWorkspaceActivated,
}: OpenRemoteWorkspaceFromHistoryParams): Promise<void> {
  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    return;
  }

  if (inflightReconnectWorkspaceKeys.has(workspaceKey)) {
    return;
  }

  const existingWorkspaceTab = tabStoreApi
    .getState()
    .tabs.find(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
    );
  if (existingWorkspaceTab?.remoteSessionId) {
    activateTabByPath(existingWorkspaceTab.workspacePath, {
      workspaceIdentity: existingWorkspaceTab.workspaceIdentity,
    });
    return;
  }

  // 选择页远程历史与侧栏重连都属于“恢复已有 remote workspace”语义。
  // 如果这里缺少“仍需保留该 workspace”的二次校验，用户在重连中移除后仍会被成功回调重新加回 tab。
  // 这里复用同一套 shouldKeep 判定，保证两条入口的竞态行为一致。
  resetLogsForWorkspaceKey(workspaceKey);
  inflightReconnectWorkspaceKeys.add(workspaceKey);
  const requestId = createReconnectRequestId?.();
  if (requestId) {
    pendingReconnectRequestIds?.set(workspaceKey, requestId);
  }
  try {
    await reconnectImpl({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      bindRemoteWorkspaceScope,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspacePath,
      bindRemoteWorkspaceIdentity,
      upsertWorkspaceTab: addTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions,
      logger,
      toast,
      shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
        shouldKeepRemoteWorkspaceInTabs({
          tabStoreApi,
          workspacePath,
          workspaceIdentity,
        }),
      onWorkspaceActivated: (target) => {
        logger.debug("[Root] 远程历史 workspace ready，提交 tab 与 draft 激活", target);
        onWorkspaceActivated?.(target);
      },
      options: {
        // 历史入口过去只回填 connected tab，却没有提交 tab activation 和 draft owner，
        // 所以连接成功后右侧仍停留在旧 workspace。共享 helper 只会在 services ready 后执行此提交，
        // 不会提前暴露缺少 remoteSessionId 的 remote-waiting tab。
        activateWorkspaceAfterReconnect: true,
        showErrorToast: true,
        requestId,
      },
    });
  } finally {
    inflightReconnectWorkspaceKeys.delete(workspaceKey);
    if (requestId && pendingReconnectRequestIds?.get(workspaceKey) === requestId) {
      pendingReconnectRequestIds.delete(workspaceKey);
    }
  }
}

export async function selectRemoteWorkspaceProjectFromDialog({
  canUseRemoteWorkspace,
  sessionId,
  path,
  preparedWorkspaceIdentity,
  draftProjectId,
  localWorkspacePath,
  loadingMessage,
  getRemoteWorkspaceSession,
  connectionTarget,
  getWorkspaceTabs,
  restoringWorkspaceTabId,
  resolveRemoteWorkspaceCanonicalPath,
  activateTabByPath,
  handleCancelRemoteProject,
  bindRemoteWorkspaceScope,
  workspacePurpose,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  addTab,
  onWorkspaceActivated,
  isCurrent,
}: {
  canUseRemoteWorkspace: boolean;
  isCurrent?: () => boolean | Promise<boolean>;
  sessionId: string;
  path: string;
  preparedWorkspaceIdentity?: string;
  draftProjectId?: string | null;
  workspacePurpose?: "project" | "conversation";
  localWorkspacePath?: string;
  loadingMessage: string;
  getRemoteWorkspaceSession: (sessionId: string) => RemoteWorkspaceSession | null;
  connectionTarget?: Parameters<IPlatformService["connectRemote"]>[0];
  getWorkspaceTabs: () => WindowTabState[];
  /** 手动向导正在重连的 tab；目标与它同 workspace 时挂回原会话，不新建任务。 */
  restoringWorkspaceTabId?: string;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  handleCancelRemoteProject: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceScope: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<BoundRemoteWorkspaceScope>;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  bindRemoteWorkspacePath: (workspacePath: string, sessionId: string) => void;
  bindRemoteWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      previousWorkspaceIdentity?: string;
      localWorkspacePath?: string;
      workspacePurpose?: "project" | "conversation";
    },
  ) => void;
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
    projectId?: string | null;
  }) => void;
}): Promise<void> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const assertCurrent = async () => {
    // 原项目成员由 Host 持有；异步校验必须等到结果，不能把 Promise 当作有效意图。
    if ((await isCurrent?.()) === false)
      throw Object.assign(new Error("project.navigation-cancelled"), {
        code: "remote-connection-canceled",
      });
  };
  await assertCurrent();
  const remoteSession = getRemoteWorkspaceSession(sessionId);
  if (!remoteSession) {
    throw new Error(loadingMessage);
  }
  const remoteTarget = connectionTarget ?? remoteSession.target;
  if (!remoteTarget) {
    // 手机 web relay 复用 remote session store 只做服务路由，没有本地可重连 target。
    // 远程历史的选目录/持久化流程必须有 target，缺失时直接阻断，避免把无 target 的桥接 session 写进历史。
    throw new Error(`远程 workspace session 缺少连接目标: ${sessionId}`);
  }

  // Bug 原因：项目已经给出 Host 的 cwd/identity，再 realpath 会将路径别名拆成两个 scope。
  // 只有普通目录选择解析用户路径；已准备的目录仍由 Host bind 校验，不能放宽 owner 判断。
  const canonicalPath = preparedWorkspaceIdentity
    ? path
    : await resolveRemoteWorkspaceCanonicalPath(sessionId, path);
  // Bug 原因：Renderer 过去用 transport target 生成 route-derived identity，与 Host 已绑定的
  // remote:server:* stable identity 分裂。先完成 Host bind，再只消费权威 scope。
  // 这次 bind 同时决定手机远控能否桥接：新建连接不带 context 时 main descriptor 停在连接根目录 "/"，
  // bridge 按 tab 的 path/identity 三元比对 descriptor，缺少 bind 会被 REMOTE_WORKSPACE_IDENTITY_MISMATCH
  // 拒绝（3.12.0 曾因此连不上远程项目）。bind 失败由 hook 侧回收 session 并抛回弹窗，不落库、不建 tab。
  await assertCurrent();
  const boundScope = await bindRemoteWorkspaceScope(
    sessionId,
    canonicalPath,
    preparedWorkspaceIdentity,
    workspacePurpose ?? "project",
  );
  await assertCurrent();
  const workspacePath = boundScope.workspacePath;
  const workspaceIdentity = boundScope.workspaceIdentity;
  const existingWorkspaceTab = getWorkspaceTabs().find(
    (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
      isWorkspaceTab(tab) &&
      tab.workspacePath === workspacePath &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceIdentity,
  );
  // Bug 根因：会话横幅“重新连接”→ 向导“重试”成功后走的是普通“打开项目”路径，激活回调
  // 没带 restoreSelection，Root 据此把原会话覆盖成空白草稿（RDUX-09 要求挂回保持原选择）。
  // bcc1ae5fc8 曾在调用点补过这层判断，合并时丢失；现在由本函数按向导持有的 tab 意图统一决定。
  const restoringTab = restoringWorkspaceTabId
    ? getWorkspaceTabs().find((tab) => tab.id === restoringWorkspaceTabId)
    : undefined;
  const activation = {
    workspacePath,
    workspaceIdentity,
    ...(draftProjectId !== undefined ? { projectId: draftProjectId } : {}),
    // 显式项目草稿与恢复旧会话互斥；后台重连中的同一 tab 不能覆盖新建意图。
    ...(draftProjectId === undefined &&
    restoringTab &&
    isWorkspaceTab(restoringTab) &&
    buildWorkspaceSessionKey(restoringTab) ===
      buildWorkspaceSessionKey({ workspacePath, workspaceIdentity })
      ? { restoreSelection: true }
      : {}),
  };

  if (
    existingWorkspaceTab?.remoteSessionId &&
    activateTabByPath(workspacePath, { workspaceIdentity })
  ) {
    if (
      workspacePurpose === "conversation" &&
      existingWorkspaceTab.workspacePurpose !== "conversation"
    ) {
      addTab(workspacePath, {
        remoteSessionId: existingWorkspaceTab.remoteSessionId,
        remoteTarget: stripRemoteTargetSecrets(remoteTarget),
        workspaceIdentity,
        workspacePurpose: "conversation",
      });
    }
    clearRemoteWorkspaceConnectionState(workspaceIdentity);
    if (boundScope.previousWorkspaceIdentity) {
      clearRemoteWorkspaceConnectionState(boundScope.previousWorkspaceIdentity);
    }
    onWorkspaceActivated?.(activation);
    // Bug 原因：项目历史会复用当前 owner；旧分支将它误当临时连接取消，导致任务重开后断线。
    if (existingWorkspaceTab.remoteSessionId !== sessionId)
      await handleCancelRemoteProject(sessionId);
    return;
  }

  // 断连 tab 以前会在 provider/session 绑定完成前先被 activateTabByPath 激活，
  // V4PaneConversationProvider 此时只能得到 remote-waiting，因 rpcReady=false 返回 null，
  // 右侧便会先空白，等后续 addTab 写回 remoteSessionId 后才出现新建对话。
  // 断连 tab 与首次连接统一等到服务绑定完成后再由 addTab 原子激活，避免暴露半连接 workspace。

  // Bug 原因：远程首次选目录时如果先写 lastWorkspaceSession，再执行 Host bind，
  // bind 失败会留下“记录显示已连接但实际 session 已回收”的脏状态。
  // 这里先完成 Host bind 成功，再提交 connected 状态，保证持久化状态与真实连接一致。
  await commitRemoteWorkspaceSessionMutation(
    buildRemoteWorkspaceSessionMutation({
      remoteSessions: getRemoteSessions(),
      workspacePath,
      localWorkspacePath,
      workspaceIdentity,
      target: remoteTarget,
      workspacePurpose: workspacePurpose ?? "project",
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    }),
  );

  await assertCurrent();
  bindRemoteWorkspacePath(workspacePath, sessionId);
  bindRemoteWorkspaceIdentity(workspaceIdentity, sessionId);
  // Bug 原因：旧版 route tab 与新版 stable identity 不相等时，直接 addTab 会制造第二个
  // workspace。Host 返回的 previousWorkspaceIdentity 只用于 TabStore 原地 rekey，保留原 tab。
  addTab(workspacePath, {
    remoteSessionId: sessionId,
    remoteTarget: stripRemoteTargetSecrets(remoteTarget),
    workspaceIdentity,
    ...(boundScope.previousWorkspaceIdentity
      ? { previousWorkspaceIdentity: boundScope.previousWorkspaceIdentity }
      : {}),
    localWorkspacePath,
    workspacePurpose: workspacePurpose ?? "project",
  });
  // Bug 根因：设备重连弹窗直接走 workspace select，不经过侧栏 reconnect wrapper；只写回
  // remoteSessionId 而不清 overlay 会让已恢复的 task 继续显示“远程连接暂不可用”。attachment
  // 已绑定成功后立即按 stable identity 收敛连接事实，legacy rekey 残留也一并清理。
  clearRemoteWorkspaceConnectionState(workspaceIdentity);
  if (boundScope.previousWorkspaceIdentity) {
    clearRemoteWorkspaceConnectionState(boundScope.previousWorkspaceIdentity);
  }
  // 修复原因：旧链路等待无人消费的列表缓存，导致 tab 与草稿 owner 交接分叉。
  // attachment 和 tab 已就绪后立即提交同一 workspaceKey 的草稿，项目树自行读取权威行。
  onWorkspaceActivated?.(activation);
}
