import { z } from "zod";
import { appToolSearchModeSchema } from "../app-runtime-preferences.js";
import { zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
import { DYNAMIC_WORKFLOW_MODES } from "../dynamic-workflow-feature.js";
import { modelExecutionSchema } from "../model-execution.js";
import { modelSelectionSchema } from "../model-selection.js";
import { APP_USAGE_RANGES, appUsageSnapshotSchema } from "../usage-stats.js";
import { integratedTerminalShellSelectionSchema } from "../validationAppSettings.js";
import {
  zcodeDeliveryKindSchema,
  zcodeSessionInfoSchema,
  zcodeSessionModeSchema,
  zcodeWorkspaceRefSchema,
} from "../zcode-protocol-legacy-types.js";
import { jsonObjectSchema, nonEmptyString, protocolInstantSchema } from "./schema-core.js";
import { zcodeProtocolMcpServerSchema, zcodeSessionPersistenceSchema } from "./schema-mcp.js";
import { zcodeSessionImportHistorySchema } from "./schema-model.js";
import { zcodeSessionStateSnapshotSchema } from "./schema-session-state.js";

export const zcodeSessionListResultSchema = z
  .object({
    sessions: z.array(zcodeSessionInfoSchema),
  })
  .strict();

const zcodeSessionSubagentBaseSchema = z
  .object({
    childSessionId: nonEmptyString,
    agentId: nonEmptyString.optional(),
    toolCallId: nonEmptyString.optional(),
    subagentType: nonEmptyString,
    title: nonEmptyString,
    summary: z.string().optional(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const zcodeSessionRunningSubagentSchema = zcodeSessionSubagentBaseSchema.extend({
  status: z.enum(["running", "waiting", "blocked"]),
});

export type ZCodeSessionRunningSubagent = z.infer<typeof zcodeSessionRunningSubagentSchema>;

export const zcodeSessionEndedSubagentSchema = zcodeSessionSubagentBaseSchema.extend({
  status: z.enum(["success", "failed", "cancelled", "lost"]),
  /** @deprecated Используйте hostAcceptance; поле сохранено для старых клиентов. */
  prismAcceptance: z
    .object({
      status: z.enum(["unknown", "verified", "rejected"]),
      passedCriteria: z.number().int().nonnegative(),
      totalCriteria: z.number().int().nonnegative(),
    })
    .strict()
    .optional(),
  /** Каноническое имя приёмки: проверка объявленной команды на стороне Host. */
  hostAcceptance: z
    .object({
      status: z.enum(["unknown", "verified", "rejected"]),
      passedCriteria: z.number().int().nonnegative(),
      totalCriteria: z.number().int().nonnegative(),
    })
    .strict()
    .optional(),
});

export type ZCodeSessionEndedSubagent = z.infer<typeof zcodeSessionEndedSubagentSchema>;

export const zcodeSessionSubagentsResultSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    childSessionIds: z.array(nonEmptyString),
    running: z.array(zcodeSessionRunningSubagentSchema),
    ended: z
      .object({
        total: z.number().int().nonnegative(),
        items: z.array(zcodeSessionEndedSubagentSchema),
        nextCursor: nonEmptyString.optional(),
      })
      .strict(),
  })
  .strict();

export type ZCodeSessionSubagentsResult = z.infer<typeof zcodeSessionSubagentsResultSchema>;

/** 服务端 feature key 的取值域在协议里的 zod 形态（packages/shared/src/dynamic-workflow-feature.ts）。 */
export const zcodeDynamicWorkflowModeSchema = z.enum(DYNAMIC_WORKFLOW_MODES);

export const zcodeSessionCreateParamsSchema = z
  .object({
    additionalDirectories: z.array(nonEmptyString).max(256).optional(),
    sessionId: nonEmptyString.optional(),
    workspace: zcodeWorkspaceRefSchema,
    parentSessionId: nonEmptyString.optional(),
    mode: zcodeSessionModeSchema.optional(),
    model: modelSelectionSchema.optional(),
    persistence: zcodeSessionPersistenceSchema.optional(),
    thoughtLevel: nonEmptyString.optional(),
    titleGenerationEnabled: z.boolean().optional(),
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    importedHistory: zcodeSessionImportHistorySchema.optional(),
    // host 只按本地服务装配/远程/端形态决定是否注册工具，不读取灰度；
    // 缺省不下发 = 不注册；灰度与套餐准入在实际创建的 Host handler 校验。
    offPeakToolEnabled: z.boolean().optional(),
    // 动态工作流灰度：与 offPeakToolEnabled 同一
    // 模式——host 裁决后下发，缺省不下发 = 不注册工作流工具簇（fail-closed）。
    dynamicWorkflowEnabled: z.boolean().optional(),
    // 灰度 mode 随布尔同行下发（launch.md「On demand: activation」）：`onDemand` 让 CLI 把十个
    // 工具推迟到会话首次 `/workflow` 才注册；缺席 = 按布尔行事（alwaysOn），供旧 Host 配对。
    dynamicWorkflowMode: zcodeDynamicWorkflowModeSchema.optional(),
  })
  .strict();

export type ZCodeSessionCreateParams = z.infer<typeof zcodeSessionCreateParamsSchema>;

export const zcodeSessionResumeParamsSchema = z
  .object({
    additionalDirectories: z.array(nonEmptyString).max(256).optional(),
    sessionId: nonEmptyString,
    workspace: zcodeWorkspaceRefSchema.optional(),
    // 旧 session 尚无 runtime/model_selection entry 时，由同 task 的索引元数据提供迁移 hint。
    thoughtLevel: nonEmptyString.optional(),
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    // 冷恢复重建 runtime 时必须沿用 create 的工具面约束（否则会绕过 allow/deny，尤其 CUA 会话）。
    toolAllowlist: z.array(nonEmptyString).optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
    // 与 create 同语义；resume 不带会导致冷恢复丢 Off-Peak 工具面。
    offPeakToolEnabled: z.boolean().optional(),
    // 与 create 同语义；resume 不带会导致冷恢复丢工作流工具簇。
    dynamicWorkflowEnabled: z.boolean().optional(),
    dynamicWorkflowMode: zcodeDynamicWorkflowModeSchema.optional(),
  })
  .strict();

export type ZCodeSessionResumeParams = z.infer<typeof zcodeSessionResumeParamsSchema>;

export const zcodeSessionListParamsSchema = z
  .object({
    workspace: zcodeWorkspaceRefSchema.optional(),
    sessionIds: z.array(nonEmptyString).min(1).max(64).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export type ZCodeSessionListParams = z.infer<typeof zcodeSessionListParamsSchema>;

export const zcodeSessionSubagentsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    endedCursor: nonEmptyString.optional(),
    endedLimit: z.number().int().positive().max(100).default(20),
  })
  .strict();

export type ZCodeSessionSubagentsParams = z.infer<typeof zcodeSessionSubagentsParamsSchema>;

export const zcodeUsageStatsParamsSchema = z
  .object({
    range: z.enum(APP_USAGE_RANGES),
    timeZone: z.string().optional(),
  })
  .strict();

export const zcodeUsageStatsResultSchema = appUsageSnapshotSchema;

export const zcodeTaskTokenUsageParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();

export const zcodeTaskTokenUsageResultSchema = z
  .object({
    sessionId: nonEmptyString,
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cacheCreationTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    modelRequestCount: z.number().int().nonnegative(),
    modelErrorCount: z.number().int().nonnegative(),
    inputBaselineBySource: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export type ZCodeTaskTokenUsageResult = z.infer<typeof zcodeTaskTokenUsageResultSchema>;

export const zcodeSessionReadParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    deliveryKind: zcodeDeliveryKindSchema.optional(),
    messageLimit: z.number().int().positive().optional(),
    afterSeq: z.number().int().nonnegative().optional(),
    // "index"：仅 task index resync 使用，返回剥离 tool/reasoning/data URL 大载荷的同结构 snapshot，
    // 结果禁止回写 UI 状态；缺省等同 "full"。
    contentProfile: z.enum(["full", "index"]).optional(),
  })
  .strict();

export type ZCodeSessionReadParams = z.infer<typeof zcodeSessionReadParamsSchema>;

export const zcodeSessionMessagesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterMessageId: nonEmptyString.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export type ZCodeSessionMessagesParams = z.infer<typeof zcodeSessionMessagesParamsSchema>;

export const zcodeSessionEventsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    afterSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export type ZCodeSessionEventsParams = z.infer<typeof zcodeSessionEventsParamsSchema>;

export const zcodeSessionRuntimePreferencesScopeSchema = z.enum([
  "runtime-materialization",
  "user-execution",
]);

export type ZCodeSessionRuntimePreferencesScope = z.infer<
  typeof zcodeSessionRuntimePreferencesScopeSchema
>;

export const zcodeSubagentsReadRuntimeConfigParamsSchema = z
  .object({ sessionId: nonEmptyString })
  .strict();

const codeIndexRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !/^[A-Za-z]:[\\/]/u.test(value) &&
      !value.split(/[\\/]+/u).includes(".."),
    "Code index paths must be workspace-relative.",
  );

const codeIndexSymbolRefSchema = z.string().trim().min(1).max(256);

const codeIndexStatusSchema = z
  .object({
    state: z.enum(["unindexed", "indexing", "ready", "degraded"]),
    partial: z.boolean().optional(),
    generation: z.number().int().nonnegative(),
    updatedAt: z.number().finite().optional(),
    counts: z
      .object({
        files: z.number().int().nonnegative(),
        chunks: z.number().int().nonnegative(),
        symbols: z.number().int().nonnegative(),
        edges: z.number().int().nonnegative(),
      })
      .strict(),
    progress: z
      .object({
        discoveredFiles: z.number().int().nonnegative(),
        indexedFiles: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    embedding: z
      .object({
        configured: z.boolean(),
        model: z.string().max(120).optional(),
        available: z.boolean(),
      })
      .strict(),
    diagnostics: z.array(z.string().max(256)).max(12),
  })
  .strict();

const codeIndexSearchResultSchema = z
  .object({
    path: codeIndexRelativePathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    symbolName: z.string().max(256).optional(),
    symbolKind: z.string().max(64).optional(),
    excerpt: z.string().max(4096),
    excerptTruncated: z.boolean().optional(),
    match: z.enum(["lexical", "semantic"]),
    score: z.number().finite().min(0).max(1),
  })
  .strict();

const codeIndexRelatedSymbolSchema = z
  .object({
    name: z.string().max(256),
    path: codeIndexRelativePathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    excerpt: z.string().max(4096).optional(),
    excerptTruncated: z.boolean().optional(),
  })
  .strict();

const codeIndexSymbolContextSchema = z
  .object({
    symbol: z
      .object({
        id: z.string().max(1200),
        name: z.string().max(256),
        kind: z.string().max(64),
        path: codeIndexRelativePathSchema,
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        excerpt: z.string().max(4096).optional(),
        excerptTruncated: z.boolean().optional(),
      })
      .strict(),
    callers: z.array(codeIndexRelatedSymbolSchema).max(100),
    dependencies: z.array(codeIndexRelatedSymbolSchema).max(100),
    partial: z.boolean(),
  })
  .strict();

const codeIndexImpactSchema = z
  .object({
    changedPaths: z.array(codeIndexRelativePathSchema).max(100),
    affectedSymbols: z
      .array(
        codeIndexRelatedSymbolSchema.extend({ distance: z.number().int().positive() }).strict(),
      )
      .max(100),
    partial: z.boolean(),
  })
  .strict();

const codeIndexTraceSchema = z
  .object({
    found: z.boolean(),
    path: z
      .array(codeIndexRelatedSymbolSchema.extend({ relation: z.string().max(64) }).strict())
      .max(256),
    partial: z.boolean(),
  })
  .strict();

const codeIndexQuerySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({
      action: z.literal("search"),
      query: z.string().trim().min(1).max(500),
      limit: z.number().int().min(1).max(12).optional(),
      lexicalOnly: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal("context"), symbol: codeIndexSymbolRefSchema }).strict(),
  z
    .object({
      action: z.literal("impact"),
      changedPaths: z.array(codeIndexRelativePathSchema).min(1).max(20),
    })
    .strict(),
  z
    .object({
      action: z.literal("trace"),
      fromSymbol: codeIndexSymbolRefSchema,
      toSymbol: codeIndexSymbolRefSchema,
    })
    .strict(),
]);

export type ZCodeCodeIndexQuery = z.infer<typeof codeIndexQuerySchema>;

export type ZCodeCodeIndexResult =
  | { action: "status"; status: z.infer<typeof codeIndexStatusSchema> }
  | {
      action: "search";
      results: z.infer<typeof codeIndexSearchResultSchema>[];
      semantic: boolean;
      partial: boolean;
    }
  | { action: "context"; context: z.infer<typeof codeIndexSymbolContextSchema> | null }
  | { action: "impact"; impact: z.infer<typeof codeIndexImpactSchema> }
  | { action: "trace"; trace: z.infer<typeof codeIndexTraceSchema> };

export const zcodeCodeIndexQueryParamsSchema = z.discriminatedUnion("action", [
  z.object({ sessionId: nonEmptyString, action: z.literal("status") }).strict(),
  z
    .object({
      sessionId: nonEmptyString,
      action: z.literal("search"),
      query: z.string().trim().min(1).max(500),
      limit: z.number().int().min(1).max(12).optional(),
      lexicalOnly: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      sessionId: nonEmptyString,
      action: z.literal("context"),
      symbol: codeIndexSymbolRefSchema,
    })
    .strict(),
  z
    .object({
      sessionId: nonEmptyString,
      action: z.literal("impact"),
      changedPaths: z.array(codeIndexRelativePathSchema).min(1).max(20),
    })
    .strict(),
  z
    .object({
      sessionId: nonEmptyString,
      action: z.literal("trace"),
      fromSymbol: codeIndexSymbolRefSchema,
      toSymbol: codeIndexSymbolRefSchema,
    })
    .strict(),
]);

/**
 * Сигнал о зафиксированных путях.
 *
 * Отдельный метод вместо расширения `query`: это команда изменения состояния кеша, а не
 * чтение. Host проверяет границы workspace и дебаунсит батч так же, как события watcher.
 */
export const zcodeCodeIndexNotifyMutatedParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    workspacePath: nonEmptyString,
    changed: z.array(z.string().min(1).max(4096)).max(4000).default([]),
    removed: z.array(z.string().min(1).max(4096)).max(4000).default([]),
  })
  .strict();

