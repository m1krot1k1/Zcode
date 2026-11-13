import { mobilePluginDiscoveryTelemetrySchema } from "./telemetry.js";
import {
  MAX_TELEMETRY_EVENT_DETAIL_ENTRIES,
  MAX_TELEMETRY_EVENT_DETAIL_VALUE_LENGTH,
  MAX_TELEMETRY_EVENT_TEXT_LENGTH,
  TELEMETRY_EVENT_DETAIL_ALLOWLIST,
} from "./telemetry.js";
import { databaseStartupControlSchema, databaseStartupStateSchema } from "./database-startup.js";
import { mcpAppInstanceSchema } from "./mcp-apps/instance.js";
import {
  automationSessionCreateTelemetrySchema,
  sessionCreateTelemetrySchema,
} from "./sessionCreateTelemetry.js";
import { z } from "zod";
import { networkCaptureControlSchema, networkCaptureBatchSchema } from "./networkCapture.js";
import { browserCommandSchema } from "./browser-use/commands.js";
import { browserCommandResultSchema } from "./browser-use/result.js";
import { modelSelectionSchema } from "./model-selection.js";
import { localeSchema } from "./validationAppSettings.js";
import { zcodeProcessDiagnosticSchema } from "./process-diagnostic.js";
import { PROCESS_RESOURCE_CLI_LANES } from "./processResourceTelemetry.js";
import {
  providerProvisioningErrorCodeSchema,
  providerProvisioningTriggerSchema,
} from "./provider-provisioning.js";
import { zcodeProviderSchema } from "./providers.js";
import { REMOTE_ASSET_INSTALL_MODES } from "./remoteAssetInstallMode.js";
import { isKnownRemoteResourcePackageId } from "./remoteResourcePackages.js";
import type { WebRemoteControlAppPayload } from "./web-remote-control.js";
import { PROTOCOL_V4_LIMITS } from "./zcode-protocol-v4/core.js";
import { sourceServerArtifactPolicySchema } from "./source-server/release.js";
import {
  webRemoteControlRpcTransportAckSchema,
  webRemoteControlRpcTransportFrameSchema,
} from "./web-remote-control-rpc-transport.js";
import {
  taskOwnerCommandDeliverySchema,
  taskOwnerCommandRequestSchema,
  taskOwnerCommandResultSchema,
  taskRealtimeDeliveredEventSchema,
  taskRealtimeEventSchema,
  taskRealtimeHostDeliveryKindSchema,
  taskRunLeaseAcquireRequestSchema,
  taskRunLeaseResultSchema,
  taskRunLeaseTargetSchema,
  taskStreamMirrorPublishOpSchema,
  taskStreamMirrorTargetSchema,
} from "./task-realtime-core.js";
import { wslUserSchema } from "./wslUserValidation.js";
import { legacyZCodeProviderSchema } from "./zcode-agent-policy.js";
import { errorAttributionSchema } from "./zcode-protocol-v4/snapshot.js";
import {
  zcodeMcpResourceSamplesSchema,
  zcodeMcpTelemetryEventSchema,
  zcodeProcessResourceSampleSchema,
  zcodeToolExecResourceSchema,
} from "./zcode-protocol/index.js";
import { zcodeTaskModeSchema } from "./zcode-task-mode-schema.js";
import {
  broadcastMessageSchema,
  dockerConnectOptionsSchema,
  hostAgentWarmupTargetSchema,
  hostMcpTelemetryResponseSchema,
  hostSessionCreateTelemetryResponseSchema,
  hostToolExecResourceResponseSchema,
  networkObservationSchema,
  nodeSelfResourceSampleSchema,
  nonEmptyStringSchema,
  processResourceCliLaneSchema,
  remoteAssetDirsSchema,
  rendererHeapSampleSchema,
  resourceTelemetryEnvironmentKeySchema,
  serverConnectOptionsSchema,
  sessionMessageDeliveryResultSchema,
  sessionMessageRequestSchema,
  sessionRouteSchema,
  sshConnectOptionsSchema,
  telemetryRendererContextSchema,
  webRemoteControlTransportIdSchema,
  webRemoteControlWorkspaceTargetSchema,
  windowHostAttachmentScopeSchema,
  wslConnectOptionsSchema,
  zcodePersistedFileSnapshotSchema,
  zcodePersistedMessagePartSchema,
  zcodePersistedToolCallSchema,
  zcodePromptFileAttachmentSchema,
  zcodePromptImageAttachmentSchema,
  zcodePromptPdfAttachmentSchema,
  zcodePromptVideoAttachmentSchema,
  zcodeTaskGoalStatusSchema,
  zcodeTaskSessionBindingStateSchema,
  zcodeTaskTargetChangedActionSchema,
  zcodeTaskTargetChangedSourceSchema,
} from "./shared-validation-part1.js";

