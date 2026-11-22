import {
  BUILTIN_MODEL_PROVIDER_IDS,
  resolveModelProviderFamilySpecByProviderId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { logger } from "@/logger.js";
import { sanitizeProxyRouteForDisplay } from "@/settingsPageHelpers.js";
import { EmbeddingProviderSettings } from "@/agent-workbench/index.js";
import { OpenCodeAgentSettingsPanel } from "@/opencode-agent-settings/index.js";
import { BIGMODEL_REGISTRATION_URL } from "../constants.js";
import { ModelProviderSectionDetail } from "../Detail.js";
import { refreshModelProviderSection } from "../modelProviderActions.js";
import { ProviderTemplatePicker } from "../ProviderTemplatePicker.js";
import { ModelProviderSectionLayout } from "../SectionLayout.js";
import type { ModelProviderSectionController } from "./useModelProviderSectionController.js";

export function ModelProviderSectionView({
  controller,
}: {
  controller: ModelProviderSectionController;
}) {
  const { environment, codingPlan, navigation, actions, presetLoading, customLoading } = controller;
  const {
    intl,
    platform,
    modelSelectionService,
    codeIntelligenceService,
    codeIndexWorkspaceRef,
    providerTemplates,
    loadError,
    reload,
    refresh,
    providerSettingsView,
    invalidProviderTarget,
    selectedNodeKey,
    presetSubscriptionProviderId,
    setPresetSubscriptionProviderId,
    codingPlanStatusSyncProviderId,
    codingPlanDisconnectProviderId,
    templatePickerOpen,
    setTemplatePickerOpen,
    creatingProvider,
    reorderableProviderIds,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    reorderProviderModels,
  } = environment;
  const {
    sharedSettings,
    updateSharedSettings,
    oauthError,
    setOAuthError,
    refreshAuthenticatedEnterpriseProducts,
    codingPlanPurchaseTokenAuthenticatedByProviderId,
    familyConnectionSettingsFailed,
    effectiveConnectionSelections,
    codingPlanEntitlements,
    refreshCodingPlanEntitlements,
    refreshProviderPanelAfterAuthChange,
  } = codingPlan;
  const { navigationGroups, navigationItems, selectedNavItem, navigationUnavailable } = navigation;
  const {
    handleSave,
    handleDelete,
    handleOpenApiKeyUrl,
    handleCodingPlanLogin,
    handleCodingPlanDisconnect,
    handleSelectNavItem,
    handleCreateProvider,
    handleReorderProviderIds,
    handleTestModel,
  } = actions;

  return (
    <>
      <ModelProviderSectionLayout
        description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
        refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
        loadingLabel={intl.formatMessage({ id: "common.loading" })}
        presetLoading={presetLoading}
        customLoading={customLoading}
        onRefresh={() => {
          void refreshModelProviderSection({
            refresh,
            // 手动刷新设置页时也要同时刷新 Z.ai / BigModel Team Plan 快照；
            // 原来只刷新 BigModel，Z.ai Team Plan 购买或订阅变化后会继续显示旧项目。
            refreshTeamPlanProducts: refreshAuthenticatedEnterpriseProducts,
          });
          refreshCodingPlanEntitlements();
        }}
        addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
        onAddProvider={() => setTemplatePickerOpen(true)}
        navigationGroups={navigationGroups}
        selectedNodeKey={selectedNodeKey}
        onSelectNavItem={handleSelectNavItem}
        onReorderProviderIds={handleReorderProviderIds}
        reorderableProviderIds={reorderableProviderIds}
      >
      {(invalidProviderTarget || navigationUnavailable) && !templatePickerOpen ? (
        <p role="alert" className="mb-3 text-ui-base text-destructive">
          {intl.formatMessage({
            id: invalidProviderTarget
              ? "settings.modelProvider.navigationUnavailable"
              : "settings.modelProvider.connectionUnavailable",
          })}
        </p>
      ) : null}
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => {
            return handleCreateProvider({ templateId });
          }}
          onCreateCustom={(label) => {
            return handleCreateProvider({ providerName: label });
          }}
        />
      ) : selectedNavItem?.type === "codeIntelligence" ? (
        <EmbeddingProviderSettings
          codeIndex={codeIntelligenceService}
          workspaceRef={codeIndexWorkspaceRef}
        />
      ) : selectedNavItem?.type === "agentIntegration" ? (
        <OpenCodeAgentSettingsPanel
          enabled={sharedSettings?.openCodeCliEnabled === true}
          activeProxy={sanitizeProxyRouteForDisplay(sharedSettings?.httpProxy)}
          onEnabledChange={async (enabled) => {
            try {
              await updateSharedSettings({ openCodeCliEnabled: enabled });
              // Каталог локального CLI принадлежит Host Registry; после изменения доступности
              // перечитываем обычные Provider Settings и ModelSelection для Composer.
              await refresh();
              await modelSelectionService.getView();
            } catch (error) {
              logger.warn("[settings] OpenCode CLI setting update failed", {
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
          }}
        />
      ) : loadError ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-ui-base">
          <p className="text-destructive">{loadError.message}</p>
          <Button type="button" variant="outline" onClick={reload}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : (
        <ModelProviderSectionDetail
          connectionSelections={effectiveConnectionSelections}
          providerSettingsView={providerSettingsView}
          selectedNavItem={selectedNavItem}
          navigationItems={navigationItems}
          connectionSettingsFailed={familyConnectionSettingsFailed}
          startPlanSubscriptionCount={(() => {
            const providerId =
              selectedNavItem && "presetId" in selectedNavItem ? selectedNavItem.presetId : null;
            const family = providerId
              ? resolveModelProviderFamilySpecByProviderId(providerId)
              : null;
            const entitlement = family ? codingPlanEntitlements[family.startPlanProviderId] : null;
            // 只展示当前 Family 已查询到的权益，不用当前是否选中 Start 代替拥有数量。
            return entitlement?.error
              ? 0
              : (entitlement?.snapshot?.subscription?.details.length ?? 0);
          })()}
          presetLoading={presetLoading}
          codingPlanAuthError={oauthError}
          codingPlanPurchaseTokenAuthenticatedByProviderId={
            codingPlanPurchaseTokenAuthenticatedByProviderId
          }
          presetSubscriptionProviderId={presetSubscriptionProviderId}
          codingPlanStatusSyncProviderId={codingPlanStatusSyncProviderId}
          codingPlanDisconnectProviderId={codingPlanDisconnectProviderId}
          onSave={handleSave}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={handleDelete}
          // Provider 的左栏排序权限被误复用成模型排序门禁，导致 Built-in / Account
          // Provider 的 Effective 模型无法写入 Personal modelOrder。模型调序独立于成员来源。
          onReorderProviderModels={reorderProviderModels}
          onTestModel={handleTestModel}
          onCodingPlanLogin={handleCodingPlanLogin}
          onRetryCodingPlan={() => {
            // 取 Key 失败不等于登录失效；沿用 Host 手动刷新，不清除 OAuth 或重新登录。
            logger.info("[ModelProviderSection] 重试获取套餐状态");
            return refresh().then(() =>
              refreshCodingPlanEntitlements({ force: true, reason: "manual" }),
            );
          }}
          onCodingPlanDisconnect={handleCodingPlanDisconnect}
          onOpenApiKeyUrl={handleOpenApiKeyUrl}
          onSelectNavItem={handleSelectNavItem}
          onOpenBigModelRegistration={() => {
            // 未注册提示来自一次失败的 OAuth checking 状态；跳转注册后要恢复普通状态，避免提示卡住。
            setOAuthError(null);
            setPresetSubscriptionProviderId((current) =>
              current === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ? null : current,
            );
            platform.openExternal(BIGMODEL_REGISTRATION_URL);
          }}
          onCodingPlanPurchaseComplete={async () => {
            await refreshProviderPanelAfterAuthChange({ refreshReason: "purchase" });
          }}
        />
      )}
      </ModelProviderSectionLayout>
    </>
  );
}