export type ZCodeCodeIndexNotifyMutatedParams = z.infer<
  typeof zcodeCodeIndexNotifyMutatedParamsSchema
>;

export const zcodeCodeIndexQueryResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), status: codeIndexStatusSchema }).strict(),
  z
    .object({
      action: z.literal("search"),
      results: z.array(codeIndexSearchResultSchema).max(12),
      semantic: z.boolean(),
      partial: z.boolean(),
    })
    .strict(),
  z
    .object({ action: z.literal("context"), context: codeIndexSymbolContextSchema.nullable() })
    .strict(),
  z.object({ action: z.literal("impact"), impact: codeIndexImpactSchema }).strict(),
  z.object({ action: z.literal("trace"), trace: codeIndexTraceSchema }).strict(),
]);

export const zcodeCodeIndexQueryTimeoutMs = 120_000;

export const ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS = 15_000;

export const zcodeSessionRequestRuntimePreferencesParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    scope: zcodeSessionRuntimePreferencesScopeSchema,
  })
  .strict();

export type ZCodeSessionRequestRuntimePreferencesParams = z.infer<
  typeof zcodeSessionRequestRuntimePreferencesParamsSchema
>;

export const DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY = "preflight-v1" as const;

// 3.12.2：legacy 仅为旧协议接收兼容；Runtime 一律归一为上面的共享默认策略。
export const zcodeModelContextBudgetStrategySchema = z.enum(["legacy", "preflight-v1"]);