// Часть 2/3 модуля shared-validation: вынесено по лимиту строк.

/** 手机只提交项目意图；实际目录和远端 scope 必须由窗口 Host 准备。 */
export const hostPrepareProjectWorkspaceMessageSchema = z
  .object({
    type: z.literal("prepare-project-workspace"),
    requestId: nonEmptyStringSchema,
    clientMode: z.literal("web-remote-replayable"),
    projectId: nonEmptyStringSchema.nullable().optional(),
    hostId: nonEmptyStringSchema.optional(),
    draftId: z.string().uuid().optional(),
    reuseDraft: z.boolean().optional(),
    task: z
      .object({ taskId: nonEmptyStringSchema, workspaceKey: nonEmptyStringSchema })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (request) => (request.task ? request.projectId === undefined : request.projectId !== undefined),
    "Exactly one task or draft intent is required",
  )
  .refine(
    (request) =>
      (!request.draftId || request.projectId === null) &&
      (!request.reuseDraft || Boolean(request.draftId)),
    "Only an unclassified draft can reuse its directory",
  );

export const hostResourceUsageSnapshotRequestMessageSchema = z
  .object({
    type: z.literal("resource-usage-snapshot-request"),
    requestId: nonEmptyStringSchema,
  })
  .strict();

export const hostRemoteWorkspaceContextBoundResponseSchema = z
  .object({
    type: z.literal("remote-workspace-context-bound"),
    requestId: nonEmptyStringSchema,
    // Desktop tab rekey only；手机 replayable attachment 不消费该提示。
    previousWorkspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();

export const hostRemoteWorkspaceContextBindFailedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-context-bind-failed"),
    requestId: nonEmptyStringSchema,
    error: nonEmptyStringSchema,
    reasonCode: nonEmptyStringSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict();

export const hostRemoteWorkspaceConnectionLogResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connection-log"),
    requestId: nonEmptyStringSchema,
    level: z.enum(["info", "warn", "error"]),
    message: nonEmptyStringSchema,
  })
  .strict();

export const hostRemoteWorkspaceConnectFailedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connect-failed"),
    requestId: nonEmptyStringSchema,
    error: nonEmptyStringSchema,
    reasonCode: nonEmptyStringSchema.optional(),
    retryable: z.boolean().optional(),
    profileId: z.string().uuid().optional(),
    resolvedWslTarget: z
      .object({
        kind: z.literal("wsl"),
        distro: nonEmptyStringSchema,
        user: wslUserSchema.refine((value) => value.length > 0),
      })
      .strict()
      .optional(),
  })
  .strict();

export const hostRemoteWorkspaceClosedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-closed"),
    remoteSessionId: nonEmptyStringSchema,
    reason: z.enum(["connection-closed", "disposed", "connect-cancelled"]),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    error: z.string().optional(),
    recoverable: z.boolean().optional(),
    recoveryAttempt: z.number().int().positive().optional(),
    recoveryLimit: z.number().int().positive().optional(),
    recoveryBudgetExhausted: z.boolean().optional(),
    reasonCode: nonEmptyStringSchema.optional(),
    retryable: z.boolean().optional(),
  })
  .strict();

