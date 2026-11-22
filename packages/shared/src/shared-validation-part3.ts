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
  zcodeTurnStateTransitionRecordSchema,
} from "./zcode-protocol/index.js";
import { zcodeTaskModeSchema } from "./zcode-task-mode-schema.js";
import { hostAgentRunningTaskCountChangedResponseSchema, hostApplicationLocaleChangedMessageSchema, hostBindRemoteWorkspaceContextMessageSchema, hostBroadcastClaimResultMessageSchema, hostBrowserExecuteResultMessageSchema, hostCancelRemoteWorkspaceBindMessageSchema, hostCancelRemoteWorkspaceConnectMessageSchema, hostCronRunMessageSchema, hostCuaPipFocusChangedMessageSchema, hostDetachServicePortMessageSchema, hostDisposeMessageSchema, hostDisposeRemoteWorkspaceSessionMessageSchema, hostFeedbackLogArchiveResultMessageSchema, hostLocalMediaPreviewPathAuthorizeResultMessageSchema, hostLogResponseSchema, hostMcpTelemetryResponseSchema, hostOffPeakRunMessageSchema, hostOffPeakSchedulerWakeRequestResponseSchema, hostPluginSandboxRegisterResultMessageSchema, hostProviderProvisioningExecuteMessageSchema, hostProviderProvisioningSourceChangedResponseSchema, hostSessionCreateTelemetryResponseSchema, hostTaskOwnerCommandDeliverMessageSchema, hostTaskOwnerCommandRequestResponseSchema, hostTaskOwnerCommandResultMessageSchema, hostTaskOwnerCommandResultResponseSchema, hostTaskRealtimeDeliverMessageSchema, hostTaskRealtimePublishResponseSchema, hostTaskRunLeaseAcquireResponseSchema, hostTaskRunLeaseReleaseResponseSchema, hostTaskRunLeaseResultMessageSchema, hostTaskStreamOpPublishResponseSchema, hostToolExecResourceResponseSchema, nonEmptyStringSchema, remoteAssetDirsSchema, webRemoteControlFailureReasonSchema, webRemoteControlMobileDeviceInfoSchema, webRemoteControlMobileTaskViewSchema, webRemoteControlMobileViewStateSchema, webRemoteControlPlatformMethodSchema, webRemoteControlTransportIdSchema, zcodeTaskMigrationSourceSchema, zcodeTaskPersistStatusSchema } from "./shared-validation-part1.js";
import { hostAgentProcessErrorResponseSchema, hostAgentProcessExceptionResponseSchema, hostAgentProcessExitedResponseSchema, hostAgentProcessReadyResponseSchema, hostAgentProcessSpawnedResponseSchema, hostAgentResourceSampleResponseSchema, hostAttachServicePortMessageSchema, hostBroadcastClaimCommitResponseSchema, hostBroadcastClaimReleaseResponseSchema, hostBroadcastClaimRequestResponseSchema, hostBroadcastEnvelopeSchema, hostBrowserExecuteRequestResponseSchema, hostCronRunResultResponseSchema, hostCronSchedulerWakeRequestResponseSchema, hostCuaOperationStateResponseSchema, hostFeedbackLogArchiveRequestResponseSchema, hostInitLocalMessageSchema, hostLocalMediaPreviewPathAuthorizeRequestResponseSchema, hostMcpResourceSamplesResponseSchema, hostNetworkTelemetryBatchResponseSchema, hostOffPeakRunResultResponseSchema, hostPluginSandboxRegisterRequestResponseSchema, hostPrepareProjectWorkspaceMessageSchema, hostProviderProvisioningExecutionResultResponseSchema, hostRemoteWorkspaceClosedResponseSchema, hostRemoteWorkspaceConnectFailedResponseSchema, hostRemoteWorkspaceConnectionLogResponseSchema, hostRemoteWorkspaceContextBindFailedResponseSchema, hostRemoteWorkspaceContextBoundResponseSchema, hostResourceSampleResponseSchema, hostResourceUsageSnapshotRequestMessageSchema, hostResourceUsageSnapshotResultResponseSchema, hostSessionMessageDeliverMessageSchema, hostSessionMessageDeliverResultResponseSchema, hostSessionMessageDeliveryResultMessageSchema, hostSessionMessageSendRequestedResponseSchema, hostSessionRouteAnnounceResponseSchema, hostWorkspaceRunningTaskCountChangedResponseSchema, remoteTargetSchema, rendererTelemetryEventPayloadSchema, webRemoteControlExternalWorkspaceBridgeSchema, webRemoteControlWorkspaceTargetsSchema, zcodePersistedFileChangeSchema, zcodePersistedMessageSchema, zcodePersistedTurnCheckpointSchema, zcodeTaskGoalSchema, zcodeTaskIndexEntrySchema } from "./shared-validation-part2.js";

