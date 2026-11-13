/**
 * Plugin 管理列表视图：详情分支、已安装/内置分组、远端同步入口。
 *
 * 数据与动作来自 `usePluginListController`，行渲染与弹窗见同目录子组件。
 */
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { TID_PLUGIN_STORE_BROWSE } from "@zcode/shared/test-ids";
import { Plus, UploadCloud } from "lucide-react";
import { PluginAddMenu } from "@/conversation-workspace-target/PluginAddMenu.js";
import { PluginInstallEmptyState, PluginLoadingState } from "@/settings/PluginInstallEmptyState.js";
import { PluginsSectionEmptyState } from "@/settings/plugins-section/PluginsSectionEmptyState.js";
import { PluginSectionDetail } from "@/settings/plugins-section/PluginSectionDetail.js";
import {
  PluginSettingsRows,
  PluginUnavailableComputerUseRow,
} from "@/settings/plugins-section/PluginSettingsRows.js";
import { PluginUninstallDialog } from "@/settings/plugins-section/PluginUninstallDialog.js";
import type { PluginListProps } from "@/settings/plugins-section/pluginsSectionTypes.js";
import { usePluginListController } from "@/settings/plugins-section/usePluginListController.js";
import { RemoteSyncDialogs } from "@/settings/RemoteSyncActions.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";