export const hostAgentProcessSpawnedResponseSchema = z.object({
  type: z.literal("agent-process-spawned"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  command: z.string(),
  args: z.array(z.string()),
  startedAt: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().positive().optional(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
});

export const hostAgentProcessReadyResponseSchema = z.object({
  type: z.literal("agent-process-ready"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  readyAt: z.number().int().nonnegative(),
  startupDurationMs: z.number().int().nonnegative(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema,
});

export const hostAgentProcessExitedResponseSchema = z.object({
  type: z.literal("agent-process-exited"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  endedAt: z.number().int().nonnegative(),
  terminationKind: z.enum(["expected", "unexpected", "watchdog_recycle"]),
  terminationReason: z.string().optional(),
  /** rolling-upgrade 兼容：旧 Host 缺字段时 desktop 映射 crash_phase=unknown。 */
  runtimeReady: z.boolean().optional(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
  uptimeMs: z.number().int().nonnegative(),
  stderrLineCount: z.number().int().nonnegative(),
  stderrTail: z.array(z.string().max(1_100)).max(20).optional(),
});

export const hostAgentProcessErrorResponseSchema = z.object({
  type: z.literal("agent-process-error"),
  /** 进程泳道（mcp-status 等），旧 Host 不带该字段。 */
  lane: nonEmptyStringSchema.optional(),
  pid: z.number().int().positive().nullable(),
  provider: zcodeProviderSchema,
  workspacePath: nonEmptyStringSchema,
  command: z.string(),
  args: z.array(z.string()),
  errorName: nonEmptyStringSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string(),
  errorStack: z.string().optional(),
  runtimeGeneration: z.number().int().positive(),
  runtimeInstanceId: nonEmptyStringSchema.optional(),
  occurredAt: z.number().int().nonnegative(),
});

export const hostAgentProcessExceptionResponseSchema = z
  .object({
    type: z.literal("agent-process-exception"),
    lane: nonEmptyStringSchema.optional(),
    pid: z.number().int().positive(),
    provider: zcodeProviderSchema,
    workspacePath: nonEmptyStringSchema,
    runtimeGeneration: z.number().int().positive(),
    runtimeInstanceId: nonEmptyStringSchema,
    diagnostic: zcodeProcessDiagnosticSchema,
  })
  .strict();

export const agentLaneResourceSampleSchema = zcodeProcessResourceSampleSchema
  .extend({ lane: processResourceCliLaneSchema.optional() })
  .strict();

export type NodeSelfResourceSample = z.infer<typeof nodeSelfResourceSampleSchema>;

export type RendererHeapSample = z.infer<typeof rendererHeapSampleSchema>;

export const hostResourceSampleResponseSchema = z
  .object({
    type: z.literal("host-resource-sample"),
    sample: nodeSelfResourceSampleSchema,
  })
  .strict();

export const hostMcpResourceSamplesResponseSchema = z
  .object({
    type: z.literal("mcp-resource-samples"),
    runtimeSurface: z.enum(["local", "remote"]),
    environmentKey: resourceTelemetryEnvironmentKeySchema.optional(),
    samples: zcodeMcpResourceSamplesSchema,
  })
  .strict();

export type HostToolExecResourceResponse = z.infer<typeof hostToolExecResourceResponseSchema>;

export type HostMcpTelemetryResponse = z.infer<typeof hostMcpTelemetryResponseSchema>;

export type HostSessionCreateTelemetryResponse = z.infer<
  typeof hostSessionCreateTelemetryResponseSchema
>;

export const hostWorkspaceRunningTaskCountChangedResponseSchema = z.object({
  type: z.literal("workspace-running-task-count-changed"),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  runningTaskCount: z.number().int().nonnegative(),
});

export const hostCuaOperationStateResponseSchema = z
  .object({
    type: z.literal("cua-operation-state"),
    active: z.boolean(),
    sessionId: nonEmptyStringSchema,
    turnId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
  })
  .strict();

export const hostBroadcastClaimRequestResponseSchema = z.object({
  type: z.literal("broadcast-claim-request"),
  requestId: nonEmptyStringSchema,
  key: nonEmptyStringSchema.max(1_024),
});

export const hostBroadcastClaimCommitResponseSchema = z.object({
  type: z.literal("broadcast-claim-commit"),
  key: nonEmptyStringSchema.max(1_024),
  claimToken: nonEmptyStringSchema,
});

export const hostBroadcastClaimReleaseResponseSchema = z.object({
  type: z.literal("broadcast-claim-release"),
  key: nonEmptyStringSchema.max(1_024),
  claimToken: nonEmptyStringSchema,
});

export const hostFeedbackLogArchiveRequestResponseSchema = z.object({
  type: z.literal("feedback-log-archive-request"),
  requestId: nonEmptyStringSchema,
  sourceDir: nonEmptyStringSchema,
});

// host → main：定时任务派发结果。ok=已成功创建 session 且 prompt 已发出。
export const hostCronRunResultResponseSchema = z.object({
  type: z.literal("cron-run-result"),
  runId: nonEmptyStringSchema,
  ok: z.boolean(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  failureKind: z.enum(["transient", "permanent"]).optional(),
});

// host → main：闲时任务派发结果。ok=session 已确保存在且 prompt 已发出；迟到结果用 offPeakTaskId 兜底结算。
export const hostOffPeakRunResultResponseSchema = z.object({
  type: z.literal("off-peak-run-result"),
  offPeakTaskId: nonEmptyStringSchema,
  ok: z.boolean(),
  /** Host 已在开放 CLI 生命周期事件前完成接纳落库；调度器只清理退避。 */
  lifecycleManaged: z.literal(true).optional(),
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.string().optional(),
  failureKind: z.enum(["transient", "permanent"]).optional(),
});

// host → main：manual run 落库后的 scheduler 唤醒请求；业务数据仍由 scheduler 从 sqlite 读取。
export const hostCronSchedulerWakeRequestResponseSchema = z.object({
  type: z.literal("cron-scheduler-wake-request"),
  automationId: nonEmptyStringSchema,
});

// host → main：执行一条 browser-use 命令（main 用 WebContentsView+CDP 执行）。
export const hostBrowserExecuteRequestResponseSchema = z.object({
  type: z.literal("browser-execute-request"),
  requestId: nonEmptyStringSchema,
  // 迁移兼容：旧 host bundle 没有 browserId/context；新 browser-client 链路始终携带。
  browserId: nonEmptyStringSchema.optional(),
  browserGeneration: z.number().int().nonnegative().optional(),
  sessionId: nonEmptyStringSchema,
  turnId: nonEmptyStringSchema.optional(),
  workspaceKey: nonEmptyStringSchema.optional(),
  workspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  remoteSessionId: nonEmptyStringSchema.optional(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]).optional(),
  sessionContext: z.enum(["live", "cached"]).optional(),
  command: browserCommandSchema,
});

export const hostLocalMediaPreviewPathAuthorizeRequestResponseSchema = z
  .object({
    type: z.literal("local-media-preview-path-authorize-request"),
    requestId: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
  })
  .strict();

/** host → main：登记已校验的插件 UI HTML。 */
export const hostPluginSandboxRegisterRequestResponseSchema = z
  .object({
    type: z.literal("plugin-sandbox-register-request"),
    instance: mcpAppInstanceSchema,
    requestId: nonEmptyStringSchema,
    workspacePath: z.string().optional(),
    workspaceIdentity: z.string().optional(),
    ownerWebContentsId: z.number().int().nonnegative(),
    sessionId: nonEmptyStringSchema,
    contentKind: z.literal("gen-ui").optional(),
    pluginId: nonEmptyStringSchema.optional(),
    // 资源所属 MCP server 运行时名：沙箱 partition 按它派生。
    serverName: nonEmptyStringSchema.optional(),
    // 沙箱作用域 id（`tool:<toolCallId>` / `surface:<surfaceId>`），main 只当不透明字符串。
    scopeId: nonEmptyStringSchema,
    html: z.string(),
    // MCP Apps 资源级 CSP 的四类域；与 mcp-apps 的 mcpToolUiCspSchema 同步。
    csp: z
      .object({
        connectDomains: z.array(z.string()).optional(),
        resourceDomains: z.array(z.string()).optional(),
        frameDomains: z.array(z.string()).optional(),
        baseUriDomains: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    // 资源级 `_meta["zcode/csp"]` 放宽项；与 mcp-apps 的 mcpAppCspRelaxationsSchema 同步。
    cspRelaxations: z
      .object({ unsafeEval: z.boolean().optional(), wasmUnsafeEval: z.boolean().optional() })
      .strict()
      .optional(),
    // 资源级 `_meta.ui.permissions`（规范四键）；与 mcp-apps 的 MCP_APPS_RESOURCE_PERMISSIONS 同步。
    permissions: z
      .array(z.enum(["camera", "microphone", "geolocation", "clipboardWrite"]))
      .optional(),
    prefersBorder: z.boolean().optional(),
    // 资源级尺寸提示，main 原样放进句柄的 resourceMeta。strict schema：改 PluginSandboxRegisterRequestPayload 必须同步这里。
    heightHint: z.number().int().positive().optional(),
    minFrameHeight: z.number().int().positive().optional(),
    showInline: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.contentKind === "gen-ui"
        ? !value.pluginId && !value.serverName && !value.permissions?.length
        : Boolean(value.pluginId && value.serverName),
    "Invalid sandbox provenance",
  );

export const hostNetworkTelemetryBatchResponseSchema = z.object({
  type: z.literal("network-telemetry-batch"),
  observations: z.array(networkObservationSchema).max(500),
});

export const hostProviderProvisioningExecutionResultResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-execution-result"),
    requestId: nonEmptyStringSchema,
    environmentKey: nonEmptyStringSchema,
    status: z.enum(["applied", "already-applied", "unsupported", "failed", "rollback_failed"]),
    error: z.string().optional(),
    errorCode: providerProvisioningErrorCodeSchema.optional(),
  })
  .strict();

export const hostResourceUsageProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    name: nonEmptyStringSchema,
    category: z.enum(["base", "builtin-plugin", "community-plugin"]),
    groupKey: nonEmptyStringSchema,
    groupLabel: nonEmptyStringSchema,
    cpuPercent: z.number().finite().nonnegative(),
    memoryBytes: z.number().finite().nonnegative(),
  })
  .strict();

export const zcodePromptAttachmentSchema = z.discriminatedUnion("kind", [
  zcodePromptImageAttachmentSchema,
  zcodePromptVideoAttachmentSchema,
  zcodePromptPdfAttachmentSchema,
  zcodePromptFileAttachmentSchema,
]);

export const zcodeTaskGoalSchema = z.object({
  sessionID: nonEmptyStringSchema,
  targetID: nonEmptyStringSchema,
  objective: nonEmptyStringSchema,
  // 2.15.0 之前的 /goal 历史任务没有写 summaryTitle。
  // 读取 task index 老数据时要补成 null，否则整个任务列表会被运行时 schema 拒绝。
  summaryTitle: z.string().min(1).nullable().default(null),
  status: zcodeTaskGoalStatusSchema,
  tokenBudget: z.number().int().positive().nullable(),
  tokensUsed: z.number().int().nonnegative(),
  timeUsedSeconds: z.number().int().nonnegative(),
  activeInputId: nonEmptyStringSchema.nullable().optional(),
  activeRunStartedAtMs: z.number().int().nonnegative().nullable().optional(),
  activeRunLastSeenAtMs: z.number().int().nonnegative().nullable().optional(),
  time: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
  }),
});

export const zcodeTaskSessionBindingSchema = z.object({
  // 绑定状态由 services 从持久化数据投影；旧绑定残留的历史 provider 值在此归一为 glm。
  provider: legacyZCodeProviderSchema,
  sessionId: nonEmptyStringSchema,
  // 绑定锚点需要支持空 task 的 -1，所以这里不能套 nonnegative。
  lastSyncedTurnIndex: z.number().int(),
  state: zcodeTaskSessionBindingStateSchema,
});

export const zcodeTaskIndexEntrySchema = z.object({
  workspaceHash: nonEmptyStringSchema,
  taskId: nonEmptyStringSchema,
});

export const zcodePersistedFileChangeSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  snapshots: z.array(zcodePersistedFileSnapshotSchema),
  fileState: z.enum(["applied", "reverted"]).optional(),
});

export const zcodePersistedTurnCheckpointSchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  baseFileCheckpointId: nonEmptyStringSchema,
  resultFileCheckpointId: nonEmptyStringSchema.optional(),
});

