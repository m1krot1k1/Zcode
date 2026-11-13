import { useCallback } from "react";
import { createUuid } from "@zcode/shared";
import { getPathLeaf, joinFilePath, toFileUrl } from "@/lib/path.js";
import { shouldOpenWorkflowArtifactInBrowser } from "@/lib/workflowArtifactOpen.js";
import { logger } from "@/logger.js";
import { openPluginUiSidePane } from "@/plugin-ui/index.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import {
  activateAgentWorkbenchSidePane,
  activateDeveloperToolsSidePane,
  activateGitSidePane,
  activateNewTabSidePane,
  activatePluginMarketSidePane,
  closeSidePaneTab,
  findBrowserSidePaneTabByUrl,
  getActiveSidePaneTab,
  openBackgroundBashSidePane,
  openModelTrajectorySidePane,
  openOrActivateBrowserSidePaneByUrl,
  openPlanDetailSidePane,
  openSelectionSideChatPane,
  openSubagentDirectorySidePane,
  openSubagentSessionSidePane,
  openTerminalSidePane,
  openWhiteboardSidePane,
  openWorkflowActorSessionSidePane,
  openWorkflowArtifactSidePane,
  openWorkflowRunDirectorySidePane,
  openWorkflowRunSidePane,
  openWorkflowWorkspaceSidePane,
  replaceWorkflowRunSidePane,
  syncSubagentSessionSidePaneTabs,
  toggleGitSidePane,
  type OpenBackgroundBashSideTabRequest,
  type OpenScopedPlanDetailSideTabRequest,
  type OpenScopedSubagentDirectorySideTabRequest,
  type OpenScopedSubagentSideTabRequest,
  type OpenScopedWorkflowActorSessionSideTabRequest,
  type OpenScopedWorkflowArtifactSideTabRequest,
  type OpenScopedWorkflowRunDirectorySideTabRequest,
  type OpenScopedWorkflowRunSideTabRequest,
  type OpenScopedWorkflowWorkspaceSideTabRequest,
  type OpenSelectionSideChatRequest,
  type SyncSubagentSessionTabsRequest,
  type TreemappingSidePaneTab,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import type { AppPanelsCore } from "./useAppPanelsCore.js";