export type ZCodeModelContextBudgetStrategy = z.infer<typeof zcodeModelContextBudgetStrategySchema>;

export const zcodeWorkspaceBoundaryModeSchema = z.enum(["strict", "ask", "allow"]);

export type ZCodeWorkspaceBoundaryMode = z.infer<typeof zcodeWorkspaceBoundaryModeSchema>;

export const zcodeSessionRuntimePreferencesResultSchema = z
  .object({
    additionalDirectories: z.array(nonEmptyString).max(256).optional(),
    nativeSearchEnhancementsEnabled: z.boolean(),
    toolSearchMode: appToolSearchModeSchema.default("off"),
    // Граница file-tools: неизвестный старый Host не должен молча ослаблять политику.
    workspaceBoundary: zcodeWorkspaceBoundaryModeSchema.default("allow"),
    subagentRuntimeConfigEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().default(false),
    askUserQuestionAutoResolutionEnabled: z.boolean().default(true),
    integratedTerminalShell: integratedTerminalShellSelectionSchema.optional(),
    // 兼容旧 Host：缺少字段时在协议解析边界使用当前默认策略。
    modelContextBudgetStrategy: zcodeModelContextBudgetStrategySchema.default(
      DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    ),
    // Этап 4.6: настройки новых подсистем доезжают до runtimeConfig сессии.
    // Все поля опциональны: старый Host без них продолжает работать на дефолтах.
    promptDepth: z.enum(["standard", "deep", "max_reasoning"]).optional(),
    autoRepairLoopEnabled: z.boolean().optional(),
    autoRepairLoopLimits: z
      .object({
        maxIterations: z.number().int().positive(),
        maxElapsedMs: z.number().int().positive(),
      })
      .strict()
      .optional(),
    sandboxMode: z.enum(["auto", "bwrap", "seatbelt", "off"]).optional(),
    sandboxAllowNetwork: z.boolean().optional(),
    sandboxCommandTimeoutMs: z.number().int().positive().optional(),
    subagentMaxParallel: z.number().int().nonnegative().optional(),
    codeIndexAutoStart: z.boolean().optional(),
    codeIndexVectorChannel: z.boolean().optional(),
    codeIndexTokenBudget: z.number().int().positive().optional(),
    backgroundFileTasks: z.boolean().optional(),
    chatAutocompleteEnabled: z.boolean().optional(),
    promptEnhancerEnabled: z.boolean().optional(),
  })
  .strict();

