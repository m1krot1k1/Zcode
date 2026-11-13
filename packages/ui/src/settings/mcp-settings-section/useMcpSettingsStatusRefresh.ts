/**
 * MCP Settings — status-list refresh orchestration.
 *
 * Owns workspace readiness, request queueing and OAuth status polling so the
 * section component only renders projections of that state.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import type { IMcpSyncService, IPluginManagementService } from "@zcode/services";
import type {
  ZCodeAgentMcpServer,
  ZCodeMcpListMode,
  ZCodeMcpServer,
  ZCodeMcpServerStatusSnapshot,
  ZCodePluginInfo,
} from "@zcode/shared";
import {
  MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS,
  MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS,
  buildMcpOAuthAuthorizationStatusRefreshOptions,
  buildMcpOAuthAuthorizationStatusRefreshServers,
  buildMcpServerStatusListKey,
  buildPendingMcpOAuthAuthorizationRefreshKey,
  buildPluginMcpServerStatusListKey,
  createMcpOAuthAuthorizationStatusRefreshDeadline,
  createMcpStatusListRefreshQueue,
  isMcpOAuthAuthorizationStatusRefreshExpired,
  refreshMcpServerStatusList,
  resolveMcpStatusListRefreshSkipReason,
  transitionMcpAutoStatusListRefreshKey,
  transitionMcpOAuthAuthorizationPendingRefresh,
  type McpOAuthAuthorizationFollowupRefresh,
  type McpOAuthAuthorizationPendingRefresh,
  type McpStatusListRefreshQueue,
  type McpStatusListRefreshTrigger,
} from "./mcpSettingsStatusList.js";

type McpStoreState = ReturnType<typeof useMcpStore.getState>;

export interface RequestMcpServerStatusListOptions {
  mcpServers?: ZCodeAgentMcpServer[];
  mode?: ZCodeMcpListMode;
  trigger?: McpStatusListRefreshTrigger;
}

export interface UseMcpSettingsStatusRefreshInput {
  activeWorkspaceIdentity: string | undefined;
  activeWorkspaceKey: string;
  activeWorkspacePath: string | undefined;
  cacheAuthorityKey: string | undefined;
  currentMcpStoreWorkspaceKey: string;
  ensureLoadedForWorkspace: McpStoreState["ensureLoadedForWorkspace"];
  loadMcpFromUserDirectory: McpStoreState["loadMcpFromUserDirectory"];
  mcpConfigReadyWorkspaceKey: string;
  mcpOAuthAuthorizationFollowupRefresh: McpOAuthAuthorizationFollowupRefresh | null;
  mcpStatusOnlyUnsupported: boolean;
  mcpStatusOnlyUnsupportedRef: { current: boolean };
  mcpSyncService: IMcpSyncService;
  pluginManagementService: IPluginManagementService;
  plugins: ZCodePluginInfo[];
  scopeFilter: "user" | "workspace";
  servers: ZCodeMcpServer[];
  setMcpConfigReadyWorkspaceKey: (workspaceKey: string) => void;
  setMcpOAuthAuthorizationFollowupRefresh: Dispatch<
    SetStateAction<McpOAuthAuthorizationFollowupRefresh | null>
  >;
  setMcpStatusOnlyUnsupported: (unsupported: boolean) => void;
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot>;
}

export function useMcpSettingsStatusRefresh({
  activeWorkspaceIdentity,
  activeWorkspaceKey,
  activeWorkspacePath,
  cacheAuthorityKey,
  currentMcpStoreWorkspaceKey,
  ensureLoadedForWorkspace,
  loadMcpFromUserDirectory,
  mcpConfigReadyWorkspaceKey,
  mcpOAuthAuthorizationFollowupRefresh,
  mcpStatusOnlyUnsupported,
  mcpStatusOnlyUnsupportedRef,
  mcpSyncService,
  pluginManagementService,
  plugins,
  scopeFilter,
  servers,
  setMcpConfigReadyWorkspaceKey,
  setMcpOAuthAuthorizationFollowupRefresh,
  setMcpStatusOnlyUnsupported,
  statusSnapshots,
}: UseMcpSettingsStatusRefreshInput): {
  refreshingStatusList: boolean;
  handleManualRefresh: () => Promise<void>;
  requestMcpServerStatusList: (options?: RequestMcpServerStatusListOptions) => Promise<void>;
} {
  const { intl } = useZCodeIntl();
  const isConfigLoaded = useMcpStore((s) => s.isConfigLoaded);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const beginServerStatusListRefresh = useMcpStore((s) => s.beginServerStatusListRefresh);
  const markServerStatusListRefreshFailed = useMcpStore((s) => s.markServerStatusListRefreshFailed);
  const mergeServerStatusSnapshots = useMcpStore((s) => s.mergeServerStatusSnapshots);

  const serverStatusListKey = useMemo(
    () =>
      [buildMcpServerStatusListKey(servers), buildPluginMcpServerStatusListKey(plugins)]
        .filter(Boolean)
        .join("|"),
    [plugins, servers],
  );
  const statusListRefreshQueueRef = useRef<McpStatusListRefreshQueue | null>(null);
  if (!statusListRefreshQueueRef.current) {
    statusListRefreshQueueRef.current = createMcpStatusListRefreshQueue();
  }
  const latestStatusListRefreshInputRef = useRef<{
    activeWorkspaceIdentity?: string;
    activeWorkspaceKey: string;
    activeWorkspacePath?: string;
    configReadyWorkspaceKey: string;
    storeWorkspaceKey: string;
    isConfigLoaded: boolean;
    serverStatusListKey: string;
  }>({
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath: activeWorkspacePath ?? undefined,
    configReadyWorkspaceKey: mcpConfigReadyWorkspaceKey,
    isConfigLoaded,
    serverStatusListKey,
    storeWorkspaceKey: currentMcpStoreWorkspaceKey,
  });
  latestStatusListRefreshInputRef.current = {
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath: activeWorkspacePath ?? undefined,
    configReadyWorkspaceKey: mcpConfigReadyWorkspaceKey,
    isConfigLoaded,
    serverStatusListKey,
    storeWorkspaceKey: currentMcpStoreWorkspaceKey,
  };
  const autoStatusListRefreshKey = useMemo(() => {
    if (
      !isConfigLoaded ||
      !activeWorkspacePath ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      !serverStatusListKey
    ) {
      return "";
    }
    return [activeWorkspaceIdentity ?? "", activeWorkspacePath, serverStatusListKey].join("\n");
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    isConfigLoaded,
    mcpConfigReadyWorkspaceKey,
    serverStatusListKey,
  ]);
  const pendingMcpOAuthAuthorizationRefreshKey = useMemo(
    () => buildPendingMcpOAuthAuthorizationRefreshKey(servers, statusSnapshots),
    [servers, statusSnapshots],
  );
  const pendingMcpOAuthAuthorizationRefreshServers = useMemo(
    () => buildMcpOAuthAuthorizationStatusRefreshServers(servers, statusSnapshots),
    [servers, statusSnapshots],
  );
  const pendingMcpOAuthAuthorizationRefreshDeadline = useMemo(
    () =>
      activeWorkspaceKey && pendingMcpOAuthAuthorizationRefreshKey
        ? createMcpOAuthAuthorizationStatusRefreshDeadline()
        : 0,
    // status snapshot merge 会重建 pending server 数组并重启轮询 effect；
    // deadline 只能随 workspace/pending 授权窗口变化，否则慢请求会不断续期 5 分钟窗口。
    [activeWorkspaceKey, pendingMcpOAuthAuthorizationRefreshKey],
  );
  const lastPendingMcpOAuthAuthorizationRefreshRef =
    useRef<McpOAuthAuthorizationPendingRefresh | null>(null);
  const lastAutoStatusListRefreshKeyRef = useRef("");
  const requestMcpServerStatusList = useCallback(
    async (options?: RequestMcpServerStatusListOptions) => {
      const trigger = options?.trigger ?? "auto";
      const requestedWorkspaceKey = activeWorkspaceKey;
      const requestedInput = latestStatusListRefreshInputRef.current;
      // 队列 runner 和 in-flight response 都可能跨 workspace 生命周期；
      // active/store/readiness 三个 key 必须仍一致，才能发送请求或合并结果。
      const getCurrentRefreshWorkspaceKey = () => {
        const latest = latestStatusListRefreshInputRef.current;
        return latest.activeWorkspaceKey === latest.storeWorkspaceKey &&
          latest.configReadyWorkspaceKey === latest.activeWorkspaceKey
          ? latest.activeWorkspaceKey
          : "";
      };
      const isRequestCurrent = () => getCurrentRefreshWorkspaceKey() === requestedWorkspaceKey;
      const skipReason = resolveMcpStatusListRefreshSkipReason({
        input: requestedInput,
        requestedWorkspaceKey,
        trigger,
      });
      if (skipReason) {
        // 这些 guard 过去全是静默 return，用户点刷新后既没有请求也没有任何痕迹，
        // 复现时无法从日志判断"没发请求"还是"发了但读到旧状态"。
        if (trigger === "manual") {
          logger.warn("[mcp] manual status refresh skipped", {
            reason: skipReason,
            workspacePath: requestedInput.activeWorkspacePath,
          });
        }
        return;
      }
      if (options?.mode === "status" && mcpStatusOnlyUnsupportedRef.current) {
        return;
      }
      const requestedWorkspacePath = requestedInput.activeWorkspacePath;
      // skipReason 已经覆盖了这个分支，这里只为类型收窄。
      if (!requestedWorkspacePath) return;
      const requestedMcpServers =
        options?.mcpServers ?? useMcpStore.getState().getEnabledMcpServersForZCode("zcode");
      await statusListRefreshQueueRef.current?.request(async () => {
        if (!isRequestCurrent()) {
          return;
        }
        if (options?.mode === "status" && mcpStatusOnlyUnsupportedRef.current) {
          return;
        }

        const outcome = await refreshMcpServerStatusList({
          beginServerStatusListRefresh,
          getCurrentWorkspaceKey: getCurrentRefreshWorkspaceKey,
          markServerStatusListRefreshFailed,
          mergeServerStatusSnapshots,
          // 设置页列表可能来自 `.agents/mcp.json` fallback；agent 侧 mcp/list 自己
          // createConfig 读不到这批 UI-resolved MCP，必须和真实 session 一样显式下发。
          mcpServers: requestedMcpServers,
          mode: options?.mode,
          requestedWorkspaceKey,
          workspaceIdentity: requestedInput.activeWorkspaceIdentity,
          workspacePath: requestedWorkspacePath,
          mcpSyncService,
        }).catch((error) => {
          logger.warn("[mcp] list server statuses failed", {
            error: error instanceof Error ? error.message : String(error),
            workspacePath: requestedWorkspacePath,
          });
          if (trigger === "manual") {
            // Bugfix：手动刷新失败过去只进日志，用户看到的仍是旧状态且毫无提示。
            const message = error instanceof Error ? error.message : String(error);
            toast(intl.formatMessage({ id: "settings.mcp.refreshFailed" }, { error: message }), {
              durationMs: 8_000,
            });
          }
          return "failed" as const;
        });
        if (outcome === "stale-workspace" || !isRequestCurrent()) {
          return;
        }
        if (outcome === "status-mode-unsupported") {
          // 旧 Agent 会稳定拒绝 mode=status；继续 pending 定时器和焦点监听
          // 只会每秒制造同一条协议错误，且不可能推进 OAuth 状态。
          mcpStatusOnlyUnsupportedRef.current = true;
          lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
          setMcpOAuthAuthorizationFollowupRefresh(null);
          setMcpStatusOnlyUnsupported(true);
          logger.warn("[mcp] status-only refresh unsupported; stop OAuth status polling", {
            workspacePath: requestedWorkspacePath,
          });
          toast(intl.formatMessage({ id: "settings.mcp.statusOnlyUnsupported" }), {
            durationMs: 8_000,
          });
        } else if (outcome === "refreshed" && options?.mode !== "status") {
          mcpStatusOnlyUnsupportedRef.current = false;
          setMcpStatusOnlyUnsupported(false);
        }
      });
    },
    [
      activeWorkspaceKey,
      beginServerStatusListRefresh,
      intl,
      markServerStatusListRefreshFailed,
      mergeServerStatusSnapshots,
      mcpSyncService,
    ],
  );

  const [refreshingStatusList, setRefreshingStatusList] = useState(false);
  // 刷新按钮过去点了没有任何可见反馈——请求可能被 guard 静默丢弃，也可能在飞行中。
  // 这里统一：先确保配置已加载，再以 manual 触发发一次请求，期间按钮进入 loading 态。
  const handleManualRefresh = useCallback(async () => {
    if (refreshingStatusList) return;
    setRefreshingStatusList(true);
    try {
      await loadMcpFromUserDirectory(mcpSyncService, activeWorkspaceIdentity, cacheAuthorityKey);
      if (activeWorkspacePath && !mcpConfigReadyWorkspaceKey) {
        const loaded = await ensureLoadedForWorkspace(
          activeWorkspacePath,
          mcpSyncService,
          activeWorkspaceIdentity,
          cacheAuthorityKey,
        );
        const state = useMcpStore.getState();
        const loadedWorkspaceKey = `${state.currentAuthorityKey?.trim() || "workspace"}\0${state.currentWorkspaceIdentity?.trim() || state.currentProjectPath}`;
        if (loaded && loadedWorkspaceKey === activeWorkspaceKey) {
          setMcpConfigReadyWorkspaceKey(activeWorkspaceKey);
          // ref 只在 render 时同步；这里补写一次，否则同一 tick 内紧接着的请求仍会
          // 因为 config-not-ready 被跳过，用户就得再点一次刷新。
          latestStatusListRefreshInputRef.current = {
            ...latestStatusListRefreshInputRef.current,
            configReadyWorkspaceKey: activeWorkspaceKey,
          };
        }
      }
      await requestMcpServerStatusList({ trigger: "manual" });
    } finally {
      setRefreshingStatusList(false);
    }
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    cacheAuthorityKey,
    ensureLoadedForWorkspace,
    loadMcpFromUserDirectory,
    mcpConfigReadyWorkspaceKey,
    refreshingStatusList,
    requestMcpServerStatusList,
    mcpSyncService,
  ]);

  useEffect(() => {
    lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
    setMcpOAuthAuthorizationFollowupRefresh(null);
    mcpStatusOnlyUnsupportedRef.current = false;
    setMcpStatusOnlyUnsupported(false);
  }, [activeWorkspaceKey, mcpSyncService]);

  useEffect(() => {
    let cancelled = false;
    setMcpConfigReadyWorkspaceKey("");
    if (!activeWorkspacePath || !activeWorkspaceKey) {
      return;
    }

    void ensureLoadedForWorkspace(
      activeWorkspacePath,
      mcpSyncService,
      activeWorkspaceIdentity,
      cacheAuthorityKey,
    )
      .then((loaded) => {
        if (cancelled || !loaded) {
          return;
        }
        const state = useMcpStore.getState();
        const loadedWorkspaceKey = `${state.currentAuthorityKey?.trim() || "workspace"}\0${state.currentWorkspaceIdentity?.trim() || state.currentProjectPath}`;
        if (loadedWorkspaceKey === activeWorkspaceKey) {
          setMcpConfigReadyWorkspaceKey(activeWorkspaceKey);
        }
      })
      .catch((error) => {
        logger.warn("[mcp] load workspace config before status refresh failed", {
          error: error instanceof Error ? error.message : String(error),
          workspacePath: activeWorkspacePath,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspaceIdentity,
    activeWorkspaceKey,
    activeWorkspacePath,
    cacheAuthorityKey,
    ensureLoadedForWorkspace,
    mcpSyncService,
  ]);

  useEffect(() => {
    if (!activeWorkspacePath) {
      return;
    }
    void initializePlugins({
      pluginService: pluginManagementService,
      workspaceIdentity: activeWorkspaceIdentity,
      workspacePath: activeWorkspacePath,
      authorityKey: cacheAuthorityKey,
      configScope: scopeFilter,
    });
  }, [
    activeWorkspaceIdentity,
    activeWorkspacePath,
    cacheAuthorityKey,
    initializePlugins,
    scopeFilter,
    pluginManagementService,
  ]);

  useEffect(() => {
    const transition = transitionMcpAutoStatusListRefreshKey(
      lastAutoStatusListRefreshKeyRef.current,
      autoStatusListRefreshKey,
    );
    lastAutoStatusListRefreshKeyRef.current = transition.lastRefreshKey;
    if (!transition.shouldRefresh) {
      return;
    }
    void requestMcpServerStatusList();
  }, [autoStatusListRefreshKey, requestMcpServerStatusList]);

  useEffect(() => {
    if (!activeWorkspaceKey || mcpConfigReadyWorkspaceKey !== activeWorkspaceKey) {
      lastPendingMcpOAuthAuthorizationRefreshRef.current = null;
      setMcpOAuthAuthorizationFollowupRefresh(null);
      return;
    }
    const transition = transitionMcpOAuthAuthorizationPendingRefresh({
      activeWorkspaceKey,
      existingFollowup: mcpOAuthAuthorizationFollowupRefresh,
      mcpServers: pendingMcpOAuthAuthorizationRefreshServers,
      pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
      previous: lastPendingMcpOAuthAuthorizationRefreshRef.current,
    });
    lastPendingMcpOAuthAuthorizationRefreshRef.current = transition.pending;
    // OAuth 回调完成到 MCP 重新连通之间会短暂清掉 authorizationUrl；
    // follow-up 必须携带原 workspaceKey，切换 workspace 时不能复用旧配置。
    setMcpOAuthAuthorizationFollowupRefresh(transition.followup);
  }, [
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpOAuthAuthorizationFollowupRefresh,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
  ]);

  useEffect(() => {
    if (
      !pendingMcpOAuthAuthorizationRefreshKey ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | undefined;
    const deadline = pendingMcpOAuthAuthorizationRefreshDeadline;

    const scheduleNextRefresh = () => {
      if (cancelled || isMcpOAuthAuthorizationStatusRefreshExpired(deadline)) {
        return;
      }
      timeoutId = window.setTimeout(() => {
        if (cancelled || isMcpOAuthAuthorizationStatusRefreshExpired(deadline)) {
          return;
        }
        attempts += 1;
        logger.debug("[mcp] refresh status while OAuth authorization is pending", {
          attempt: attempts,
          deadline,
          pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
          workspacePath: activeWorkspacePath,
        });
        // 修复原因：mcp/list 为了尽快返回 authorizationUrl 会让 agent 在后台等待 OAuth
        // 回调并重连；如果当前设置页不继续拉取 snapshot，UI 会停留在 connecting，直到切 tab 重挂载。
        // OAuth 轮询是高频请求，只能走 status-only，避免 pending 子集触发 replace 语义断开无关 MCP。
        void requestMcpServerStatusList(
          buildMcpOAuthAuthorizationStatusRefreshOptions(
            pendingMcpOAuthAuthorizationRefreshServers,
          ),
        ).finally(scheduleNextRefresh);
      }, MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS);
    };

    scheduleNextRefresh();

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpStatusOnlyUnsupported,
    pendingMcpOAuthAuthorizationRefreshDeadline,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
    requestMcpServerStatusList,
  ]);

  useEffect(() => {
    if (
      !mcpOAuthAuthorizationFollowupRefresh ||
      mcpOAuthAuthorizationFollowupRefresh.workspaceKey !== activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | undefined;

    const scheduleNextRefresh = () => {
      if (cancelled) {
        return;
      }
      if (attempts >= MCP_OAUTH_AUTHORIZATION_FOLLOWUP_REFRESH_ATTEMPTS) {
        setMcpOAuthAuthorizationFollowupRefresh((current) =>
          current?.refreshKey === mcpOAuthAuthorizationFollowupRefresh.refreshKey ? null : current,
        );
        return;
      }
      timeoutId = window.setTimeout(() => {
        attempts += 1;
        logger.debug("[mcp] refresh status after OAuth authorization state changed", {
          attempt: attempts,
          followupKey: mcpOAuthAuthorizationFollowupRefresh.refreshKey,
          workspacePath: activeWorkspacePath,
        });
        void requestMcpServerStatusList(
          buildMcpOAuthAuthorizationStatusRefreshOptions(
            mcpOAuthAuthorizationFollowupRefresh.mcpServers,
          ),
        ).finally(scheduleNextRefresh);
      }, MCP_OAUTH_AUTHORIZATION_STATUS_REFRESH_MS);
    };

    void requestMcpServerStatusList(
      buildMcpOAuthAuthorizationStatusRefreshOptions(
        mcpOAuthAuthorizationFollowupRefresh.mcpServers,
      ),
    ).finally(scheduleNextRefresh);

    return () => {
      cancelled = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpOAuthAuthorizationFollowupRefresh,
    mcpStatusOnlyUnsupported,
    requestMcpServerStatusList,
  ]);

  useEffect(() => {
    if (
      !pendingMcpOAuthAuthorizationRefreshKey ||
      !activeWorkspaceKey ||
      mcpConfigReadyWorkspaceKey !== activeWorkspaceKey ||
      mcpStatusOnlyUnsupported
    ) {
      return;
    }

    const refreshAfterReturnFromBrowser = () => {
      logger.debug("[mcp] refresh status after returning from OAuth browser", {
        pendingKey: pendingMcpOAuthAuthorizationRefreshKey,
        workspacePath: activeWorkspacePath,
      });
      void requestMcpServerStatusList(
        buildMcpOAuthAuthorizationStatusRefreshOptions(pendingMcpOAuthAuthorizationRefreshServers),
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshAfterReturnFromBrowser();
      }
    };

    window.addEventListener("focus", refreshAfterReturnFromBrowser);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", refreshAfterReturnFromBrowser);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    activeWorkspacePath,
    activeWorkspaceKey,
    mcpConfigReadyWorkspaceKey,
    mcpStatusOnlyUnsupported,
    pendingMcpOAuthAuthorizationRefreshKey,
    pendingMcpOAuthAuthorizationRefreshServers,
    requestMcpServerStatusList,
  ]);

  return {
    refreshingStatusList,
    handleManualRefresh,
    requestMcpServerStatusList,
  };
}