export const webRemoteControlWorkspaceTargetsSchema = z.array(
  webRemoteControlWorkspaceTargetSchema,
);

export const webRemoteControlExternalWorkspaceBridgeSchema = z.discriminatedUnion("kind", [
  z.object({
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    kind: z.literal("local"),
    workspaceKey: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    initialTaskId: nonEmptyStringSchema.optional(),
  }),
  z.object({
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    kind: z.literal("remote"),
    workspaceKey: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    remoteSessionId: nonEmptyStringSchema,
    initialTaskId: nonEmptyStringSchema.optional(),
    capabilities: z.object({ windowProjectDirectory: z.literal(true).optional() }).optional(),
  }),
]);

export const remoteTargetSchema = z.discriminatedUnion("kind", [
  sshConnectOptionsSchema,
  wslConnectOptionsSchema,
  dockerConnectOptionsSchema,
  serverConnectOptionsSchema,
]);

export const rendererTelemetryEventPayloadSchema = z.object({
  context: telemetryRendererContextSchema,
  elementName: nonEmptyStringSchema,
  eventRegion: nonEmptyStringSchema,
  eventType: nonEmptyStringSchema,
  eventText: z.string().max(MAX_TELEMETRY_EVENT_TEXT_LENGTH).optional(),
  eventExtraDetail: z
    .record(z.string().max(64), z.string().max(MAX_TELEMETRY_EVENT_DETAIL_VALUE_LENGTH))
    .refine((detail) => Object.keys(detail).length <= MAX_TELEMETRY_EVENT_DETAIL_ENTRIES, {
      message: "too many telemetry detail entries",
    })
    .refine(
      (detail) => Object.keys(detail).every((key) => TELEMETRY_EVENT_DETAIL_ALLOWLIST.has(key)),
      { message: "telemetry detail key is not allowlisted" },
    ),
  userId: z.string().optional(),
  talkId: z.string().optional(),
  messageId: z.string().optional(),
});