export function PluginList(props: PluginListProps) {
  const { target, configScope, onAdd, onCreateTask, isWebRemoteControl, onOpenPluginStore } = props;
  const controller = usePluginListController(props);
  const {
    intl,
    targetServiceResolution,
    baseServices,
    loading,
    togglingPluginId,
    storeItemById,
    visiblePlugins,
    visibleInstalledPlugins,
    visibleBuiltInPlugins,
    installedPluginCount,
    showUnavailableComputerUse,
    hideInstalledGroup,
    hasEmptySearchResult,
    computerUseDescriptionId,
    connectedRemoteSyncTarget,
    remotePluginSyncTargetLabel,
    remotePluginSyncOpen,
    setRemotePluginSyncOpen,
    selectedPlugin,
    selectedStoreItem,
    actions,
    refreshAfterPluginChange,
  } = controller;

  if (selectedPlugin && selectedStoreItem && targetServiceResolution.rpcReady) {
    return (
      <PluginSectionDetail
        controller={controller}
        inMarketplace={Boolean(props.inMarketplace)}
        showMarketplaceBreadcrumb={Boolean(props.showMarketplaceBreadcrumb)}
        onOpenPluginStore={onOpenPluginStore}
        onCreateTask={onCreateTask}
      />
    );
  }

  return (
    <section className="space-y-6" aria-labelledby="plugin-installed-title">
      {hasEmptySearchResult ? (
        <PluginsSectionEmptyState
          message={intl.formatMessage({
            id: "settings.plugin.plugins.empty",
          })}
        />
      ) : null}
      <div className={hideInstalledGroup ? "hidden" : "space-y-4"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3
            id="plugin-installed-title"
            className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground"
          >
            {intl.formatMessage({ id: "settings.plugin.plugins.installed" })}
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {visibleInstalledPlugins.length}
            </span>
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {connectedRemoteSyncTarget ? (
              <ControlHintTooltip
                title={intl.formatMessage({
                  id: "settings.plugins.remoteSync.open",
                })}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon-md"
                  aria-label={intl.formatMessage({
                    id: "settings.plugins.remoteSync.open",
                  })}
                  onClick={() => setRemotePluginSyncOpen(true)}
                >
                  <UploadCloud className="size-3.5" aria-hidden="true" />
                </Button>
              </ControlHintTooltip>
            ) : null}
            <SettingsResourceHeaderActions onRefresh={() => void refreshAfterPluginChange()} />
            {configScope === "workspace" ? (
              <Button
                type="button"
                variant="outline"
                data-testid={TID_PLUGIN_STORE_BROWSE}
                onClick={() => onOpenPluginStore()}
              >
                {intl.formatMessage({ id: "settings.plugin.plugins.browse" })}
              </Button>
            ) : null}
            {configScope === "user" ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  data-testid={TID_PLUGIN_STORE_BROWSE}
                  onClick={onAdd}
                >
                  {intl.formatMessage({ id: "settings.plugin.plugins.browse" })}
                </Button>
                <PluginAddMenu
                  testId="plugin-settings-add"
                  onCreateTask={onCreateTask}
                  isWebRemoteControl={isWebRemoteControl}
                  onAddMarketplace={() => onOpenPluginStore(undefined, "add-marketplace")}
                />
              </>
            ) : null}
          </div>
        </div>
        {configScope === "workspace" && target ? (
          <div
            className="rounded-lg border border-border bg-card px-3 py-2 text-ui-sm text-foreground-subtle"
            data-testid="plugin-settings-workspace-scope-hint"
          >
            {intl.formatMessage({ id: "settings.plugins.scope.workspaceHint" })}
          </div>
        ) : null}
        {connectedRemoteSyncTarget ? (
          <div className="rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.plugins.remoteContext" },
              { target: remotePluginSyncTargetLabel },
            )}
          </div>
        ) : null}
        {!target ? (
          <PluginsSectionEmptyState
            message={intl.formatMessage({
              id: "settings.plugin.noWorkspace",
            })}
          />
        ) : !targetServiceResolution.rpcReady ? (
          <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
        ) : loading && visiblePlugins.length === 0 ? (
          <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
        ) : visibleInstalledPlugins.length > 0 ? (
          <PluginSettingsRows
            items={visibleInstalledPlugins}
            actions={actions}
            configScope={configScope}
            togglingPluginId={togglingPluginId}
            storeItemById={storeItemById}
          />
        ) : installedPluginCount === 0 && !showUnavailableComputerUse ? (
          <PluginInstallEmptyState
            title={intl.formatMessage({
              id: "settings.plugin.plugins.emptyInstalledTitle",
            })}
            description={intl.formatMessage({
              id: "settings.plugin.plugins.emptyInstalledDescription",
            })}
            actions={
              onAdd ? (
                <Button type="button" variant="default" size="lg" onClick={onAdd}>
                  <Plus aria-hidden="true" data-icon="inline-start" />
                  {intl.formatMessage({
                    id: "settings.plugin.plugins.browse",
                  })}
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </div>
      {!hasEmptySearchResult && visibleBuiltInPlugins.length > 0 ? (
        <div className="space-y-4">
          <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.plugin.plugins.builtIn" })}
            <span className="text-ui-sm font-normal text-foreground-subtle">
              {visibleBuiltInPlugins.length}
            </span>
          </h3>
          <PluginSettingsRows
            items={visibleBuiltInPlugins}
            actions={actions}
            configScope={configScope}
            togglingPluginId={togglingPluginId}
            storeItemById={storeItemById}
          />
        </div>
      ) : null}
      {showUnavailableComputerUse ? (
        <div className="space-y-4">
          <h3 className="flex h-7 items-center text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.computerUse.unsupported.group" })}
          </h3>
          <PluginUnavailableComputerUseRow descriptionId={computerUseDescriptionId} />
        </div>
      ) : null}
      <PluginUninstallDialog controller={controller} />
      <RemoteSyncDialogs
        canSyncSkills={false}
        canSyncMcp={false}
        canSyncPlugins={Boolean(connectedRemoteSyncTarget && target?.workspacePath)}
        skillOpen={false}
        mcpOpen={false}
        pluginOpen={remotePluginSyncOpen}
        onSkillOpenChange={() => {}}
        onMcpOpenChange={() => {}}
        onPluginOpenChange={setRemotePluginSyncOpen}
        localPluginSyncService={baseServices.pluginSyncService}
        remotePluginSyncService={targetServiceResolution.services.pluginSyncService}
        localZCodeAgentService={baseServices.zcodeAgentService}
        remoteZCodeAgentService={targetServiceResolution.services.zcodeAgentService}
        remoteTarget={connectedRemoteSyncTarget}
        skillWorkspacePath=""
        mcpWorkspacePath=""
        pluginWorkspacePath={target?.workspacePath ?? ""}
        pluginLocalWorkspacePath={target?.localWorkspacePath}
        workspaceIdentity={target?.workspaceIdentity}
        onSkillsSynced={() => {}}
        onMcpSynced={() => {}}
        onPluginsSynced={refreshAfterPluginChange}
      />
    </section>
  );
}