export type ZCodeSessionRuntimePreferencesResult = z.infer<
  typeof zcodeSessionRuntimePreferencesResultSchema
>;

/**
 * App 在提交 prompt 前只读采集的 IAB 可见状态。该字段只用于 provider-visible
 * ambient context，不进入用户可见 transcript；内容有界，禁止携带页面正文或凭据。
 */
export const zcodeBrowserAmbientContextSchema = z
  .object({
    tabCount: z.number().int().positive().max(100),
    currentUrl: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();

export type ZCodeBrowserAmbientContext = z.infer<typeof zcodeBrowserAmbientContextSchema>;

export const zcodeSessionSendParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    modelSelection: modelSelectionSchema.optional(),
    modelExecution: modelExecutionSchema.optional(),
    inputId: nonEmptyString.optional(),
    queryId: nonEmptyString.optional(),
    content: z.string(),
    attachments: z.array(jsonObjectSchema).optional(),
    browserAmbientContext: zcodeBrowserAmbientContextSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    expectedProviderRevision: nonEmptyString.optional(),
    automationId: nonEmptyString.optional(),
    offPeakTaskId: nonEmptyString.optional(),
    offPeakRunType: z.enum(["init", "resume"]).optional(),
    botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
    toolDenylist: z.array(nonEmptyString).optional(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.automationId && payload.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "automationId and offPeakTaskId are mutually exclusive",
      });
    }
    if (payload.offPeakRunType && !payload.offPeakTaskId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offPeakRunType requires offPeakTaskId",
        path: ["offPeakRunType"],
      });
    }
    if (payload.modelExecution && !payload.modelSelection) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "modelExecution requires modelSelection",
        path: ["modelExecution"],
      });
    }
  });