export const hostInitLocalMessageSchema = z.object({
  type: z.literal("init-local"),
  databaseStartupId: z.string().min(1).max(128).optional(),
  hostId: nonEmptyStringSchema.optional(),
  deliveryKind: taskRealtimeHostDeliveryKindSchema.optional(),
  deviceMid: z.string().optional(),
  feedbackApiBase: z.string().url().optional(),
  workspacePath: nonEmptyStringSchema.optional(),
  workspaceIdentity: nonEmptyStringSchema.optional(),
  // 启动只预热 active workspace（desktop STARTUP_AGENT_WARMUP_LIMIT = 1），协议层同步收紧上限。
  agentWarmupTargets: z.array(hostAgentWarmupTargetSchema).max(1).optional(),
  agentSpawnFallbackCwd: nonEmptyStringSchema.optional(),
  remoteAssets: remoteAssetDirsSchema.optional(),
  /** spawn 时刻 Main 的实时界面语言；后续变化由 application-locale-changed 推送。 */
  locale: localeSchema.optional(),
  zcodeBuiltinProviderConfigFilePath: nonEmptyStringSchema,
  runtimeProcessEnvPatch: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
    .optional(),
});

export type WindowHostAttachmentScope = z.infer<typeof windowHostAttachmentScopeSchema>;

