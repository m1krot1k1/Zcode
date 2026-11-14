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

// Часть 1/3 модуля shared-validation: вынесено по лимиту строк.

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export const nonEmptyStringSchema = z.string().trim().min(1);

export const stringArraySchema = z.array(z.string());

export const webRemoteControlFailureReasonSchema = z.enum([
  "session-not-found",
  "session-expired",
  "session-conflict",
  "workspace-closed",
  "desktop-disconnected",
  "invalid-mobile-connection",
  "desktop-bootstrap-timeout",
  "connection-recovery-timeout",
  "relay-unavailable",
  "unsupported-action",
  "unexpected-error",
]);

export const webRemoteControlPlatformMethodSchema = z.enum([
  "isDockerAvailable",
  "listWSLDistros",
  "listDockerContainers",
  "listSSHConfigAliases",
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "migrateLegacyCommonMcp",
]);

export const credentialRecordSchema = z.record(z.string(), z.string());

export const credentialValueSchema = z.string();

export const wslConnectOptionsSchema = z.object({
  kind: z.literal("wsl"),
  distro: z.string().optional(),
  user: wslUserSchema.optional(),
});

export const helloMessageSchema = z.object({
  type: z.literal("zcode-hello"),
  version: z.string(),
  platform: z.string(),
  arch: z.string(),
  pid: z.number().int(),
});

export const rendererLogPayloadSchema = z.object({
  level: z.enum(["info", "warn", "error"]),
  args: z.array(z.unknown()),
});

export const remoteAssetDirsSchema = z.object({
  bundledReleaseDir: z.string().optional(),
  mockCdnDir: z.string().optional(),
  remoteCdnBaseUrl: z.string().optional(),
  remoteCdnBaseUrls: z.array(z.string()).optional(),
  remoteCacheDir: z.string().optional(),
  sourceServerArtifactPolicy: sourceServerArtifactPolicySchema.optional(),
});

export const hostDisposeMessageSchema = z.object({
  type: z.literal("dispose"),
});

export const hostTaskRealtimeDeliverMessageSchema = z.object({
  type: z.literal("task-realtime-deliver"),
  event: taskRealtimeDeliveredEventSchema,
});

export const hostTaskRunLeaseResultMessageSchema = z.object({
  type: z.literal("task-run-lease-result"),
  result: taskRunLeaseResultSchema,
});

export const hostTaskOwnerCommandDeliverMessageSchema = z.object({
  type: z.literal("task-owner-command-deliver"),
  command: taskOwnerCommandDeliverySchema,
});

export const hostTaskOwnerCommandResultMessageSchema = z.object({
  type: z.literal("task-owner-command-result"),
  result: taskOwnerCommandResultSchema,
});

export const hostApplicationLocaleChangedMessageSchema = z
  .object({
    type: z.literal("application-locale-changed"),
    locale: localeSchema,
  })
  .strict();

export const hostLogResponseSchema = z.object({
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  source: z.string(),
  message: z.string(),
});

export const zcodeTaskMigrationSourceSchema = z.enum(["claudeCode"]);

/**
 * services 打标后的 CLI 资源样本。
 *
 * `lane` 不是 CLI 协议字段：CLI 进程不知道自己被哪个进程管理器拉起，由 services 层在解析
 * 协议样本时按所属进程管理器补上。样本自身仍按 CLI 协议 schema 严格校验，因此 CLI 自报 lane
 * 会被协议层直接拒绝。`lane` 可选是为了兼容版本落后、还没打标的远端 server。
 */
export const processResourceCliLaneSchema = z.enum(PROCESS_RESOURCE_CLI_LANES);

/** Host 仅传运行环境的 SHA-256 哈希，避免原始主机、用户或 URL 进入消息与日志。 */
export const resourceTelemetryEnvironmentKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Node 进程（host / scheduler）每 60 秒自采的瞬时事实
 *
 * 只带这三项：CPU 与 RSS 由 main 的 `getAppMetrics()` 负责，heap 只有进程自己读得到。
 */