function createTerminalSidePaneTitle(
  current: WorkspaceSidePaneState | null,
  workspaceAbsPath: string,
): string {
  const baseTitle = getPathLeaf(workspaceAbsPath) || "Terminal";
  const usedTitles = new Set(
    current?.tabs
      .filter((tab) => tab.type === "terminal")
      .map((tab) => tab.title.trim())
      .filter(Boolean) ?? [],
  );

  if (!usedTitles.has(baseTitle)) {
    return baseTitle;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${baseTitle} ${index}`;
    if (!usedTitles.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * 其余 side pane 工具入口：Git、白板、终端、子智能体、工作流与插件 UI。
 *
 * 所有入口都收敛到 commitOpenedSidePaneState，保持 launcher 替换与归属盖戳一致。
 */
export function useAppPanelsToolPanels({
  core,
  workspaceAbsPath,
  workspaceIdentity,
  defaultWhiteboardNamePrefix,
  supportsEmbeddedBrowser,
}: {
  core: AppPanelsCore;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  defaultWhiteboardNamePrefix: string;
  supportsEmbeddedBrowser: boolean;
}) {
  const {
    commitOpenedSidePaneState,
    commitSidePaneState,
    isOfficeMode,
    lastActiveSubagentTabByRootRef,
    latestSidePaneMemoryRef,
    revealSidePaneForCurrentOwner,
    setBrowserNavigationRequest,
    setIsSidePaneCollapsed,
    workspaceRemoteSessionId,
    zcodeAgentService,
  } = core;
  const handleToggleGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const closingActiveGit = getActiveSidePaneTab(current)?.type === "git";
      const next = toggleGitSidePane(current);
      if (!closingActiveGit) {
        revealSidePaneForCurrentOwner();
      }
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 切换右侧面板 mode=${activeTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const next = activateGitSidePane(current);
      // 文件变更查找只需要“确保 Git 面板打开”，不能复用 toggle。
      // 如果当前已经在 Git tab 上，toggle 会把它关掉，导致切到文件变更范围反而看不到内容。
      revealSidePaneForCurrentOwner();
      logger.info(
        `[App] 打开右侧面板 mode=git workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenTreemapping = useCallback(
    (source?: TreemappingSidePaneTab["source"]) => {
      // Treemapping 功能当前需要从侧边栏隐藏。保留回调形状给消息链路兼容，
      // 但不再创建 side pane tab，避免 header 或旧入口绕过菜单隐藏。
      logger.debug(
        `[App] 已隐藏 treemapping 侧边栏入口 workspace=${workspaceAbsPath} source=${source?.kind ?? "current"}`,
      );
    },
    [workspaceAbsPath],
  );

  const handleOpenWhiteboard = useCallback(() => {
    const board = useWhiteboardStore.getState().createBoard({
      defaultNamePrefix: defaultWhiteboardNamePrefix,
      workspaceIdentity,
      workspacePath: workspaceAbsPath,
    });
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openWhiteboardSidePane(current, {
        boardId: board.id,
        title: board.name,
      });
      logger.info(
        `[App] 打开右侧面板 mode=whiteboard workspace=${workspaceAbsPath} board=${board.id} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    defaultWhiteboardNamePrefix,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  const handleOpenNewSidePaneTab = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState(activateNewTabSidePane);
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner]);

  const handleOpenPluginMarket = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState(activatePluginMarketSidePane);
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner]);

  const handleOpenDeveloperTools = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = activateDeveloperToolsSidePane(current);
      logger.info(
        `[App] 打开右侧面板 mode=developer-tools workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  const handleOpenAgentWorkbench = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) =>
      activateAgentWorkbenchSidePane(current, {
        workspaceKey: workspaceIdentity?.trim() || workspaceAbsPath,
        workspacePath: workspaceAbsPath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(workspaceRemoteSessionId ? { remoteSessionId: workspaceRemoteSessionId } : {}),
      }),
    );
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  ]);

  const handleOpenTerminalTab = useCallback(() => {
    if (isOfficeMode) return;
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const title = createTerminalSidePaneTitle(current, workspaceAbsPath);
      const next = openTerminalSidePane(current, {
        title,
        cwd: workspaceAbsPath,
        remoteSessionId: workspaceRemoteSessionId,
      });
      logger.info(
        `[App] 新建右侧终端 tab=${title} workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    isOfficeMode,
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  const handleOpenModelTrajectory = useCallback(
    (params: { taskId: string; title?: string | null }) => {
      if (!params.taskId) {
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openModelTrajectorySidePane(current, params);
        logger.info(
          `[App] 打开右侧面板 mode=model-trajectory workspace=${workspaceAbsPath} taskId=${params.taskId} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenBackgroundBash = useCallback(
    (request: OpenBackgroundBashSideTabRequest) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => openBackgroundBashSidePane(current, request));
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenSubagentSession = useCallback(
    (request: OpenScopedSubagentSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentSessionSidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
          childSessionId: request.childSessionId,
          subagentType: request.subagentType,
          title: request.title,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        logger.debug(
          `[App] 打开子智能体右侧 tab parent=${request.parentSessionId} child=${request.childSessionId} workspace=${workspaceKey}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenSubagentDirectory = useCallback(
    (request: OpenScopedSubagentDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentDirectorySidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleSyncSubagentSessionTabs = useCallback(
    (request: SyncSubagentSessionTabsRequest) => {
      // 分支 edit/retry 的失效 tab 属于投影清理，不进入“最近关闭”。
      commitSidePaneState((current) => syncSubagentSessionSidePaneTabs(current, request));
    },
    [commitSidePaneState],
  );

  const handleOpenSelectionSideChat = useCallback(
    (request: OpenSelectionSideChatRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const staleTab = request.replacesChildSessionId
          ? current?.tabs.find(
              (tab) =>
                tab.type === "selection-side-chat" &&
                tab.workspaceKey === workspaceKey &&
                tab.parentSessionId === request.parentSessionId &&
                tab.childSessionId === request.replacesChildSessionId,
            )
          : undefined;
        const withoutStale = staleTab ? closeSidePaneTab(current, staleTab.id) : current;
        return openSelectionSideChatPane(withoutStale, {
          ...request,
          workspaceKey,
        });
      });
      logger.debug("[App] 打开框选副屏会话", {
        childSessionId: request.childSessionId,
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenPlanDetail = useCallback(
    (request: OpenScopedPlanDetailSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openPlanDetailSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开计划详情右侧 tab", {
        parentSessionId: request.parentSessionId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenPluginUi = useCallback(
    (request: OpenPluginUiSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openPluginUiSidePane(current, { ...request, workspaceKey }),
      );
      logger.debug("[App] 打开插件 UI 右侧 tab", {
        parentSessionId: request.parentSessionId,
        toolCallId: request.toolCallId,
        pluginId: request.pluginId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  const handleOpenWorkflowRun = useCallback(
    (request: OpenScopedWorkflowRunSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      // 「配置」之后的原地替换不是一次打开：收起的侧栏保持收起。
      const replaceRunId = request.replaceRunId;
      if (replaceRunId === undefined) setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        replaceRunId === undefined
          ? openWorkflowRunSidePane(current, { ...request, workspaceKey })
          : replaceWorkflowRunSidePane(current, { ...request, workspaceKey, replaceRunId }),
      );
      logger.debug("[App] 打开工作流运行详情右侧 tab", {
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowRunDirectory = useCallback(
    (request: OpenScopedWorkflowRunDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowRunDirectorySidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流运行目录右侧 tab", {
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenScopedWorkflowActorSessionSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowActorSessionSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流 actor 会话右侧 tab", {
        actorSessionId: request.actorSessionId,
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenScopedWorkflowWorkspaceSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowWorkspaceSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流工作区右侧 tab", {
        parentSessionId: request.parentSessionId,
        phaseId: request.phaseId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  /**
   * 按 URL 复用的 browser tab（html 产物直开的落点）。
   *
   * 与 `handleOpenBrowserUrl` 有三条区别：
   * ① 落点按 URL 认领而不是每次新开；② 命中已有 tab 时**仍然**发一次导航请求 —— webview
   * 停在旧字节上，`initialUrl` 又没变，挂载时那次导航不会再跑
   * （UnifiedBrowserView 的 `lastAppliedInitialUrlRef` 按 URL 去重），v2 就永远显示不出来；
   * ③ 归属由调用方给定，且**恒激活**——这条路径只由用户点击产物触发，没有
   * `isCurrentOwner` 那种后台挂载的情形（详见下面 ownerTaskId 处的注释）。
   */
  const openFileUrlInBrowserSidePane = useCallback(
    (params: { url: string; ownerTaskId: string; workspaceKey: string }) => {
      const state = latestSidePaneMemoryRef.current.sidePaneState;
      const existing = findBrowserSidePaneTabByUrl(state, {
        initialUrl: params.url,
        ownerTaskId: params.ownerTaskId,
        workspaceKey: params.workspaceKey,
      });
      const targetTabId = existing?.id ?? `browser:${createUuid()}`;
      setBrowserNavigationRequest({ id: createUuid(), targetTabId, url: params.url });
      // 与产物 tab 一样只置当前折叠态，不落盘偏好：归属写的是 params.ownerTaskId，
      // 而 revealSidePaneForCurrentOwner 会把 false 记在**当前** owner 名下——中枢那条
      // 路径上两者还不是同一个人。
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openOrActivateBrowserSidePaneByUrl(current, {
          initialUrl: params.url,
          tabId: targetTabId,
          // 归属显式冻结，不靠 stampSidePaneTabsOwnership 盖当前 owner：中枢的产物 chip
          // 先 handleSelectTaskInChat 再 handleOpenWorkflowArtifact，同一个同步块里
          // sidePaneOwnerIdRef 还停在上一条会话上。browser tab 的可见性按 ownerTaskId 收窄
          // （isSidePaneTabVisibleInScope 的默认分支），盖错了这个 tab 切换落定后就再也看不见。
          // 产物 tab 不怕这一手，是因为它按 parentSessionId 收窄。
          ownerTaskId: params.ownerTaskId,
          workspaceKey: params.workspaceKey,
        }),
      );
      return targetTabId;
    },
    [commitOpenedSidePaneState],
  );

  /**
   * 产物点击的**唯一**落点裁决处：html 且开得起内嵌浏览器就直接开页面，其余一律开产物 tab。
   *
   * 直开缺的那一段是 `sourcePath`：run 侧板带得到（它已经合过 journal），药丸摘要刻意不带
   * （状态帧体积，见 `workflowRunArtifactSummarySchema`）。缺席时这里补查一次 journal。
   * 查询失败、老 CLI 没有这条查询、产物根本没有出处，全部退回产物 tab —— 点击绝不落空。
   */
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenScopedWorkflowArtifactSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const openArtifactTab = () => {
        setIsSidePaneCollapsed(false);
        commitOpenedSidePaneState((current) =>
          openWorkflowArtifactSidePane(current, {
            ...request,
            workspaceKey,
          }),
        );
        logger.debug("[App] 打开工作流产物右侧 tab", {
          artifactId: request.artifactId,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          workspaceKey,
        });
      };

      if (
        !shouldOpenWorkflowArtifactInBrowser({
          contentType: request.contentType,
          supportsEmbeddedBrowser,
          workspaceIdentity: request.workspaceIdentity,
          remoteSessionId: request.remoteSessionId,
        })
      ) {
        openArtifactTab();
        return;
      }

      const openInBrowser = (sourcePath: string) => {
        // 工作区相对的 sourcePath 拼上 workspacePath 才是本机真实位置；与产物卡上
        // 「在浏览器中打开」走同一条路径（WorkflowArtifactSidePane 的 localSourcePath）。
        const url = toFileUrl(joinFilePath(request.workspacePath, sourcePath));
        const tabId = openFileUrlInBrowserSidePane({
          url,
          ownerTaskId: request.parentSessionId,
          workspaceKey,
        });
        logger.debug("[App] html 产物直接打开浏览器 tab", {
          artifactId: request.artifactId,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          tabId,
          workspaceKey,
        });
      };

      const knownSourcePath = request.sourcePath?.trim();
      if (knownSourcePath) {
        openInBrowser(knownSourcePath);
        return;
      }

      void (async () => {
        try {
          // 判据已经保证是本地 workspace（无 workspaceIdentity / remoteSessionId），
          // 这里只带 workspacePath。
          const result = await zcodeAgentService.conversationWorkflowRunArtifactsV4({
            workspacePath: request.workspacePath,
            sessionId: request.parentSessionId,
            runId: request.runId,
          });
          const sourcePath = result.artifacts
            .find((artifact) => artifact.id === request.artifactId)
            ?.sourcePath?.trim();
          if (!sourcePath) {
            logger.debug("[App] html 产物没有工作区出处，退回产物 tab", {
              artifactId: request.artifactId,
              runId: request.runId,
            });
            openArtifactTab();
            return;
          }
          openInBrowser(sourcePath);
        } catch (error) {
          logger.warn("[App] 查产物出处失败，退回产物 tab", {
            artifactId: request.artifactId,
            error: error instanceof Error ? error.message : String(error),
            runId: request.runId,
          });
          openArtifactTab();
        }
      })();
    },
    [
      commitOpenedSidePaneState,
      openFileUrlInBrowserSidePane,
      supportsEmbeddedBrowser,
      zcodeAgentService,
    ],
  );
  return {
    handleOpenAgentWorkbench,
    handleOpenBackgroundBash,
    handleOpenDeveloperTools,
    handleOpenGit,
    handleOpenModelTrajectory,
    handleOpenNewSidePaneTab,
    handleOpenPlanDetail,
    handleOpenPluginMarket,
    handleOpenPluginUi,
    handleOpenSelectionSideChat,
    handleOpenSubagentDirectory,
    handleOpenSubagentSession,
    handleOpenTerminalTab,
    handleOpenTreemapping,
    handleOpenWhiteboard,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowArtifact,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowWorkspace,
    handleSyncSubagentSessionTabs,
    handleToggleGit,
  };
}
