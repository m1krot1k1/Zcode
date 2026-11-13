import { z } from "zod";
import {
  zcodeDeliveryKindSchema,
  zcodeWorkspaceRefSchema,
} from "../zcode-protocol-legacy-types.js";
import { jsonObjectSchema, nonEmptyString } from "./schema-core.js";
import {
  zcodePluginComponentGroupSchema,
  zcodePluginDiagnosticSchema,
  zcodePluginHookDetailSchema,
  zcodePluginInfoSchema,
  zcodePluginScopeSchema,
} from "./schema-plugin-catalog.js";

// 推荐 Prompt 的可信插件解析：UI 不拆解 stableId，也不从旧目录快照推断可安装性。
export const zcodePluginSuggestedReferenceStatusSchema = z.enum([
  "ready",
  "disabled",
  "missing",
  "conflict",
  "unavailable",
]);

export type ZCodePluginSuggestedReferenceStatus = z.infer<
  typeof zcodePluginSuggestedReferenceStatusSchema
>;

export const zcodePluginOperationStateSchema = z.enum([
  "checking",
  "refreshing",
  "installing",
  "enabling",
  "cancelling",
  "cancelled",
  "complete",
  "failed",
]);

export type ZCodePluginOperationState = z.infer<typeof zcodePluginOperationStateSchema>;

export const zcodePluginOperationProgressNotificationSchema = z
  .object({
    operationId: nonEmptyString,
    state: z.literal("refreshing"),
  })
  .strict();

export type ZCodePluginOperationProgressNotification = z.infer<
  typeof zcodePluginOperationProgressNotificationSchema
>;

export const zcodePluginsResolveSuggestedReferenceParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    stableId: nonEmptyString,
    operationId: nonEmptyString,
    clientMode: zcodeDeliveryKindSchema,
    deliveryKind: zcodeDeliveryKindSchema,
  })
  .strict();

export type ZCodePluginsResolveSuggestedReferenceParams = z.infer<
  typeof zcodePluginsResolveSuggestedReferenceParamsSchema
>;

export const zcodePluginsSetEnabledParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    enabled: z.boolean(),
    operationId: nonEmptyString.optional(),
    scope: zcodePluginScopeSchema.optional(),
  })
  .strict();

export const zcodePluginsSetEnabledResultSchema = z
  .object({
    plugin: zcodePluginInfoSchema,
    enabled: z.boolean(),
  })
  .strict();

export type ZCodePluginsSetEnabledResult = z.infer<typeof zcodePluginsSetEnabledResultSchema>;

// 商店信息（Store Listing）：目录条目携带的展示性元数据（显示名/icon/分类/作者/链接/hero/
// 示例提示词），全部可选，UI 缺失时按降级矩阵处理（字母头像/隐藏区块/省略信息行）。
// i18n 采用 `<字段>I18n` map，locale 解析复用 shared 的 plugin-display-name helper。
export const zcodePluginStoreListingSchema = z
  .object({
    displayName: z.string().optional(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    publisherType: z.enum(["official", "community"]).optional(),
    author: z.string().optional(),
    authorUrl: z.string().optional(),
    homepage: z.string().optional(),
    privacyPolicy: z.string().optional(),
    termsOfService: z.string().optional(),
    heroImage: z.string().optional(),
    examplePrompts: z.array(z.string()).optional(),
    examplePromptsI18n: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * 需要付费套餐才好用的插件：市场目录条目声明 `requiresPaidPlan: true`，
     * UI 在标题右侧展示提示图标。描述的是「使用条件」而非「插件是收费商品」——
     * 不参与安装门禁与计费，命名也不绑定具体套餐商品名。
     */
    requiresPaidPlan: z.boolean().optional(),
  })
  .strict();

export type ZCodePluginStoreListing = z.infer<typeof zcodePluginStoreListingSchema>;

export const zcodePluginsResolveSuggestedReferenceResultSchema = z
  .object({
    stableId: nonEmptyString,
    status: zcodePluginSuggestedReferenceStatusSchema,
    marketplace: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    sourceTrust: z.literal("official").optional(),
    // 官方 Marketplace listing 的可选展示投影；不参与身份、安装或权限判断。
    icon: z.string().optional(),
    listing: zcodePluginStoreListingSchema.optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "ready" && value.status !== "disabled" && value.status !== "missing") {
      return;
    }
    if (!value.marketplace || !value.pluginName || value.sourceTrust !== "official") {
      context.addIssue({
        code: "custom",
        message: "actionable suggested Plugin results require trusted install identity",
      });
    }
  });