export const nodeSelfResourceSampleSchema = z
  .object({
    /**
     * 整机归一化 CPU 百分比，100 表示所有逻辑核占满。
     * 上限刻意放宽（与 CLI 的 `zcodeProcessResourceSampleSchema` 同口径）：读数异常时宁可让
     * 样本带着离谱数值上去、由平台侧数值异常规则暴露，也不在客户端静默丢样本。
     */
    cpuPercent: z.number().finite().nonnegative().max(100_000),
    rssKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/**
 * 主窗口 renderer 每 60 秒经 preload 桥送 main 的 heap 读数
 *
 * 只带 heap：renderer 的 CPU 与 RSS 由 main 的 `getAppMetrics()` 负责，
 * renderer 自己也读不到。`strict` 保证 UI 侧不会顺手夹带路径、session 等隐私字段。
 */
export const rendererHeapSampleSchema = z
  .object({
    heapUsedKb: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const hostToolExecResourceResponseSchema = z
  .object({
    type: z.literal("tool-exec-resource"),
    runtimeSurface: z.enum(["local", "remote"]),
    sample: zcodeToolExecResourceSchema,
  })
  .strict();

export const hostMcpTelemetryResponseSchema = z
  .object({
    type: z.literal("mcp-telemetry"),
    runtimeSurface: z.enum(["local", "remote"]),
    event: zcodeMcpTelemetryEventSchema,
  })
  .strict();

export const hostSessionCreateTelemetryResponseSchema = z
  .object({
    type: z.literal("session-create-telemetry"),
    event: automationSessionCreateTelemetrySchema,
  })
  .strict();

export const hostAgentRunningTaskCountChangedResponseSchema = z.object({
  type: z.literal("agent-running-task-count-changed"),
  runningTaskCount: z.number().int().nonnegative(),
});

export const hostTaskRealtimePublishResponseSchema = z.object({
  type: z.literal("task-realtime-publish"),
  event: taskRealtimeEventSchema,
});

export const hostTaskStreamOpPublishResponseSchema = z.object({
  type: z.literal("task-stream-op-publish"),
  target: taskStreamMirrorTargetSchema,
  op: taskStreamMirrorPublishOpSchema,
});

export const hostTaskRunLeaseAcquireResponseSchema = z.object({
  type: z.literal("task-run-lease-acquire"),
  request: taskRunLeaseAcquireRequestSchema,
});

export const hostTaskRunLeaseReleaseResponseSchema = z.object({
  type: z.literal("task-run-lease-release"),
  target: taskRunLeaseTargetSchema,
});

export const hostTaskOwnerCommandRequestResponseSchema = z.object({
  type: z.literal("task-owner-command-request"),
  command: taskOwnerCommandRequestSchema,
});

export const hostTaskOwnerCommandResultResponseSchema = z.object({
  type: z.literal("task-owner-command-result"),
  result: taskOwnerCommandResultSchema,
});

// host → main：闲时任务 schedulable 翻转后的 scheduler 唤醒；业务数据仍由 scheduler 从 sqlite 读取。
export const hostOffPeakSchedulerWakeRequestResponseSchema = z.object({
  type: z.literal("off-peak-scheduler-wake-request"),
  offPeakTaskId: z.string().optional(),
});

export const networkObservationSchema = z.object({
  transport: z.enum(["http", "websocket", "rpc"]),
  interface: z.string(),
  durationMs: z.number(),
  ok: z.boolean(),
  statusCode: z.number().optional(),
  errorKind: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  dnsMs: z.number().optional(),
  tcpMs: z.number().optional(),
  tlsMs: z.number().optional(),
  ttfbMs: z.number().optional(),
  downloadMs: z.number().optional(),
});

export const hostProviderProvisioningSourceChangedResponseSchema = z
  .object({
    type: z.literal("provider-provisioning-source-changed"),
    trigger: providerProvisioningTriggerSchema.exclude(["environment-online"]),
  })
  .strict();

export const zcodeTaskPersistStatusSchema = z.enum(["running", "completed", "error"]);

export const zcodePromptImageAttachmentSchema = z.object({
  kind: z.literal("image"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

// 附件 TypeScript 联合类型新增 video 后，手写的持久化运行时 schema 未同步，
// session 恢复解析会拒绝含视频的用户消息。字段与 image 的 inline/local 引用语义保持一致。
export const zcodePromptVideoAttachmentSchema = z.object({
  kind: z.literal("video"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptPdfAttachmentSchema = z.object({
  kind: z.literal("pdf"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative().optional(),
  dataBase64: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePromptFileAttachmentSchema = z.object({
  kind: z.literal("file"),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  dataBase64: z.string().optional(),
  textContent: z.string().optional(),
  localPath: z.string().optional(),
});

export const zcodePersistedToolCallSchema = z.object({
  toolName: z.string().optional(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.enum(["completed", "failed", "denied", "stopped"]).optional(),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  raw: z.unknown().optional(),
  snapshotRefs: z
    .array(
      z.object({
        field: z.enum(["input", "output", "raw"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

export const zcodePersistedMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content"), content: z.string() }),
  z.object({ type: z.literal("thought"), content: z.string() }),
  z.object({
    type: z.literal("tool-call"),
    toolIndex: z.number().int().nonnegative(),
  }),
]);

export const zcodeTaskGoalStatusSchema = z.enum(["active", "paused", "budget_limited", "complete"]);

export const zcodeTaskTargetChangedActionSchema = z.enum([
  "set",
  "status_updated",
  "cleared",
  "usage_accounted",
  "run_started",
  "run_finished",
  "summary_updated",
]);

export const zcodeTaskTargetChangedSourceSchema = z.enum(["command", "tool", "runtime"]);

export const zcodeTaskSessionBindingStateSchema = z.enum([
  "idle",
  "syncing",
  "ready",
  "stale",
  "failed",
]);

export const zcodePersistedFileSnapshotSchema = z.object({
  path: z.string(),
  beforeContent: z.string().nullable(),
  afterContent: z.string(),
  writeCount: z.number().int().positive(),
  contentRefs: z
    .array(
      z.object({
        field: z.enum(["beforeContent", "afterContent"]),
        refId: z.string(),
        hash: z.string(),
        fullBytes: z.number().int().nonnegative(),
        previewBytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

// Task04B：topic physical-frame 计量器按 bridge/recovery id 的协议最大长度计算
// mobile relay 外壳；不在不可信 payload 入口机械限长，1MiB 上限就只是估算。
export const webRemoteControlTransportIdSchema = nonEmptyStringSchema
  .max(PROTOCOL_V4_LIMITS.transportEnvelopeIdMaxChars)
  .regex(/^[A-Za-z0-9._~-]+$/u);

export const webRemoteControlWorkspaceTargetSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
  remoteSessionId: nonEmptyStringSchema.optional(),
  label: nonEmptyStringSchema,
  workspacePurpose: z.enum(["project", "conversation"]).optional(),
  kind: z.enum(["local", "remote"]),
  connectionState: z.enum(["connected", "disconnected", "reconnecting"]).optional(),
  lastConnectionError: z.string().optional(),
});

export const webRemoteControlReconnectWorkspaceRequestSchema = z.object({
  requestId: nonEmptyStringSchema,
  workspaceKey: nonEmptyStringSchema,
});

export const webRemoteControlReconnectWorkspaceResultSchema = z.union([
  z.object({
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(true),
  }),
  z.object({
    requestId: nonEmptyStringSchema,
    workspaceKey: nonEmptyStringSchema,
    success: z.literal(false),
    error: z.string(),
  }),
]);

export const webRemoteControlMobileViewStateSchema = z.object({
  activeWorkspaceKey: nonEmptyStringSchema.optional(),
  activeTaskId: nonEmptyStringSchema.optional(),
  updatedAt: z.number().finite(),
});

export const webRemoteControlMobileTaskViewSchema = z
  .object({
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema.optional(),
    taskId: nonEmptyStringSchema,
  })
  .strict();

export const webRemoteControlMobileDeviceInfoSchema = z.object({
  platform: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  userAgent: z.string().optional(),
  language: z.string().optional(),
  languages: z.array(z.string()).optional(),
  browserPlatform: z.string().optional(),
  viewport: z
    .object({
      width: z.number().finite(),
      height: z.number().finite(),
      devicePixelRatio: z.number().finite(),
    })
    .optional(),
  screen: z
    .object({
      width: z.number().finite(),
      height: z.number().finite(),
    })
    .optional(),
  timezone: z.string().optional(),
  online: z.boolean().optional(),
  updatedAt: z.number().finite(),
});

export const credentialKeySchema = nonEmptyStringSchema;

export const sshConnectOptionsSchema = z.object({
  kind: z.literal("ssh"),
  host: nonEmptyStringSchema,
  port: z.number().int().positive().max(65535).optional(),
  username: nonEmptyStringSchema,
  sshConfigAlias: nonEmptyStringSchema.optional(),
  password: z.string().optional(),
  privateKeyPath: z.string().optional(),
  privateKeyPassphrase: z.string().optional(),
  assetInstallMode: z.enum(REMOTE_ASSET_INSTALL_MODES).optional(),
  resourcePackages: z
    .object({
      selectedPackageIds: z.array(z.string().refine(isKnownRemoteResourcePackageId)).optional(),
    })
    .optional(),
});

export const dockerConnectOptionsSchema = z.object({
  kind: z.literal("docker"),
  container: nonEmptyStringSchema,
});

export const serverConnectOptionsSchema = z.object({
  kind: z.literal("server"),
  url: z.string().url(),
  name: nonEmptyStringSchema.optional(),
  token: z.string().optional(),
  workspacePath: z.string().optional(),
  serverId: nonEmptyStringSchema.optional(),
});

export const helloAckMessageSchema = z.object({
  type: z.literal("zcode-hello-ack"),
  version: z.string(),
  clientId: nonEmptyStringSchema,
});

export const taskNotificationPayloadSchema = z.object({
  taskId: nonEmptyStringSchema,
  status: z.enum([
    "completed",
    "failed",
    "permission_request",
    "elicitation_request",
    "feedback_update",
  ]),
  requestId: nonEmptyStringSchema.optional(),
  title: z.string(),
  body: z.string(),
});

export const telemetryRendererContextSchema = z.object({
  clientTimezone: nonEmptyStringSchema,
  clientLanguage: nonEmptyStringSchema,
  screenResolution: nonEmptyStringSchema,
});

export const armsCustomEventPayloadSchema = z.object({
  name: nonEmptyStringSchema,
  group: nonEmptyStringSchema,
  value: z.number().finite().optional(),
  properties: z
    .record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.undefined()]))
    .optional(),
});

export const broadcastMessageSchema = z.object({
  channel: nonEmptyStringSchema,
  payload: z.unknown(),
  sourceWindowId: z.number().int().optional(),
});

export const hostAgentWarmupTargetSchema = z.object({
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: nonEmptyStringSchema.optional(),
});

export const windowHostAttachmentScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z
    .object({
      kind: z.literal("source-settings"),
      sourceServerId: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote"),
      sourceServerId: nonEmptyStringSchema.optional(),
      remoteSessionId: nonEmptyStringSchema,
      workspacePath: nonEmptyStringSchema,
      workspaceIdentity: nonEmptyStringSchema,
    })
    .strict(),
]);

export const hostCancelRemoteWorkspaceConnectMessageSchema = z
  .object({
    type: z.literal("cancel-remote-workspace-connect"),
    requestId: nonEmptyStringSchema,
  })
  .strict();

export const hostBindRemoteWorkspaceContextMessageSchema = z
  .object({
    type: z.literal("bind-remote-workspace-context"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    workspacePath: nonEmptyStringSchema,
    workspaceIdentity: nonEmptyStringSchema,
    workspacePurpose: z.enum(["project", "conversation"]).optional(),
    legacyRouteHint: nonEmptyStringSchema.optional(),
  })
  .strict();

export const hostCancelRemoteWorkspaceBindMessageSchema = z
  .object({
    type: z.literal("cancel-remote-workspace-bind"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
  })
  .strict();

export const hostDisposeRemoteWorkspaceSessionMessageSchema = z
  .object({
    type: z.literal("dispose-remote-workspace-session"),
    requestId: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
  })
  .strict();

export const hostDetachServicePortMessageSchema = z.object({
  type: z.literal("detach-service-port"),
  attachmentId: nonEmptyStringSchema,
});

export const hostBroadcastClaimResultMessageSchema = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("acquired"),
    claimToken: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("busy"),
    retryAfterMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("broadcast-claim-result"),
    requestId: nonEmptyStringSchema,
    status: z.literal("committed"),
  }),
]);

export const sessionMessageRequestSchema = z.object({
  content: nonEmptyStringSchema,
  createdAt: nonEmptyStringSchema,
  fromSessionId: nonEmptyStringSchema,
  messageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  toSessionId: nonEmptyStringSchema,
});

export const sessionMessageDeliveryResultSchema = z.object({
  error: z.string().optional(),
  messageId: nonEmptyStringSchema,
  requestId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  status: z.enum(["success", "failed"]),
});

export const sessionRouteSchema = z.object({
  sessionId: nonEmptyStringSchema,
});

export const hostFeedbackLogArchiveResultMessageSchema = z.object({
  type: z.literal("feedback-log-archive-result"),
  requestId: nonEmptyStringSchema,
  ok: z.boolean(),
  path: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

// main → host：定时任务到点派发。会话内 cron 带 targetTaskId 时直接 sendPrompt 到当前会话；
// 历史未绑定任务才 fallback createTask + sendPrompt 建 session。
export const hostCronRunMessageSchema = z.object({
  type: z.literal("cron-run"),
  automationId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: z.string().optional(),
  projectId: nonEmptyStringSchema.nullable().optional(),
  hostId: nonEmptyStringSchema.optional(),
  additionalDirectories: z.array(nonEmptyStringSchema).max(256).optional(),
  prompt: nonEmptyStringSchema,
  targetTaskId: nonEmptyStringSchema.optional(),
  modelSelection: modelSelectionSchema.optional(),
  mode: z.string().optional(),
});

// main → host：闲时任务派发（仿 cron-run，字段独立不复用）。首跑不带 conversationId/sessionId，
// host createTask 新建 session；3h 续跑 / 中断恢复带上两者 resume 同一会话。
// serverTicketId 供 idle plan 适配层注入 X-Off-Peak-Ticket-ID 请求头（run 作用域）。
export const hostOffPeakRunMessageSchema = z.object({
  type: z.literal("off-peak-run"),
  offPeakTaskId: nonEmptyStringSchema,
  workspacePath: nonEmptyStringSchema,
  workspaceIdentity: z.string().optional(),
  projectId: nonEmptyStringSchema.nullable().optional(),
  hostId: nonEmptyStringSchema.optional(),
  additionalDirectories: z.array(nonEmptyStringSchema).max(256).optional(),
  prompt: nonEmptyStringSchema,
  // 权限四档映射现有 ZCodeTaskMode；与 cron-run 的 mode 同样按宽松 string 传输
  permissionMode: nonEmptyStringSchema,
  modelSelection: modelSelectionSchema,
  conversationId: z.string().optional(),
  sessionId: z.string().optional(),
  serverTicketId: z.string().optional(),
});

// main → host：browser-use 命令执行结果（按 requestId 关联到 host 的 pending）。
export const hostBrowserExecuteResultMessageSchema = z.object({
  type: z.literal("browser-execute-result"),
  requestId: nonEmptyStringSchema,
  result: browserCommandResultSchema,
});

export const hostLocalMediaPreviewPathAuthorizeResultMessageSchema = z
  .object({
    type: z.literal("local-media-preview-path-authorize-result"),
    requestId: nonEmptyStringSchema,
    ok: z.boolean(),
    path: nonEmptyStringSchema.optional(),
    error: z.string().optional(),
  })
  .strict();

/** main → host：插件 UI 沙箱登记结果（PluginSandboxRegisterResultPayload）。 */
export const hostPluginSandboxRegisterResultMessageSchema = z
  .object({
    type: z.literal("plugin-sandbox-register-result"),
    requestId: nonEmptyStringSchema,
    ok: z.boolean(),
    instance: mcpAppInstanceSchema.optional(),
    sandboxId: nonEmptyStringSchema.optional(),
    initId: z.number().int().nonnegative().optional(),
    shellUrl: nonEmptyStringSchema.optional(),
    partition: nonEmptyStringSchema.optional(),
    // 登记时生效的呈现字段（资源级优先合并后的值），回 renderer 定初始高度 / 边框。
    // Bugfix：这条 schema 是 strict 的——句柄多带一个未声明字段，整条回包会被 host 拒收，桥永远等不到句柄，
    // 卡片卡在 preparing（2026-09-12 inline e2e 复现）。改 PluginSandboxHandle 必须同步这里。
    resourceMeta: z
      .object({
        prefersBorder: z.boolean().optional(),
        heightHint: z.number().int().positive().optional(),
        minFrameHeight: z.number().int().positive().optional(),
        showInline: z.boolean().optional(),
        // 资源声明的浏览器权限随句柄回 renderer（进 hostContext.permissions）；与登记请求的 permissions 同一枚举。
        permissions: z
          .array(z.enum(["camera", "microphone", "geolocation", "clipboardWrite"]))
          .optional(),
      })
      .strict()
      .optional(),
    error: z.string().optional(),
  })
  .strict();

export const hostCuaPipFocusChangedMessageSchema = z
  .object({
    type: z.literal("cua-pip-focus-changed"),
    event: z
      .object({
        kind: z.literal("focus-changed"),
        revision: z.number().int().nonnegative().safe(),
        sourceWindowId: nonEmptyStringSchema.max(255),
        sessionId: nonEmptyStringSchema.max(255).nullable(),
      })
      .strict(),
  })
  .strict();

export const hostProviderProvisioningExecuteMessageSchema = z
  .object({
    type: z.literal("provider-provisioning-execute"),
    requestId: nonEmptyStringSchema,
    environmentKey: nonEmptyStringSchema,
    remoteSessionId: nonEmptyStringSchema,
    trigger: providerProvisioningTriggerSchema,
  })
  .strict();