export const zcodeSessionSendResultSchema = z
  .object({
    sessionId: nonEmptyString,
    accepted: z.literal(true),
    stateRevision: z.number().int().nonnegative(),
  })
  .strict();

export type ZCodeSessionSendResult = z.infer<typeof zcodeSessionSendResultSchema>;

export const zcodeSessionHistoryTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("turn"),
      turnIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("message"),
      messageId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("checkpoint"),
      checkpointId: nonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal("latestCheckpoint"),
    })
    .strict(),
]);

export type ZCodeSessionHistoryTarget = z.infer<typeof zcodeSessionHistoryTargetSchema>;

export const zcodeSessionForkParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    target: zcodeSessionHistoryTargetSchema.default({
      kind: "latestCheckpoint",
    }),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ZCodeSessionForkParams = z.infer<typeof zcodeSessionForkParamsSchema>;

export const zcodeSessionForkResultSchema = z
  .object({
    forkedSessionId: nonEmptyString,
    parentSessionId: nonEmptyString.optional(),
    targetMessageId: nonEmptyString.optional(),
    targetCheckpointId: nonEmptyString.optional(),
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
  })
  .strict();

export type ZCodeSessionForkResult = z.infer<typeof zcodeSessionForkResultSchema>;

export const zcodeSessionCompactParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    instructions: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ZCodeSessionCompactParams = z.infer<typeof zcodeSessionCompactParamsSchema>;