export type ZCodePluginsResolveSuggestedReferenceResult = z.infer<
  typeof zcodePluginsResolveSuggestedReferenceResultSchema
>;

export const zcodePluginMarketplaceSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    source: jsonObjectSchema,
    description: z.string().optional(),
    lastUpdated: z.string().optional(),
    pluginCount: z.number().int().nonnegative(),
    isOfficial: z.boolean().optional(),
    // 目录顶层 featured 策展名单（商店「公开」分段 Featured 区）。
    featured: z.array(z.string()).optional(),
    refreshFailure: z
      .object({
        code: z.string(),
        failedAt: z.string(),
        message: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ZCodePluginMarketplaceSummary = z.infer<typeof zcodePluginMarketplaceSummarySchema>;

export const zcodeAvailablePluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    installed: z.boolean(),
    componentTypes: z.array(z.string()).optional(),
    listing: zcodePluginStoreListingSchema.optional(),
  })
  .strict();

export type ZCodeAvailablePluginSummary = z.infer<typeof zcodeAvailablePluginSummarySchema>;

export const zcodeInstalledPluginSummarySchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    marketplace: nonEmptyString,
    description: z.string().optional(),
    version: z.string().optional(),
    enabled: z.boolean(),
    scope: zcodePluginScopeSchema,
    installPath: z.string().optional(),
    installedAt: z.string().optional(),
    componentTypes: z.array(z.string()).optional(),
    hookDetails: z.array(zcodePluginHookDetailSchema).optional(),
    updateStatus: z.enum(["none", "update-available", "version-changed"]).optional(),
    latestVersion: z.string().optional(),
    listing: zcodePluginStoreListingSchema.optional(),
  })
  .strict();

export type ZCodeInstalledPluginSummary = z.infer<typeof zcodeInstalledPluginSummarySchema>;

export const zcodePluginsOverviewParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    configScope: zcodePluginScopeSchema.optional(),
  })
  .strict();

export const zcodePluginsOverviewResultSchema = z
  .object({
    marketplaces: z.array(zcodePluginMarketplaceSummarySchema),
    availablePlugins: z.array(zcodeAvailablePluginSummarySchema),
    installedPlugins: z.array(zcodeInstalledPluginSummarySchema),
    restorableBuiltins: z.array(zcodeAvailablePluginSummarySchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
    capability: z
      .object({
        supported: z.boolean(),
        reason: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type ZCodePluginsOverviewResult = z.infer<typeof zcodePluginsOverviewResultSchema>;

export const zcodePluginsMarketplaceAddParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    source: nonEmptyString,
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();

export const zcodePluginsMarketplaceRemoveParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    marketplace: nonEmptyString,
  })
  .strict();

export const zcodePluginsMarketplaceUpdateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    marketplace: nonEmptyString.optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();

export const zcodePluginsMarketplaceMutationResultSchema = z
  .object({
    marketplace: zcodePluginMarketplaceSummarySchema.optional(),
    marketplaces: z.array(zcodePluginMarketplaceSummarySchema).optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema).optional(),
  })
  .strict();

export type ZCodePluginsMarketplaceMutationResult = z.infer<
  typeof zcodePluginsMarketplaceMutationResultSchema
>;

export const zcodePluginsInstallParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
    scope: zcodePluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict();

export const zcodePluginsCancelOperationParamsSchema = z
  .object({
    operationId: nonEmptyString,
  })
  .strict();

export type ZCodePluginsCancelOperationParams = z.infer<
  typeof zcodePluginsCancelOperationParamsSchema
>;

export const zcodePluginsCancelOperationResultSchema = z
  .object({
    operationId: nonEmptyString,
    cancelled: z.boolean(),
  })
  .strict();

export type ZCodePluginsCancelOperationResult = z.infer<
  typeof zcodePluginsCancelOperationResultSchema
>;

export const zcodePluginsUninstallParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    removeCache: z.boolean().optional(),
  })
  .strict();

