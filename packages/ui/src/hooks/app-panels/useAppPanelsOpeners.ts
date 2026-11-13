import { useCallback, useEffect } from "react";
import { createUuid } from "@zcode/shared";
import type { EmbeddedBrowserOpenUrlRequest, IPlatformService } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { logger } from "@/logger.js";
import {
  readTaskSidePaneMemoryState,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import {
  BROWSER_USE_OPERATION_INDICATOR_DURATION_MS,
  applyBrowserTabResidencyEvent,
  applyBrowserUseSidePaneEvent,
  applyBrowserUseSidePaneVisibilityEvent,
  closeSidePaneTab,
  closeSidePaneTabForScope,
  getActiveSidePaneTab,
  markBrowserUseSidePaneTabOperation,
  openBrowserPermissionsSidePane,
  openBrowserSidePane,
  openCodeViewerSidePane,
  openCodeViewerSidePanes,
  openOrActivateBrowserSidePaneByUrl,
  sidePaneOwnerKey,
  toggleBrowserSidePane,
  type WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import type { AppPanelsCore } from "./useAppPanelsCore.js";
import type { AppPanelsPlatform } from "./types.js";

function isAgentOpenedBrowserPopup(payload: EmbeddedBrowserOpenUrlRequest): boolean {
  // human webview 的 owner 使用 unclaimed-iab；legacy-iab 与 iab:<uuid> 都是 Agent
  // 控制上下文。sourceTabId 还可避免把普通外链/终端链接误判为模型 popup。
  return Boolean(payload.sourceTabId && payload.browserId && payload.browserId !== "unclaimed-iab");
}

/**
 * 右侧预览与内嵌浏览器：打开/切换入口，以及 Browser View 的权威事件订阅。
 *
 * 订阅不能以可见性为门槛：设置页覆盖时 App 不卸载，取消订阅会丢 ready 事件，
 * 详见各 effect 内的时序注释。
 */
export function useAppPanelsOpeners({
  core,
  workspaceAbsPath,
  supportsEmbeddedBrowser,
  isDesktop,
  platform,
}: {
  core: AppPanelsCore;
  workspaceAbsPath: string;
  supportsEmbeddedBrowser: boolean;
  isDesktop?: boolean;
  platform?: AppPanelsPlatform;
}) {
  const {
    activeSidePaneMemoryKeyRef,
    activeTabByOwnerRef,
    activeWorkspaceKeyRef,
    commitOpenedSidePaneState,
    commitSidePaneState,
    currentSidePaneScope,
    latestSidePaneMemoryRef,
    revealSidePaneForCurrentOwner,
    setBrowserNavigationRequest,
    setIsSidePaneCollapsed,
    sidePaneOwnerIdRef,
    workspaceRemoteSessionId,
  } = core;
  const handleOpenCodeViewer = useCallback(
    (source: CodeViewerSource) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePane(current, source, sidePaneOwnerIdRef.current);
        const activeTab = getActiveSidePaneTab(next);
        const activePath =
          activeTab?.type === "code-viewer" ? (activeTab.source.path ?? "none") : "none";
        logger.info(
          `[App] 切换右侧面板 mode=code-viewer workspace=${workspaceAbsPath} title=${source.title} path=${activePath} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenCodeViewers = useCallback(
    (sources: readonly CodeViewerSource[]) => {
      if (sources.length === 0) return;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePanes(current, sources, sidePaneOwnerIdRef.current, 0);
        logger.info(
          `[App] 批量打开右侧预览 workspace=${workspaceAbsPath} sources=${sources.length} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  const handleOpenBrowserUrl = useCallback(
    (request: string | EmbeddedBrowserOpenUrlRequest) => {
      const payload: EmbeddedBrowserOpenUrlRequest =
        typeof request === "string" ? { url: request, disposition: "foreground-tab" } : request;
      const sourceWorkspaceKey = payload.workspaceKey ?? activeWorkspaceKeyRef.current;
      const sourceSessionId = payload.sessionId ?? sidePaneOwnerIdRef.current;
      const sourceRemoteSessionId =
        payload.remoteSessionId ?? workspaceRemoteSessionId ?? undefined;
      const isCurrentOwner =
        sourceWorkspaceKey === activeWorkspaceKeyRef.current &&
        (sourceRemoteSessionId ?? "") === (workspaceRemoteSessionId ?? "") &&
        sourceSessionId === sidePaneOwnerIdRef.current;
      if (!supportsEmbeddedBrowser) {
        // Web 端没有内置浏览器面板，这里退回浏览器新标签，至少保证外链是可访问的。
        window.open(payload.url, "_blank", "noopener,noreferrer");
        return;
      }

      // 交互说明：消息区只负责抛出"打开这个 URL"的意图，
      // 真正的 webview 导航、地址校验和面板显隐仍统一收口在浏览器面板一侧处理。
      const isShareUrl = /^https?:\/\/[^/]+\/(?:cn\/)?share\/[^/]+$/u.test(payload.url);
      const targetTabId = `browser:${createUuid()}`;
      // Agent 控制的 guest 触发 popup 时，新的页面仍属于模型操作链路；不能把它
      // 当作人类新开的 Browser tab，继承 setting.json 中保存的自由尺寸/缩放偏好。
      const agentOpened = isAgentOpenedBrowserPopup(payload);
      // webview popup 事件原来只携带 URL，迟到的对话 1 事件会被当前对话 2
      // 的 owner 接管。保留来源 scope，并且只有来源仍是当前 owner 时才抢焦点。
      if (!isShareUrl && isCurrentOwner) {
        setBrowserNavigationRequest({
          id: createUuid(),
          targetTabId,
          url: payload.url,
        });
      }
      if (isCurrentOwner) revealSidePaneForCurrentOwner();
      logger.info(
        `[App] ${isCurrentOwner ? "切换" : "后台挂载"}右侧面板 mode=browser workspace=${sourceWorkspaceKey} sessionId=${sourceSessionId} url=${payload.url}`,
      );
      commitOpenedSidePaneState((current) =>
        isShareUrl
          ? openOrActivateBrowserSidePaneByUrl(current, {
              initialUrl: payload.url,
              ownerTaskId: sourceSessionId,
              workspaceKey: sourceWorkspaceKey,
              ...(sourceRemoteSessionId ? { remoteSessionId: sourceRemoteSessionId } : {}),
            })
          : openBrowserSidePane(current, {
              tabId: targetTabId,
              initialUrl: payload.url,
              ownerTaskId: sourceSessionId,
              workspaceKey: sourceWorkspaceKey,
              // 这两条路径已有 owner，remoteSessionId 不从当前 UI 借用；必须在创建时冻结。
              ...(sourceRemoteSessionId ? { remoteSessionId: sourceRemoteSessionId } : {}),
              activate: isCurrentOwner,
              agentOpened,
            }),
      );
    },
    [
      commitOpenedSidePaneState,
      revealSidePaneForCurrentOwner,
      supportsEmbeddedBrowser,
      workspaceAbsPath,
      workspaceRemoteSessionId,
    ],
  );

  const handleToggleBrowser = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // 能力边界：Web/mobile 当前不支持 Electron webview，不创建 Browser side pane。
      logger.info(`[App] 当前壳层不支持内嵌浏览器，忽略切换请求 workspace=${workspaceAbsPath}`);
      return;
    }

    commitOpenedSidePaneState((current) => {
      const activeTab = getActiveSidePaneTab(current);
      const closingActiveBrowser =
        activeTab?.type === "browser" &&
        sidePaneOwnerKey(activeTab.ownerTaskId) === sidePaneOwnerKey(sidePaneOwnerIdRef.current);
      const next = toggleBrowserSidePane(
        current,
        sidePaneOwnerIdRef.current,
        workspaceRemoteSessionId,
      );
      if (!closingActiveBrowser) {
        revealSidePaneForCurrentOwner();
      }
      const nextActiveTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 切换右侧面板 mode=${nextActiveTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    supportsEmbeddedBrowser,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  const handleOpenBrowserTab = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // 能力边界：Web/mobile 当前不支持 Electron webview，不创建 Browser side pane。
      logger.info(`[App] 当前壳层不支持内嵌浏览器，忽略新建请求 workspace=${workspaceAbsPath}`);
      return;
    }

    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openBrowserSidePane(current);
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 新建右侧浏览器 tab=${activeTab?.id ?? "none"} workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    supportsEmbeddedBrowser,
    workspaceAbsPath,
  ]);

  const handleOpenBrowserPermissionSettings = useCallback(
    (origin: string) => {
      if (!supportsEmbeddedBrowser) return;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openBrowserPermissionsSidePane(current, {
          origin,
          ownerTaskId: sidePaneOwnerIdRef.current,
          workspaceKey: activeWorkspaceKeyRef.current,
        }),
      );
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, supportsEmbeddedBrowser],
  );

  // 下面这组 Browser View 事件都是 main 侧的权威转发，
  // 不能用 isWorkspaceVisible（= !isSettingsTabActive）当订阅门槛。设置页是覆盖层，App 不
  // 卸载但该标志会变 false，effect cleanup 取消订阅后 main 发出的事件直接进黑洞：ready 丢了会让
  // waitForGuest 10 秒超时并把 tab closeTabDurably 删掉，用户退出设置页就看到侧边栏空空如也。
  // 可见性只表达“现在给不给用户看”，不能决定“要不要接收权威事件”；是否抢焦点仍由 shouldReveal
  // 的 scope 匹配决定，因此这里不再依赖 isWorkspaceVisible。
  useEffect(() => {
    if (!supportsEmbeddedBrowser || !isDesktop || !platform?.onOpenBrowserUrl) {
      return;
    }

    return platform.onOpenBrowserUrl((request) => {
      // webview 内 target=_blank/window.open 原来要么被 popup 策略吞掉，
      // 要么交给 Electron 默认创建 BrowserWindow。main 进程已拦截并校验 URL，
      // renderer 这里只把受控请求落到当前可见 workspace 的右侧 Browser tab。
      logger.info(
        `[App] webview 请求打开右侧浏览器 tab workspace=${workspaceAbsPath} url=${request.url} disposition=${request.disposition}`,
      );
      handleOpenBrowserUrl(request);
    });
  }, [handleOpenBrowserUrl, isDesktop, platform, supportsEmbeddedBrowser, workspaceAbsPath]);

  // Browser Use 事件携带创建时冻结的 workspace/session，迟到事件只后台挂载，不能抢当前对话焦点。
  const handleBrowserViewReady = useCallback(
    (
      payload: Parameters<NonNullable<IPlatformService["onBrowserViewReady"]>>[0] extends (
        value: infer Payload,
      ) => void
        ? Payload
        : never,
    ) => {
      if (!isDesktop) return;
      const activeScope = {
        workspaceKey: activeWorkspaceKeyRef.current,
        remoteSessionId: workspaceRemoteSessionId ?? undefined,
        ownerTaskId: sidePaneOwnerIdRef.current,
      };
      const result = applyBrowserUseSidePaneEvent(
        latestSidePaneMemoryRef.current.sidePaneState,
        payload,
        activeScope,
      );
      commitSidePaneState(() => result.state);
      if (result.shouldReveal) revealSidePaneForCurrentOwner();
      logger.info(
        `[App] ${result.shouldReveal ? "展开并激活" : "后台挂载"} browser-use tab workspace=${payload.workspaceKey} sessionId=${payload.sessionId} tabId=${payload.tabId}`,
      );
    },
    [commitSidePaneState, isDesktop, revealSidePaneForCurrentOwner, workspaceRemoteSessionId],
  );

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewReady) return;
    return platform.onBrowserViewReady(handleBrowserViewReady);
  }, [handleBrowserViewReady, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewOperation) return;
    return platform.onBrowserViewOperation((payload) => {
      const operationUntil = Date.now() + BROWSER_USE_OPERATION_INDICATOR_DURATION_MS;
      commitSidePaneState((current) =>
        markBrowserUseSidePaneTabOperation(current, {
          ...payload,
          operationUntil,
        }),
      );
      // browser command 与消息流同数量级，生产环境不得落 info 日志。
      logger.debug("[App] browser-use operation", {
        operationUntil,
        sessionId: payload.sessionId,
        tabId: payload.tabId,
        workspaceKey: payload.workspaceKey,
      });
    });
  }, [commitSidePaneState, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewVisibility) return;
    return platform.onBrowserViewVisibility((payload) => {
      if (payload.visible && payload.tabId) {
        const result = applyBrowserUseSidePaneVisibilityEvent(
          latestSidePaneMemoryRef.current.sidePaneState,
          { ...payload, tabId: payload.tabId },
          {
            workspaceKey: activeWorkspaceKeyRef.current,
            remoteSessionId: workspaceRemoteSessionId ?? undefined,
            ownerTaskId: sidePaneOwnerIdRef.current,
          },
        );
        if (result.didMatch) {
          activeTabByOwnerRef.current.set(
            `${payload.workspaceKey}::${payload.sessionId}`,
            `browser-use:${payload.tabId}`,
          );
        } else {
          // visibility 与 browser command 同数量级，忽略迟到事件只记开发日志，避免生产刷盘。
          logger.debug("[App] 忽略无现存 shell 的 browser-use visibility", {
            sessionId: payload.sessionId,
            tabId: payload.tabId,
            workspaceKey: payload.workspaceKey,
          });
        }
        commitSidePaneState(() => result.state);
        if (result.shouldReveal) revealSidePaneForCurrentOwner();
        return;
      }

      const active = getActiveSidePaneTab(latestSidePaneMemoryRef.current.sidePaneState);
      if (
        active?.type === "browser-use" &&
        active.workspaceKey === payload.workspaceKey &&
        (active.remoteSessionId ?? "") === (payload.remoteSessionId ?? "") &&
        active.sessionId === payload.sessionId &&
        active.browserId === payload.browserId &&
        active.browserGeneration === payload.browserGeneration &&
        (payload.tabId === undefined || active.tabId === payload.tabId)
      ) {
        setIsSidePaneCollapsed(true);
      }
    });
  }, [
    commitSidePaneState,
    isDesktop,
    platform,
    revealSidePaneForCurrentOwner,
    workspaceRemoteSessionId,
  ]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewCloseTab) return;
    return platform.onBrowserViewCloseTab((payload) => {
      const findTargetId = (state: WorkspaceSidePaneState | null) =>
        state?.tabs.find(
          (tab) =>
            (tab.type === "browser-use" && tab.tabId === payload.tabId) ||
            (tab.type === "browser" && tab.id === payload.tabId),
        )?.id ?? null;

      // side pane 状态按 workspace 分开存放，只在「当前活跃 workspace」里查找目标 tab 会漏。
      // Agent 关闭 tab 时用户可能已经切到别的 workspace，通知就被静默丢弃，原 workspace 的持久化状态
      // 仍留着这个 tab —— 切回来后它对应的 main 侧 logical tab 早已不存在，点 × 也关不掉，成为幽灵 tab。
      // 通知带上 owner scope 后，这里按 workspaceKey 路由到对应 workspace 的 memory 直接删除。
      // 只用 workspaceKey 做路由、不再按 session 过滤：main 已判定该 tab 关闭，renderer 侧的壳
      // 无论属于哪个 task 都应当收敛；tabId 本身全局唯一，不存在跨 workspace 误删。
      const targetWorkspaceKey = payload.workspaceKey;
      if (targetWorkspaceKey && targetWorkspaceKey !== activeSidePaneMemoryKeyRef.current) {
        const stored = readTaskSidePaneMemoryState(targetWorkspaceKey);
        const targetId = findTargetId(stored.sidePaneState);
        if (!targetId) return;
        const nextState = closeSidePaneTab(stored.sidePaneState, targetId);
        saveTaskSidePaneMemoryState(targetWorkspaceKey, {
          sidePaneState: nextState,
          isSidePaneCollapsed: stored.isSidePaneCollapsed,
        });
        return;
      }

      commitSidePaneState((current) => {
        const targetId = findTargetId(current);
        if (!targetId) return current;
        return closeSidePaneTabForScope(current, targetId, currentSidePaneScope());
      });
    });
  }, [commitSidePaneState, currentSidePaneScope, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewSuspend) return;
    return platform.onBrowserViewSuspend((payload) => {
      commitSidePaneState((current) => {
        const target = current?.tabs.find(
          (tab) =>
            ((tab.type === "browser-use" && tab.tabId === payload.tabId) ||
              (tab.type === "browser" && tab.id === payload.tabId)) &&
            tab.workspaceKey === payload.workspaceKey &&
            (tab.remoteSessionId ?? "") === (payload.remoteSessionId ?? "") &&
            (tab.type === "browser-use"
              ? tab.sessionId === payload.sessionId
              : (tab.ownerTaskId ?? "unscoped") === payload.sessionId),
        );
        if (!target) return current;
        return applyBrowserTabResidencyEvent(current, payload);
      });
    });
  }, [commitSidePaneState, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewRestore) return;
    return platform.onBrowserViewRestore((payload) => {
      commitSidePaneState((current) => applyBrowserTabResidencyEvent(current, payload));
    });
  }, [commitSidePaneState, isDesktop, platform]);
  return {
    handleOpenBrowserPermissionSettings,
    handleOpenBrowserTab,
    handleOpenBrowserUrl,
    handleOpenCodeViewer,
    handleOpenCodeViewers,
    handleToggleBrowser,
  };
}