export const zcodeSessionCompactResultSchema = z
  .object({
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
    compact: z
      .object({
        state: z.enum(["accepted", "already_running"]),
        inputId: nonEmptyString.optional(),
        operationId: nonEmptyString.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ZCodeSessionCompactResult = z.infer<typeof zcodeSessionCompactResultSchema>;

export const zcodeSessionGoalActionSchema = z.enum([
  "show",
  "set",
  "replace",
  "pause",
  "resume",
  "clear",
]);

export type ZCodeSessionGoalAction = z.infer<typeof zcodeSessionGoalActionSchema>;

export const zcodeSessionGoalParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    inputId: nonEmptyString.optional(),
    action: zcodeSessionGoalActionSchema,
    objective: z.string().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ZCodeSessionGoalParams = z.infer<typeof zcodeSessionGoalParamsSchema>;

export const zcodeSessionGoalResultSchema = z
  .object({
    response: z.string(),
    snapshot: zcodeSessionStateSnapshotSchema,
    startedTurn: z.boolean().optional(),
  })
  .strict();

export type ZCodeSessionGoalResult = z.infer<typeof zcodeSessionGoalResultSchema>;

export const zcodeSessionStopParamsSchema = z
  .object({
    sessionId: nonEmptyString,
  })
  .strict();

const zcodeBackgroundTaskInfoStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_error",
  "lost",
]);

export const zcodeBackgroundTaskInfoSchema = z
  .object({
    taskId: nonEmptyString,
    toolCallId: nonEmptyString.optional(),
    toolName: nonEmptyString.optional(),
    taskKind: z.enum(["bash", "subagent"]).optional(),
    blocked: z.boolean().optional(),
    blockedReason: z.string().optional(),
    cancellable: z.boolean().optional(),
    cancelRequestedAt: protocolInstantSchema.optional(),
    command: z.string().optional(),
    description: z.string().optional(),
    status: zcodeBackgroundTaskInfoStatusSchema,
    pid: z.number().int().positive().optional(),
    startedAt: protocolInstantSchema.optional(),
    completedAt: protocolInstantSchema.optional(),
    outputPath: z.string().optional(),
    stderrPersistedOutputPath: z.string().optional(),
    stdoutPersistedOutputPath: z.string().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    outputTruncated: z.boolean().optional(),
    outputTail: z.string().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    stderrTail: z.string().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stdoutTail: z.string().optional(),
    terminalId: nonEmptyString.optional(),
  })
  .strict();

export const zcodeSessionCancelBackgroundTaskParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    taskId: nonEmptyString,
  })
  .strict();

export type ZCodeSessionCancelBackgroundTaskParams = z.infer<
  typeof zcodeSessionCancelBackgroundTaskParamsSchema
>;

export const zcodeSessionCancelBackgroundTaskResultSchema = z
  .object({
    cancelled: z.boolean(),
    reason: z.string().optional(),
    snapshot: zcodeBackgroundTaskInfoSchema.optional(),
    status: zcodeBackgroundTaskInfoStatusSchema,
    taskId: nonEmptyString,
  })
  .strict();

export type ZCodeSessionCancelBackgroundTaskResult = z.infer<
  typeof zcodeSessionCancelBackgroundTaskResultSchema
>;

export const zcodeSessionSetModelParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    model: modelSelectionSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
    persistAsWorkspaceLastUsed: z.boolean().default(true),
  })
  .strict();

export type ZCodeSessionSetModelParams = z.infer<typeof zcodeSessionSetModelParamsSchema>;

export const zcodeSessionSetThoughtLevelParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    thoughtLevel: nonEmptyString.optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
    persistAsWorkspaceLastUsed: z.boolean().default(true),
  })
  .strict();

export type ZCodeSessionSetThoughtLevelParams = z.infer<
  typeof zcodeSessionSetThoughtLevelParamsSchema
>;

export const zcodeSessionSetModeParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    mode: zcodeSessionModeSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ZCodeSessionSetModeParams = z.infer<typeof zcodeSessionSetModeParamsSchema>;

export const zcodeSessionCloseParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    expectedPersistence: zcodeSessionPersistenceSchema.optional(),
  })
  .strict();

export type ZCodeSessionCloseParams = z.infer<typeof zcodeSessionCloseParamsSchema>;

export const zcodeSessionCloseResultSchema = z
  .object({
    closed: z.boolean().optional(),
  })
  .strict();

export type ZCodeSessionCloseResult = z.infer<typeof zcodeSessionCloseResultSchema>;
