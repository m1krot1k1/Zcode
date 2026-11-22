import { useCallback, useMemo } from "react";
import { toast } from "@/components/ui/toast.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { refreshSharedSkillStoreForWorkspace } from "@/lib/skillStoreRefresh.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import { isPluginUpdatePending, type StorePluginItem } from "@/settings/pluginStoreListing.js";
import {
  buildPluginStoreTryMention,
  buildPluginStoreTryPrompt,
} from "@/settings/pluginStoreTryPrompt.js";
import { usePluginUninstall } from "@/settings/usePluginUninstall.js";
import type { PluginStoreTab } from "@/settings/PluginStoreListView.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type {
  MarketPluginUiController,
  PluginManagementService,
  PluginStoreActionsController,
  PluginStoreIntl,
  PluginStoreManagementState,
  PluginManagementStore,
  PluginStoreOrderState,
  SkillsService,
} from "./types.js";

interface PluginStoreActionsInput {
  store: PluginManagementStore;
  operationService: PluginManagementService;
  intl: PluginStoreIntl;
  locale: string;
  embedded: boolean;
  workspacePath?: string | null;
  normalizedWorkspaceIdentity: string | null;
  skillsService: SkillsService;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  installedPlugins: PluginStoreManagementState["installedPlugins"];
  plugins: PluginStoreManagementState["plugins"];
  activeOperations: PluginStoreManagementState["activeOperations"];
  cancelRequestOperationIds: PluginStoreManagementState["cancelRequestOperationIds"];
  cancellingOperationIds: PluginStoreManagementState["cancellingOperationIds"];
  togglingPluginId: PluginStoreManagementState["togglingPluginId"];
  addMarketplace: PluginStoreManagementState["addMarketplace"];
  installPlugin: PluginStoreManagementState["installPlugin"];
  restoreBuiltin: PluginStoreManagementState["restoreBuiltin"];
  setEnabled: PluginStoreManagementState["setEnabled"];
  updateMarketplace: PluginStoreManagementState["updateMarketplace"];
  updatePlugin: PluginStoreManagementState["updatePlugin"];
  refreshStoreOrder: PluginStoreOrderState["refresh"];
  setRefreshing: (refreshing: boolean) => void;
  setAddMarketplaceError: (error: string | null) => void;
  setSegment: (segment: PluginStoreTab) => void;
  pluginUi: MarketPluginUiController;
  openDetail: (pluginId: string) => void;
}

/**
 * 商店页的全部命令：安装/取消/更新/卸载、刷新目录、添加市场源、试用提示词。
 * 所有写操作走同一份 operationService（带 telemetry），并在能力变化后统一刷新技能与草稿会话。
 */
