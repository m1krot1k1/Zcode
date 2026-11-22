import { z } from "zod";
import { accountProviderUnavailableReasonSchema } from "../account-provider-state.js";
import { completeModelConfigDataSchema } from "../model-config.js";
import { modelSelectionSchema } from "../model-selection.js";
import { zcodeSessionModeSchema, zcodeWorkspaceRefSchema } from "../zcode-protocol-legacy-types.js";
import { nonEmptyString } from "./schema-core.js";
import { zcodeSlashCommandSchema } from "./schema-session-state.js";
import { zcodeDynamicWorkflowModeSchema } from "./schema-session-commands.js";

export const zcodeWorkspaceReadPresentationParamsSchema = z
  .object({ workspace: zcodeWorkspaceRefSchema })
  .strict();

export const zcodeWorkspacePresentationSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    mode: zcodeSessionModeSchema,
    slashCommands: z.array(zcodeSlashCommandSchema),
  })
  .strict();

export type ZCodeWorkspacePresentation = z.infer<typeof zcodeWorkspacePresentationSchema>;

const workspaceHookSha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const zcodeWorkspaceHookTrustGrantParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    bundleDigest: workspaceHookSha256DigestSchema,
    hookDeclarationDigest: workspaceHookSha256DigestSchema,
  })
  .strict();

export type ZCodeWorkspaceHookTrustGrantParams = z.infer<
  typeof zcodeWorkspaceHookTrustGrantParamsSchema
>;

export const zcodeWorkspaceHookTrustGrantReasonCodeSchema = z.enum([
  "workspace_hooks_blocked_by_policy",
  "workspace_hooks_bundle_changed",
  "workspace_hooks_snapshot_mismatch",
  "workspace_hooks_policy_requires_pretrust",
  "workspace_hooks_trust_store_corrupt",
  "workspace_hooks_config_unreadable",
]);

export type ZCodeWorkspaceHookTrustGrantReasonCode = z.infer<
  typeof zcodeWorkspaceHookTrustGrantReasonCodeSchema
>;

export const zcodeWorkspaceHookTrustGrantResultSchema = z
  .object({
    accepted: z.boolean(),
    reasonCode: zcodeWorkspaceHookTrustGrantReasonCodeSchema.optional(),
  })
  .strict();

export type ZCodeWorkspaceHookTrustGrantResult = z.infer<
  typeof zcodeWorkspaceHookTrustGrantResultSchema
>;

const zcodeWorkspaceModelToolCallSchema = z
  .object({
    id: nonEmptyString,
    name: nonEmptyString,
    input: z.unknown(),
  })
  .strict();

const zcodeWorkspaceModelMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string(),
      toolCalls: z.array(zcodeWorkspaceModelToolCallSchema).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      content: z.string(),
      toolCallId: nonEmptyString,
      toolName: nonEmptyString,
      isError: z.boolean().optional(),
    })
    .strict(),
]);

const zcodeWorkspaceModelToolSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const zcodeWorkspaceGenerateTextParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    selection: modelSelectionSchema,
    prompt: nonEmptyString.optional(),
    messages: z.array(zcodeWorkspaceModelMessageSchema).min(1).optional(),
    tools: z.array(zcodeWorkspaceModelToolSchema).optional(),
    querySource: nonEmptyString,
    maxOutputTokens: z.number().int().positive().optional(),
    operationId: nonEmptyString.optional(),
  })
  .strict()
  .refine((value) => value.prompt !== undefined || value.messages !== undefined, {
    message: "prompt 或 messages 至少需要提供一个",
  });