export const hostAttachServicePortMessageSchema = z
  .object({
    type: z.literal("attach-service-port"),
    // main 只能声明 attachment 来源；connectionId 仍由 host process 分配。
    // desktop reload/remote reattach 必须显式 continuous，手机 shared-host 必须 replayable。
    requestId: nonEmptyStringSchema,
    attachmentId: nonEmptyStringSchema,
    clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
    scope: windowHostAttachmentScopeSchema,
  })
  .strict();

export const hostBroadcastEnvelopeSchema = z.object({
  type: z.literal("broadcast"),
  message: broadcastMessageSchema,
});

export const hostSessionMessageDeliverMessageSchema = z.object({
  type: z.literal("session-message-deliver"),
  request: sessionMessageRequestSchema,
});

export const hostSessionMessageDeliveryResultMessageSchema = z.object({
  type: z.literal("session-message-delivery-result"),
  result: sessionMessageDeliveryResultSchema,
});

export type HostProjectWorkspaceNavigationInput = Pick<
  z.infer<typeof hostPrepareProjectWorkspaceMessageSchema>,
  "projectId" | "hostId" | "task" | "draftId" | "reuseDraft"
>;

export type HostResourceUsageSnapshotRequestMessage = z.infer<
  typeof hostResourceUsageSnapshotRequestMessageSchema
>;