export function usePluginStoreActions({
  store,
  operationService,
  intl,
  locale,
  embedded,
  workspacePath,
  normalizedWorkspaceIdentity,
  skillsService,
  onCreateTask,
  installedPlugins,
  plugins,
  activeOperations,
  cancelRequestOperationIds,
  cancellingOperationIds,
  togglingPluginId,
  addMarketplace,
  installPlugin,
  restoreBuiltin,
  setEnabled,
  updateMarketplace,
  updatePlugin,
  refreshStoreOrder,
  setRefreshing,
  setAddMarketplaceError,
  setSegment,
  pluginUi,
  openDetail,
}: PluginStoreActionsInput): PluginStoreActionsController {
  // 插件 package 变更（安装 / 卸载 / 更新）后统一收尾：失效草稿会话并刷新技能，
  // 避免会话里残留悬挂或旧版本能力。
  const refreshAfterPluginChange = useCallback(async () => {
    await invalidateDeferredDraftSessionForSkillChange({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity ?? undefined,
      reason: "settings-plugin-enabled",
    });
    await refreshSharedSkillStoreForWorkspace({
      workspacePath,
      workspaceIdentity: normalizedWorkspaceIdentity,
      skillsService,
    });
  }, [normalizedWorkspaceIdentity, skillsService, workspacePath]);

  const uninstall = usePluginUninstall({
    store,
    pluginService: operationService,
    installedPlugins,
    plugins,
    activeOperations,
    onAfterUninstall: async () => {
      await refreshAfterPluginChange();
    },
  });

  const cancelInstall = store((state) => state.cancelInstall);

  const handleCancelInstall = useCallback(
    async (item: StorePluginItem) => {
      if (item.restorable) return;
      const cancelled = await cancelInstall(item.name, item.marketplace, operationService);
      // 取消请求未被 CLI 接受（操作已结束/定位失败）：安装本身仍有真实结果，
      // 这里只补充可理解的反馈，不伪造已取消状态。
      if (!cancelled) {
        toast(intl.formatMessage({ id: "settings.plugins.store.cancelInstallFailed" }), {
          variant: "warning",
        });
      }
    },
    [cancelInstall, intl, operationService],
  );

  const handleInstall = useCallback(
    async (item: StorePluginItem) => {
      const succeeded = item.restorable
        ? await restoreBuiltin(item.id, operationService)
        : await installPlugin(item.name, item.marketplace, operationService, "user");
      // 失败或目标已切换时没有可交付的新能力，不能失效草稿运行时。
      if (!succeeded) return;
      await refreshAfterPluginChange();
    },
    [installPlugin, operationService, refreshAfterPluginChange, restoreBuiltin],
  );

  const handleUpdatePlugin = useCallback(
    async (pluginId: string) => {
      await updatePlugin(pluginId, operationService);
      if (store.getState().error) {
        return;
      }
      // 升级会同时替换 Skill、Command 与 MCP 定义；旧入口只刷新商店列表，
      // 已预热的草稿 session 继续携带旧版本甚至空能力，导致“升级成功”后新会话仍不可用。
      await refreshAfterPluginChange();
    },
    [operationService, refreshAfterPluginChange, updatePlugin],
  );

  const handleCheckForUpdates = useCallback(async () => {
    const succeeded = await updateMarketplace(null, operationService);
    if (!succeeded) {
      const message = store.getState().error;
      if (message) {
        toast(message);
      }
      return;
    }
    const pendingCount = store
      .getState()
      .installedPlugins.filter((item) => isPluginUpdatePending(item.updateStatus)).length;
    if (pendingCount > 0) {
      toast(
        intl.formatMessage(
          { id: "settings.plugins.checkForUpdates.found" },
          { count: String(pendingCount) },
        ),
      );
      return;
    }
    toast(intl.formatMessage({ id: "settings.plugins.checkForUpdates.none" }));
  }, [intl, operationService, store, updateMarketplace]);

  const handleAddMarketplace = useCallback(
    async (source: string) => {
      const succeeded = await addMarketplace(source, operationService);
      // 添加市场源的错误要和提交入口同层展示；否则全局错误条会被 Dialog 遮罩压到下面。
      setAddMarketplaceError(succeeded ? null : (store.getState().error ?? null));
      // 自定义市场不属于公开分段；添加成功后直接切到「个人」，让用户立刻看到刚加的来源。
      if (succeeded) setSegment("personal");
      return succeeded;
    },
    [addMarketplace, operationService, setAddMarketplaceError, setSegment, store],
  );

  const handleUsePrompt = useCallback(
    (item: StorePluginItem, prompt: string) => {
      // 未安装时点提示词先引导安装，不新建会话。
      if (!item.installed) {
        void handleInstall(item);
        return;
      }
      if (!workspacePath || !onCreateTask) {
        return;
      }
      // 原入口绕过 Root 的标准新建任务编排，只写 session store，
      // Settings 遮罩不会退出，composer remount 还可能覆盖预填。现在统一委托 Root，
      // 同时复用 @ Picker 的 canonical Plugin 链接，不新增第二套引用语义。
      onCreateTask({
        initialPrompt: buildPluginStoreTryPrompt({ item, locale, prompt }),
        initialPromptMention: buildPluginStoreTryMention({ item, locale }),
      });
    },
    [handleInstall, locale, onCreateTask, workspacePath],
  );

  const actions: PluginStoreActions = useMemo(
    () => ({
      onOpenDetail: openDetail,
      // 打开 UI 只在会话右侧市场（embedded）提供；主导航市场整行进入详情。
      onOpenUi: embedded
        ? (item) =>
            void pluginUi.open(
              item.id,
              item.info?.enabled
                ? undefined
                : () => setEnabled(item.id, true, operationService, "workspace"),
            )
        : undefined,
      onSetEnabled: (pluginId, enabled) => {
        void setEnabled(pluginId, enabled, operationService, "workspace");
      },
      onInstall: (item) => void handleInstall(item),
      onCancelInstall: (item) => void handleCancelInstall(item),
      onUninstall: uninstall.requestUninstall,
      onUpdate: (pluginId) => void handleUpdatePlugin(pluginId),
      activeOperations,
      cancelRequestOperationIds,
      cancellingOperationIds,
      togglingPluginId,
    }),
    [
      handleInstall,
      handleCancelInstall,
      handleUpdatePlugin,
      openDetail,
      activeOperations,
      cancelRequestOperationIds,
      cancellingOperationIds,
      uninstall.requestUninstall,
      pluginUi,
      operationService,
      setEnabled,
      togglingPluginId,
      embedded,
    ],
  );

  // 顶栏刷新 = 真网络更新：updateMarketplace(null) 重拉全部市场 manifest（含 CDN 与 git 源，
  // 操作内部完成后会重载概览），随后按更新徽标数量给完成提示。只做本地重载时，
  // 用户点了刷新看不到 CDN 新插件（与规格「刷新→update(null)」不符）。
  const handleRefresh = async () => {
    void refreshStoreOrder(true);
    setRefreshing(true);
    try {
      await handleCheckForUpdates();
    } finally {
      setRefreshing(false);
    }
  };

  return {
    actions,
    handleRefresh,
    handleUsePrompt,
    handleAddMarketplace,
    handleUpdatePlugin,
    uninstall,
  };
}