// Часть 3/3 модуля shared-validation: вынесено по лимиту строк.

export const zcodeTaskMetaSchema = z.object({
  taskId: nonEmptyStringSchema,
  traceId: nonEmptyStringSchema,
  title: z.string(),
  titleOverridden: z.boolean().optional(),
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  workspacePurpose: z.enum(["project", "conversation"]).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  mode: zcodeTaskModeSchema,
  model: z.string().optional(),
  thoughtLevel: nonEmptyStringSchema.optional(),
  runtimeEpoch: z.number().int().nonnegative().optional(),
  // meta 直接解析自 tasks-index/旧 session 文件；历史 provider 值在此归一为 glm。
  provider: legacyZCodeProviderSchema.optional(),
  migrationSource: zcodeTaskMigrationSourceSchema.optional(),
  forkedFromTaskId: nonEmptyStringSchema.optional(),
  // cron automation 身份：随 meta_json 一起持久化（单一来源），同时在写入时投影到 tasks 表
  // cron_automation_id 索引列，供按 automation 反查 session。runId 属于 automation_runs /
  // 投递 metadata，不属于 task 表。
  cronAutomationId: nonEmptyStringSchema.optional(),
  // off-peak 身份：与 cron 同款持久化策略——meta_json 单一来源 + tasks 表
  // off_peak_task_id 索引投影列（兜底/反查）。
  offPeakTaskId: nonEmptyStringSchema.optional(),
  unreadAt: z.number().int().nonnegative().optional(),
  status: zcodeTaskPersistStatusSchema.optional(),
  lastError: z
    .object({
      code: z.string().optional(),
      detail: z.string().optional(),
      message: z.string().min(1),
      traceId: nonEmptyStringSchema.optional(),
      taskId: nonEmptyStringSchema.optional(),
      attribution: errorAttributionSchema.optional(),
    })
    .optional(),
  repairState: z
    .object({
      claudeNativeSnapshotAssistantContentVersion: z.number().int().nonnegative().optional(),
      codexNativeSnapshotSubagentToolsVersion: z.number().int().nonnegative().optional(),
    })
    .optional(),
  changeSummary: z
    .object({
      fileCount: z.number().int().nonnegative(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      files: z.array(
        z.object({
          path: z.string(),
          added: z.number().int().nonnegative(),
          removed: z.number().int().nonnegative(),
          writeCount: z.number().int().positive(),
          lastTurnIndex: z.number().int().nonnegative(),
        }),
      ),
    })
    .optional(),
  target: zcodeTaskGoalSchema.nullable().optional(),
});

export const zcodePinnedTasksFileSchema = z.object({
  version: z.literal("1"),
  tasks: z.array(zcodeTaskIndexEntrySchema),
});

export const webRemoteControlWindowBootstrapResultSchema = z.object({
  windowControlSessionId: nonEmptyStringSchema,
  desktopAppVersion: nonEmptyStringSchema.optional(),
  workspaces: webRemoteControlWorkspaceTargetsSchema,
  initialViewState: webRemoteControlMobileViewStateSchema.optional(),
  mobileViewState: webRemoteControlMobileViewStateSchema.optional(),
  mobileTaskViewEpoch: webRemoteControlTransportIdSchema.optional(),
});

export const webRemoteControlWorkspaceListResultSchema = z.object({
  workspaces: webRemoteControlWorkspaceTargetsSchema,
  activeWorkspaceKey: nonEmptyStringSchema.optional(),
  activeTaskId: nonEmptyStringSchema.optional(),
});

export const windowHostRemoteWorkspaceDescriptorSchema = z
  .object({
    /** 本次请求直接复用的在线连接；只包含脱敏目标，不是 session 持久状态。 */
    reusedConnectionTarget: remoteTargetSchema.optional(),
    sourceServerId: nonEmptyStringSchema.optional(),
    remoteSessionId: nonEmptyStringSchema,
    target: remoteTargetSchema,
    workspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    generation: z.number().int().positive(),
  })
  .strict();

export const hostConnectRemoteWorkspaceMessageSchema = z
  .object({
    type: z.literal("connect-remote-workspace"),
    requestId: nonEmptyStringSchema,
    target: remoteTargetSchema,
    remoteAssets: remoteAssetDirsSchema,
    workspacePath: nonEmptyStringSchema.optional(),
    workspaceIdentity: nonEmptyStringSchema.optional(),
    confirmSourceServerInstall: z.boolean().optional(),
  })
  .strict();

export type HostAgentResourceSampleResponse = z.infer<typeof hostAgentResourceSampleResponseSchema>;

export const hostPluginTelemetryResponseSchema = z
  .object({
    type: z.literal("plugin-telemetry"),
    event: rendererTelemetryEventPayloadSchema.refine((event) =>
      ["plugin_lifecycle", "plugin_usage", "plugin_runtime_error"].includes(event.elementName),
    ),
  })
  .strict();

export type HostResourceUsageSnapshotResultResponse = z.infer<
  typeof hostResourceUsageSnapshotResultResponseSchema
>;

export const zcodeSessionFileSchema = z.object({
  meta: zcodeTaskMetaSchema,
  messages: z.array(zcodePersistedMessageSchema),
  fileChanges: z.array(zcodePersistedFileChangeSchema).optional(),
  turnCheckpoints: z.array(zcodePersistedTurnCheckpointSchema).optional(),
  stateTransitions: z.array(zcodeTurnStateTransitionRecordSchema).optional(),
});

/**
 * Сериализация `.zcode-session` с валидацией диагностических полей (F-06):
 * `finishReason`, `rawTruncatedInputPreview`, `repairAttempts`, `stateTransitions`.
 */
export function serializeZcodeSessionFile(
  session: z.input<typeof zcodeSessionFileSchema>,
): string {
  const validated = zcodeSessionFileSchema.parse(session);
  return JSON.stringify(validated, null, 2);
}

/**
 * Десериализация `.zcode-session` с полной обратной совместимостью для старых файлов
 * без новых диагностических полей (`finishReason`, `rawTruncatedInputPreview`,
 * `repairAttempts`, `stateTransitions`).
 */
export function deserializeZcodeSessionFile(
  raw: string | unknown,
): z.output<typeof zcodeSessionFileSchema> {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  return zcodeSessionFileSchema.parse(parsed);
}

export const webRemoteControlAppPayloadSchemas = [
  z
    .object({
      zcode_type: z.literal("telemetry-report"),
      event: z.union([sessionCreateTelemetrySchema, mobilePluginDiscoveryTelemetrySchema]),
    })
    .strict(),
  z.object({
    zcode_type: z.literal("bootstrap-request"),
    requestId: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("bootstrap-response"),
    requestId: nonEmptyStringSchema,
    success: z.literal(true),
    result: webRemoteControlWindowBootstrapResultSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-request"),
    requestId: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-response"),
    requestId: nonEmptyStringSchema,
    success: z.literal(true),
    result: webRemoteControlWorkspaceListResultSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-list-updated"),
    result: webRemoteControlWorkspaceListResultSchema,
  }),
  z
    .object({
      zcode_type: z.literal("workspace-bridge-open"),
      requestId: nonEmptyStringSchema,
      bridgeSessionId: webRemoteControlTransportIdSchema,
      bridgeGeneration: z.number().int().nonnegative().optional(),
      recoveryId: webRemoteControlTransportIdSchema.optional(),
      workspaceKey: nonEmptyStringSchema,
      taskId: nonEmptyStringSchema.optional(),
      taskHostId: nonEmptyStringSchema.optional(),
      fileTreeTaskId: nonEmptyStringSchema.optional(),
      project: z
        .object({
          projectId: nonEmptyStringSchema.nullable(),
          hostId: nonEmptyStringSchema.optional(),
          draftId: z.string().uuid().optional(),
          reuseDraft: z.boolean().optional(),
        })
        .strict()
        .refine(
          (intent) =>
            (!intent.draftId || intent.projectId === null) &&
            (!intent.reuseDraft || Boolean(intent.draftId)),
          "Only an unclassified draft can reuse its directory",
        )
        .optional(),
    })
    .refine(
      (request) =>
        (!request.project || (!request.taskId && !request.fileTreeTaskId)) &&
        !(request.taskId && request.fileTreeTaskId) &&
        (!request.fileTreeTaskId || Boolean(request.taskHostId)) &&
        (!request.taskHostId || Boolean(request.taskId || request.fileTreeTaskId)),
      "Project draft cannot target an existing task",
    ),
  z.object({
    zcode_type: z.literal("workspace-bridge-ready"),
    requestId: nonEmptyStringSchema,
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    bridge: webRemoteControlExternalWorkspaceBridgeSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-bridge-error"),
    requestId: nonEmptyStringSchema,
    bridgeSessionId: webRemoteControlTransportIdSchema.optional(),
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    reason: webRemoteControlFailureReasonSchema,
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-request"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-response"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(true),
  }),
  z.object({
    zcode_type: z.literal("workspace-reconnect-response"),
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("mobile-view-state-update"),
    viewState: webRemoteControlMobileViewStateSchema,
    deviceInfo: webRemoteControlMobileDeviceInfoSchema.optional(),
  }),
  z
    .object({
      zcode_type: z.literal("mobile-task-view-update"),
      epoch: webRemoteControlTransportIdSchema,
      seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      bridgeSessionId: webRemoteControlTransportIdSchema,
      bridgeGeneration: z.number().int().nonnegative().optional(),
      view: webRemoteControlMobileTaskViewSchema.nullable(),
    })
    .strict(),
  z
    .object({
      zcode_type: z.literal("mobile-task-view-request"),
      epoch: webRemoteControlTransportIdSchema,
    })
    .strict(),
  z.object({
    zcode_type: z.literal("platform-request"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    args: z.unknown().optional(),
  }),
  z.object({
    zcode_type: z.literal("platform-response"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    success: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    zcode_type: z.literal("platform-response"),
    requestId: nonEmptyStringSchema,
    method: webRemoteControlPlatformMethodSchema,
    success: z.literal(false),
    error: z.string(),
  }),
  // Bugfix：04D-3 必须让 fragment/ACK 与 acknowledged adapter 原子切换。
  // 继续接受 legacy 单片会让 raw bytes 绕过 ACK/replay owner 和 1MiB 外壳硬边界。
  webRemoteControlRpcTransportFrameSchema,
  webRemoteControlRpcTransportAckSchema,
  z.object({
    zcode_type: z.literal("bridge-degraded"),
    bridgeSessionId: webRemoteControlTransportIdSchema,
    bridgeGeneration: z.number().int().nonnegative().optional(),
    recoveryId: webRemoteControlTransportIdSchema.optional(),
    reason: z.enum([
      "rpc-transport-fault",
      "rpc-frame-gap",
      "buffer-overflow",
      "buffer-timeout",
      "source-session-replaced",
    ]),
    seq: z.number().int().nonnegative().optional(),
    expectedSeq: z.number().int().nonnegative().optional(),
    droppedCount: z.number().int().nonnegative().optional(),
  }),
  z.object({
    zcode_type: z.literal("app-error"),
    requestId: nonEmptyStringSchema.optional(),
    bridgeSessionId: webRemoteControlTransportIdSchema.optional(),
    reason: webRemoteControlFailureReasonSchema,
    error: z.string(),
  }),
  z.object({
    zcode_type: z.literal("mobile-diagnostic"),
    event: z.enum([
      "state-transition",
      "socket-close",
      "socket-error",
      "recover-start",
      "recover-scheduled",
      "pair-status",
      "failure",
    ]),
    timestamp: z.number().int().nonnegative(),
    state: z.string().optional(),
    previousState: z.string().optional(),
    pairStatus: z.enum(["waiting", "matched"]).optional(),
    closeCode: z.number().int().optional(),
    closeReason: z.string().optional(),
    wasClean: z.boolean().optional(),
    wasPaired: z.boolean().optional(),
    failureReason: webRemoteControlFailureReasonSchema.optional(),
    failureMessage: z.string().optional(),
    visibilityState: z.string().optional(),
    online: z.boolean().optional(),
    hiddenDurationMs: z.number().int().nonnegative().optional(),
  }),
] as const;

export type WindowHostRemoteWorkspaceDescriptor = z.infer<
  typeof windowHostRemoteWorkspaceDescriptorSchema
>;

/** Desktop Main → Preload → Renderer 的 remote workspace MessagePort 元数据合同。 */
export const scopedServicePortPayloadSchema = windowHostRemoteWorkspaceDescriptorSchema
  .pick({
    sourceServerId: true,
    target: true,
    workspacePurpose: true,
  })
  .extend({
    attachmentId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
  })
  .strict();

export const hostProjectWorkspacePreparedValueSchema = z
  .object({
    hostId: nonEmptyStringSchema,
    projectId: nonEmptyStringSchema.nullable(),
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    additionalDirectories: z.array(nonEmptyStringSchema),
    remote: windowHostRemoteWorkspaceDescriptorSchema.optional(),
  })
  .strict();

export const hostIncomingMessageSchema = z.discriminatedUnion("type", [
  hostPrepareProjectWorkspaceMessageSchema,
  z.object({ type: z.literal("network-capture"), control: networkCaptureControlSchema }).strict(),
  z
    .object({ type: z.literal("database-startup-control"), control: databaseStartupControlSchema })
    .strict(),
  hostResourceUsageSnapshotRequestMessageSchema,
  z
    .object({ type: z.literal("resource-usage-snapshot-cancel"), requestId: nonEmptyStringSchema })
    .strict(),
  hostInitLocalMessageSchema,
  hostConnectRemoteWorkspaceMessageSchema,
  hostCancelRemoteWorkspaceConnectMessageSchema,
  hostBindRemoteWorkspaceContextMessageSchema,
  hostCancelRemoteWorkspaceBindMessageSchema,
  hostDisposeRemoteWorkspaceSessionMessageSchema,
  hostAttachServicePortMessageSchema,
  hostDetachServicePortMessageSchema,
  hostDisposeMessageSchema,
  hostBroadcastEnvelopeSchema,
  hostBroadcastClaimResultMessageSchema,
  hostTaskRealtimeDeliverMessageSchema,
  hostTaskRunLeaseResultMessageSchema,
  hostTaskOwnerCommandDeliverMessageSchema,
  hostTaskOwnerCommandResultMessageSchema,
  hostSessionMessageDeliverMessageSchema,
  hostSessionMessageDeliveryResultMessageSchema,
  hostFeedbackLogArchiveResultMessageSchema,
  hostCronRunMessageSchema,
  hostOffPeakRunMessageSchema,
  hostBrowserExecuteResultMessageSchema,
  hostLocalMediaPreviewPathAuthorizeResultMessageSchema,
  hostPluginSandboxRegisterResultMessageSchema,
  hostCuaPipFocusChangedMessageSchema,
  hostApplicationLocaleChangedMessageSchema,
  hostProviderProvisioningExecuteMessageSchema,
]);

export const hostRemoteWorkspaceConnectedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-connected"),
    requestId: nonEmptyStringSchema,
    descriptor: windowHostRemoteWorkspaceDescriptorSchema,
  })
  .strict();

export const hostRemoteWorkspaceReconnectedResponseSchema = z
  .object({
    type: z.literal("remote-workspace-reconnected"),
    previousRemoteSessionId: nonEmptyStringSchema,
    descriptor: windowHostRemoteWorkspaceDescriptorSchema,
  })
  .strict();

export type HostPluginTelemetryResponse = z.infer<typeof hostPluginTelemetryResponseSchema>;

// Bugfix: app payload 里多个消息共享 zcode_type（例如 platform-response），
// 不能直接用 z.discriminatedUnion("zcode_type")，否则 schema 初始化会因重复值失败。
// 这里保留同一批运行时约束，改用普通 union，让外部 relay 的不可信 payload
// 在进入 desktop/web 路由前仍然先被机械校验。
export const webRemoteControlAppPayloadSchema = z.union(webRemoteControlAppPayloadSchemas);

export type ScopedServicePortPayload = z.infer<typeof scopedServicePortPayloadSchema>;

export type HostPreparedProjectWorkspace = z.infer<typeof hostProjectWorkspacePreparedValueSchema>;

export const hostProjectWorkspacePreparedResponseSchema = z
  .object({
    type: z.literal("project-workspace-prepared"),
    requestId: nonEmptyStringSchema,
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), value: hostProjectWorkspacePreparedValueSchema }).strict(),
      z.object({ ok: z.literal(false), error: nonEmptyStringSchema }).strict(),
    ]),
  })
  .strict();