export type HostAgentProcessSpawnedResponse = z.infer<typeof hostAgentProcessSpawnedResponseSchema>;

export type HostAgentProcessReadyResponse = z.infer<typeof hostAgentProcessReadyResponseSchema>;

export type HostAgentProcessExitedResponse = z.infer<typeof hostAgentProcessExitedResponseSchema>;

export type HostAgentProcessErrorResponse = z.infer<typeof hostAgentProcessErrorResponseSchema>;

export type HostAgentProcessExceptionResponse = z.infer<
  typeof hostAgentProcessExceptionResponseSchema
>;

export type AgentLaneResourceSample = z.infer<typeof agentLaneResourceSampleSchema>;

export const hostAgentResourceSampleResponseSchema = z
  .object({
    type: z.literal("agent-resource-sample"),
    runtimeSurface: z.enum(["local", "remote"]),
    environmentKey: resourceTelemetryEnvironmentKeySchema.optional(),
    sample: agentLaneResourceSampleSchema,
  })
  .strict();

export type HostResourceSampleResponse = z.infer<typeof hostResourceSampleResponseSchema>;

export type HostMcpResourceSamplesResponse = z.infer<typeof hostMcpResourceSamplesResponseSchema>;

export type HostCuaOperationStateResponse = z.infer<typeof hostCuaOperationStateResponseSchema>;

export const hostSessionMessageSendRequestedResponseSchema = z.object({
  type: z.literal("session-message-send-requested"),
  request: sessionMessageRequestSchema,
});

export const hostSessionRouteAnnounceResponseSchema = z.object({
  type: z.literal("session-route-announce"),
  route: sessionRouteSchema,
});

export const hostSessionMessageDeliverResultResponseSchema = z.object({
  type: z.literal("session-message-deliver-result"),
  result: sessionMessageDeliveryResultSchema,
});

export const hostResourceUsageSnapshotResultResponseSchema = z
  .object({
    type: z.literal("resource-usage-snapshot-result"),
    requestId: nonEmptyStringSchema,
    sampledAt: z.number().int().nonnegative(),
    processes: z.array(hostResourceUsageProcessSchema).max(10_000),
  })
  .strict();

export const zcodePersistedMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
  model: z.string().optional(),
  characterCount: z.number().int().nonnegative().optional(),
  // assistant 历史耗时已经在服务层落盘为 durationMs，
  // 但校验 schema 没同步，saveTask/getTaskSnapshot 解析时会把它静默剥掉，
  // 导致新消息结束后 UI 仍然只能看到“Worked”。这里补上字段以保留持久化值。
  durationMs: z.number().int().nonnegative().optional(),
  interrupted: z.boolean().optional(),
  feedback: z.enum(["like", "dislike"]).optional(),
  attachments: z.array(zcodePromptAttachmentSchema).optional(),
  tools: z.array(zcodePersistedToolCallSchema).optional(),
  thought: z.string().optional(),
  parts: z.array(zcodePersistedMessagePartSchema).optional(),
  checkpointState: z.enum(["partial"]).optional(),
  checkpointReason: z.enum(["tool_completed", "part_boundary", "periodic"]).optional(),
  checkpointUpdatedAt: z.number().int().nonnegative().optional(),
  turnIndex: z.number().int().nonnegative().optional(),
  // snapshot 按需加载依赖 bodyRefs（content/thought -> refId）定位完整内容；
  // 若 schema 缺字段，Zod 会在解析 session 文件时静默剥离，导致“加载完整内容”功能失效。
  bodyRefs: z
    .array(
      z.object({
        field: z.enum(["content", "thought"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  toolSlice: z
    .object({
      persistedMessageIndex: z.number().int().nonnegative(),
      totalTools: z.number().int().nonnegative(),
      startToolIndex: z.number().int().nonnegative(),
      endToolIndexExclusive: z.number().int().nonnegative(),
    })
    .optional(),
});

export const zcodeTaskGoalChangedPatchSchema = z.object({
  action: zcodeTaskTargetChangedActionSchema,
  source: zcodeTaskTargetChangedSourceSchema,
  target: zcodeTaskGoalSchema.nullable(),
  previousTarget: zcodeTaskGoalSchema.nullable().optional(),
});