export const zcodeWorkspaceGenerateTextResultSchema = z
  .object({
    text: z.string(),
    selection: modelSelectionSchema,
    toolCalls: z.array(zcodeWorkspaceModelToolCallSchema).optional(),
    requestId: nonEmptyString.optional(),
    // 可选以兼容仍在运行的旧 app-server；新 CLI 始终返回结构化结束原因。
    finishReason: z.string().optional(),
    usage: z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        totalTokens: z.number().nonnegative().optional(),
        cacheReadTokens: z.number().nonnegative().optional(),
        cacheWriteTokens: z.number().nonnegative().optional(),
        reasoningTokens: z.number().nonnegative().optional(),
        serverToolUse: z
          .object({
            webSearchRequests: z.number().nonnegative().optional(),
            webFetchRequests: z.number().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ZCodeWorkspaceGenerateTextParams = z.infer<
  typeof zcodeWorkspaceGenerateTextParamsSchema
>;

export type ZCodeWorkspaceModelMessage = z.infer<typeof zcodeWorkspaceModelMessageSchema>;

export type ZCodeWorkspaceModelTool = z.infer<typeof zcodeWorkspaceModelToolSchema>;

export type ZCodeWorkspaceGenerateTextResult = z.infer<
  typeof zcodeWorkspaceGenerateTextResultSchema
>;

export const zcodeWorkspaceCancelGenerateTextParamsSchema = z
  .object({ operationId: nonEmptyString })
  .strict();

export const zcodeWorkspaceCancelGenerateTextResultSchema = z
  .object({ operationId: nonEmptyString, cancelled: z.boolean() })
  .strict();

export const zcodeProviderTestModelConnectivityParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    selection: modelSelectionSchema,
  })
  .strict();

export const zcodeProviderTestModelConnectivityResultSchema = z
  .object({ success: z.literal(true) })
  .strict();

export type ZCodeProviderTestModelConnectivityParams = z.infer<
  typeof zcodeProviderTestModelConnectivityParamsSchema
>;

export type ZCodeProviderTestModelConnectivityResult = z.infer<
  typeof zcodeProviderTestModelConnectivityResultSchema
>;

export const zcodeProviderUpdateAccountConfigParamsSchema = z
  .object({
    revision: nonEmptyString,
    basedOnZCodeBuiltinRevision: nonEmptyString,
    // Provider Config 的字段校验由 @zcode/provider 负责；协议层只约束可传输信封。
    providers: z.record(z.string(), z.unknown()),
    // 账号状态与 Overlay 必须一起传递，否则 Worker 会丢失非当前套餐的执行门禁。
    states: z.record(
      z.string(),
      z
        .object({
          availability: z.enum(["available", "pending", "unavailable", "unknown"]),
          entitled: z.boolean(),
          unavailableReason: accountProviderUnavailableReasonSchema.optional(),
          current: z.boolean().optional(),
          connectionKey: z.string().optional(),
          effectiveAt: z.number().finite().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export const zcodeProviderUpdateAccountConfigResultSchema = z
  .object({
    // 收到账号结果不代表配套 Built-in 已到达；应用版本只能读取 Registry 快照。
    receivedRevision: nonEmptyString,
    providerCount: z.number().int().nonnegative(),
    status: z.enum(["received", "unchanged"]),
  })
  .strict();

export type ZCodeProviderUpdateAccountConfigResult = z.infer<
  typeof zcodeProviderUpdateAccountConfigResultSchema
>;

/**
 * Safe runtime-discovered provider wire format. This deliberately cannot carry credentials,
 * endpoints, or arbitrary provider config; the worker additionally validates it into domain types.
 */
const opencodeRuntimeProviderConfigSchema = z
  .object({
    group: z.enum(["standard-personal", "zai-family", "bigmodel-family"]),
    logo: z
      .object({ type: z.literal("builtin"), key: z.string().min(1).max(128) })
      .strict()
      .nullable()
      .optional(),
    access: z.object({ type: z.literal("local-auth") }).strict(),
    api: z.object({ type: z.literal("opencode-sdk") }).strict(),
    builtinModelIds: z.array(z.string().min(1).max(256)).max(4096).nullable().optional(),
    personalModelIds: z.array(z.string().min(1).max(256)).max(4096).nullable().optional(),
    modelOrder: z.array(z.string().min(1).max(256)).max(4096).nullable().optional(),
    visibility: z.enum(["visible", "hidden"]).nullable().optional(),
  })
  .strict();

/** 保留 CLI 给 SDK 的原始 provider/model 名称，同时拦截不安全协议 ID。 */
export const opencodeRuntimeModelIdSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+$/);

const opencodeRuntimeProviderSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    providerName: z.string().min(1).max(256),
    templateId: z.string().min(1).max(128).optional(),
    config: opencodeRuntimeProviderConfigSchema,
    models: z
      .array(
        z
          .object({
            modelId: opencodeRuntimeModelIdSchema,
            config: completeModelConfigDataSchema.extend({
              api: z.null().optional(),
            }),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();

/** 保留 Cursor CLI 原始模型 ID（`composer-1`、`claude-4.5-sonnet`），同时拦截不安全协议 ID。 */
export const cursorRuntimeModelIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._:/-]+$/);

const cursorRuntimeProviderConfigSchema = z
  .object({
    group: z.enum(["standard-personal", "zai-family", "bigmodel-family"]),
    logo: z
      .object({ type: z.literal("builtin"), key: z.string().min(1).max(128) })
      .strict()
      .nullable()
      .optional(),
    access: z.object({ type: z.literal("local-auth") }).strict(),
    api: z.object({ type: z.literal("cursor-cli") }).strict(),
    builtinModelIds: z.array(z.string().min(1).max(256)).max(4096).nullable().optional(),
    personalModelIds: z.array(z.string().min(1).max(256)).max(4096).nullable().optional(),
    modelOrder: z.array(z.string().min(1).max(256)).max(4096).nullable().optional(),
    visibility: z.enum(["visible", "hidden"]).nullable().optional(),
  })
  .strict();

const cursorRuntimeProviderSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    providerName: z.string().min(1).max(256),
    templateId: z.string().min(1).max(128).optional(),
    config: cursorRuntimeProviderConfigSchema,
    models: z
      .array(
        z
          .object({
            modelId: cursorRuntimeModelIdSchema,
            config: completeModelConfigDataSchema.extend({
              api: z.null().optional(),
            }),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict();

/** 本地 CLI Provider：OpenCode 与 Cursor 共用同一 snapshot，按 api.type 判别。 */
export const localCliRuntimeProviderSchema = z.union([
  opencodeRuntimeProviderSchema,
  cursorRuntimeProviderSchema,
]);

export const zcodeProviderUpdateRuntimeCatalogParamsSchema = z
  .object({
    revision: nonEmptyString,
    providers: z.array(localCliRuntimeProviderSchema).max(8),
    cliExecutablePath: z.string().min(1).max(4096).optional(),
    cliExecutablePaths: z
      .record(z.string().min(1).max(128), z.string().min(1).max(4096))
      .optional(),
  })
  .strict();

export const zcodeProviderUpdateRuntimeCatalogResultSchema = z
  .object({
    receivedRevision: nonEmptyString,
    providerCount: z.number().int().nonnegative(),
    status: z.enum(["applied", "unchanged"]),
  })
  .strict();

export type ZCodeProviderUpdateRuntimeCatalogParams = z.infer<
  typeof zcodeProviderUpdateRuntimeCatalogParamsSchema
>;

export type ZCodeProviderUpdateRuntimeCatalogResult = z.infer<
  typeof zcodeProviderUpdateRuntimeCatalogResultSchema
>;

/** Worker 从所属 Environment 的正式 Config Store 重建进程内 Provider Registry。 */
export const zcodeProviderRefreshRegistryParamsSchema = z
  .object({
    reason: nonEmptyString,
  })
  .strict();

export const zcodeProviderRefreshRegistryResultSchema = z
  .object({
    refreshed: z.literal(true),
  })
  .strict();

export type ZCodeProviderRefreshRegistryParams = z.infer<
  typeof zcodeProviderRefreshRegistryParamsSchema
>;

export type ZCodeProviderRefreshRegistryResult = z.infer<
  typeof zcodeProviderRefreshRegistryResultSchema
>;

export const zcodeInteractionPreferencesSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
  })
  .strict();

export type ZCodeInteractionPreferences = z.infer<typeof zcodeInteractionPreferencesSchema>;

export const zcodeWorkspaceUpdateInteractionPreferencesParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    preferences: zcodeInteractionPreferencesSchema,
  })
  .strict();

export type ZCodeWorkspaceUpdateInteractionPreferencesParams = z.infer<
  typeof zcodeWorkspaceUpdateInteractionPreferencesParamsSchema
>;

export const zcodeWorkspaceUpdateInteractionPreferencesResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    snoozedInteractionCount: z.number().int().nonnegative(),
  })
  .strict();

export type ZCodeWorkspaceUpdateInteractionPreferencesResult = z.infer<
  typeof zcodeWorkspaceUpdateInteractionPreferencesResultSchema
>;

export const zcodeModelIoPreferencesSchema = z
  .object({
    fullRetentionEnabled: z.boolean(),
  })
  .strict();

export type ZCodeModelIoPreferences = z.infer<typeof zcodeModelIoPreferencesSchema>;

export const zcodeWorkspaceUpdateModelIoPreferencesParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    preferences: zcodeModelIoPreferencesSchema,
  })
  .strict();

export type ZCodeWorkspaceUpdateModelIoPreferencesParams = z.infer<
  typeof zcodeWorkspaceUpdateModelIoPreferencesParamsSchema
>;

export const zcodeWorkspaceUpdateModelIoPreferencesResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    fullRetentionEnabled: z.boolean(),
    updatedSessionCount: z.number().int().nonnegative(),
  })
  .strict();