export function parseWebRemoteControlAppPayload(
  payload: unknown,
): WebRemoteControlAppPayload | null {
  const result = webRemoteControlAppPayloadSchema.safeParse(payload);
  return result.success ? (result.data as WebRemoteControlAppPayload) : null;
}

export const hostResponseMessageSchema = z.discriminatedUnion("type", [
  hostProjectWorkspacePreparedResponseSchema,
  z.object({ type: z.literal("network-capture-batch"), batch: networkCaptureBatchSchema }).strict(),
  z
    .object({ type: z.literal("database-startup-state"), state: databaseStartupStateSchema })
    .strict(),
  hostResourceUsageSnapshotResultResponseSchema,
  hostRemoteWorkspaceConnectionLogResponseSchema,
  hostRemoteWorkspaceConnectedResponseSchema,
  hostRemoteWorkspaceContextBoundResponseSchema,
  hostRemoteWorkspaceContextBindFailedResponseSchema,
  hostRemoteWorkspaceReconnectedResponseSchema,
  hostRemoteWorkspaceConnectFailedResponseSchema,
  hostRemoteWorkspaceClosedResponseSchema,
  hostLogResponseSchema,
  hostAgentProcessSpawnedResponseSchema,
  hostAgentProcessReadyResponseSchema,
  hostAgentProcessExitedResponseSchema,
  hostAgentProcessErrorResponseSchema,
  hostAgentProcessExceptionResponseSchema,
  hostAgentResourceSampleResponseSchema,
  hostResourceSampleResponseSchema,
  hostMcpTelemetryResponseSchema,
  hostMcpResourceSamplesResponseSchema,
  hostToolExecResourceResponseSchema,
  hostSessionCreateTelemetryResponseSchema,
  hostPluginTelemetryResponseSchema,
  hostAgentRunningTaskCountChangedResponseSchema,
  hostWorkspaceRunningTaskCountChangedResponseSchema,
  hostCuaOperationStateResponseSchema,
  hostBroadcastEnvelopeSchema,
  hostBroadcastClaimRequestResponseSchema,
  hostBroadcastClaimCommitResponseSchema,
  hostBroadcastClaimReleaseResponseSchema,
  hostTaskRealtimePublishResponseSchema,
  hostTaskStreamOpPublishResponseSchema,
  hostTaskRunLeaseAcquireResponseSchema,
  hostTaskRunLeaseReleaseResponseSchema,
  hostTaskOwnerCommandRequestResponseSchema,
  hostTaskOwnerCommandResultResponseSchema,
  hostSessionMessageSendRequestedResponseSchema,
  hostSessionRouteAnnounceResponseSchema,
  hostSessionMessageDeliverResultResponseSchema,
  hostFeedbackLogArchiveRequestResponseSchema,
  hostBrowserExecuteRequestResponseSchema,
  hostLocalMediaPreviewPathAuthorizeRequestResponseSchema,
  hostPluginSandboxRegisterRequestResponseSchema,
  hostNetworkTelemetryBatchResponseSchema,
  hostProviderProvisioningSourceChangedResponseSchema,
  hostProviderProvisioningExecutionResultResponseSchema,
  hostCronRunResultResponseSchema,
  hostOffPeakRunResultResponseSchema,
  hostCronSchedulerWakeRequestResponseSchema,
  hostOffPeakSchedulerWakeRequestResponseSchema,
]);