export const zcodePluginsInstallResultSchema = z
  .object({
    installedPlugins: z.array(zcodeInstalledPluginSummarySchema),
    dependencyClosure: z.array(z.string()),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();

export type ZCodePluginsInstallResult = z.infer<typeof zcodePluginsInstallResultSchema>;

export const zcodePluginsUninstallResultSchema = z
  .object({
    removedPlugin: zcodeInstalledPluginSummarySchema.optional(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();

export type ZCodePluginsUninstallResult = z.infer<typeof zcodePluginsUninstallResultSchema>;

export const zcodePluginsUpdateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
  })
  .strict();

export const zcodePluginsRestoreBuiltinParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
  })
  .strict();

export const zcodePluginsRestoreBuiltinResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();

export type ZCodePluginsRestoreBuiltinResult = z.infer<
  typeof zcodePluginsRestoreBuiltinResultSchema
>;

export const zcodePluginsConfigureParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    options: jsonObjectSchema,
    clearOptionKeys: z.array(nonEmptyString).optional(),
    scope: zcodePluginScopeSchema.optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export const zcodePluginsConfigureResultSchema = z
  .object({
    pluginId: nonEmptyString,
    diagnostics: z.array(zcodePluginDiagnosticSchema),
  })
  .strict();

export type ZCodePluginsConfigureResult = z.infer<typeof zcodePluginsConfigureResultSchema>;

export const zcodePluginsResetConfigParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginId: nonEmptyString,
    scope: zcodePluginScopeSchema.optional(),
  })
  .strict();

export type ZCodePluginsResetConfigParams = z.infer<typeof zcodePluginsResetConfigParamsSchema>;

export const zcodePluginsValidateParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString.optional(),
    marketplace: nonEmptyString.optional(),
    source: nonEmptyString.optional(),
  })
  .strict();

export const zcodePluginsValidateResultSchema = z
  .object({
    ok: z.boolean(),
    diagnostics: z.array(zcodePluginDiagnosticSchema),
    compatibility: z
      .object({
        runnable: z.array(z.string()),
        diagnosticOnly: z.array(z.string()),
        unsupported: z.array(z.string()),
      })
      .strict(),
  })
  .strict();

export type ZCodePluginsValidateResult = z.infer<typeof zcodePluginsValidateResultSchema>;

// plugins/describe：按需枚举单个插件的组件「名称 + 描述」。
// 已安装插件读本地缓存目录；未安装候选按需解析/临时 clone 源后枚举再清理。
export const zcodePluginsDescribeParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    pluginName: nonEmptyString,
    marketplace: nonEmptyString,
  })
  .strict();

export const zcodePluginsDescribeResultSchema = z
  .object({
    components: z.array(zcodePluginComponentGroupSchema),
    diagnostics: z.array(zcodePluginDiagnosticSchema).optional(),
    // 插件包内 plugin.json 的展示性回退字段；未安装候选详情页信息区在商店 listing 缺失时兜底。
    metadata: z
      .object({
        author: z.string().optional(),
        authorUrl: z.string().optional(),
        homepage: z.string().optional(),
        version: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ZCodePluginsDescribeResult = z.infer<typeof zcodePluginsDescribeResultSchema>;