export type ZCodeWorkspaceUpdateModelIoPreferencesResult = z.infer<
  typeof zcodeWorkspaceUpdateModelIoPreferencesResultSchema
>;

export const zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();

export type ZCodeWorkspaceUpdateOffPeakToolPolicyParams = z.infer<
  typeof zcodeWorkspaceUpdateOffPeakToolPolicyParamsSchema
>;

export const zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();

export type ZCodeWorkspaceUpdateOffPeakToolPolicyResult = z.infer<
  typeof zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema
>;

// 动态工作流灰度门禁：workspace 级事实，
// 与 Off-Peak 同一套 host→CLI 同步模式；旧 CLI method-not-found → host 降级忽略。
export const zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
    // launch.md「On demand: activation」：mode 与布尔同行；缺席时 CLI 按布尔行事（alwaysOn）。
    mode: zcodeDynamicWorkflowModeSchema.optional(),
  })
  .strict();

export type ZCodeWorkspaceUpdateDynamicWorkflowPolicyParams = z.infer<
  typeof zcodeWorkspaceUpdateDynamicWorkflowPolicyParamsSchema
>;

export const zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema,
    enabled: z.boolean(),
  })
  .strict();

export type ZCodeWorkspaceUpdateDynamicWorkflowPolicyResult = z.infer<
  typeof zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema
>;
