import { localTtftFactsSchema } from "../localTtft.js";
// 传输外壳：连接握手 / 订阅 / 帧信封。
// 阶段为类型占位（后半接通道层时启用），数据形状已按规范定稿。
import { z } from "zod";
import { APP_USAGE_RANGES, appUsageSnapshotSchema } from "../usage-stats.js";
import { zcodeWorkspaceRefSchema } from "../zcode-protocol-legacy-types.js";
import {
  PROTOCOL_V4_LIMITS,
  V4_WIRE_PROTOCOL_VERSION,
  conversationRowTargetSchema,
  timestampSchema,
} from "./core.js";
import { conversationDeltaSchema } from "./delta.js";
import { conversationRowSchema, toolCallRowSchema } from "./rows.js";
import { sessionsIndexDeltaSchema, sessionsIndexSnapshotSchema } from "./sessions-index.js";
import { WORKFLOW_RUN_STOP_REASONS } from "./workflow-observation-display.js";
import { conversationSnapshotSchema } from "./snapshot.js";
import { workspaceConfigDeltaSchema, workspaceConfigSnapshotSchema } from "./workspace-config.js";
import { createTopicWireFrameSchema, topicWireFrameCandidateSchema } from "./wire.js";
import { MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE, conversationOpenTimingSchema, conversationTopicFrameSchema, decodedBase64ByteLength, helloMessageSchema, parseConversationTopic, routedTopicWireCandidateSchema, sessionsIndexTopicFrameSchema, subscribeAckSchema, subscribeParamsSchema, v4AttachmentChecksumSchema, v4AttachmentPreviewSourceParamsSchema, v4AttachmentPreviewSourceResultSchema, v4AttachmentPutParamsSchema, v4AttachmentPutResultSchema, v4AttachmentReadParamsSchema, v4AttachmentUploadIdSchema, v4ConnectionFlowParamsSchema, v4ConversationAttachmentReadParamsSchema, v4ConversationAttachmentStatParamsSchema, v4ConversationAttachmentStatResultSchema, v4ConversationFileChangesResultSchema, v4ConversationFileRewindPreviewParamsSchema, v4ConversationResyncParamsSchema, v4ConversationResyncResultSchema, v4ConversationUsageParamsSchema, v4ConversationUsageResultSchema, v4ConversationWorkflowRunEventsParamsSchema, v4ConversationWorkflowRunsResultSchema, v4SessionsIndexSubscribeResultSchema, v4UsageStatsParamsSchema, v4UsageStatsResultSchema, v4WorkspaceConfigSubscribeResultSchema, v4WorkspaceFileRewindIgnoredFileSchema, v4WorkspaceFileRewindSafeFileSchema, v4WorkspaceFileRewindUnsafeFileSchema, workspaceConfigTopicFrameSchema } from "./protocol-v4-transport-part1.js";
import type { ClientHello, HostCapabilities, SubscribeParams } from "./protocol-v4-transport-part1.js";

// Часть 2/2 модуля protocol-v4-transport: вынесено по лимиту строк.

export type V4ConversationFileRewindPreviewParams = z.infer<
  typeof v4ConversationFileRewindPreviewParamsSchema
>;

export const v4ConversationFileRewindPreviewResultSchema = z
  .object({
    canApply: z.boolean(),
    ignoredFiles: z.array(v4WorkspaceFileRewindIgnoredFileSchema),
    safeFiles: z.array(v4WorkspaceFileRewindSafeFileSchema),
    unsafeFiles: z.array(v4WorkspaceFileRewindUnsafeFileSchema),
  })
  .strict();

export type V4UsageStatsParams = z.infer<typeof v4UsageStatsParamsSchema>;

export type V4UsageStatsResult = z.infer<typeof v4UsageStatsResultSchema>;

export type V4ConversationUsageParams = z.infer<typeof v4ConversationUsageParamsSchema>;

export type V4ConversationUsageResult = z.infer<typeof v4ConversationUsageResultSchema>;

export type V4AttachmentPutParams = z.infer<typeof v4AttachmentPutParamsSchema>;

export type V4AttachmentPutResult = z.infer<typeof v4AttachmentPutResultSchema>;

export const v4AttachmentBeginParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
    fileName: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\p{Cc}]+$/u),
    mime: z
      .string()
      .min(3)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/),
    totalBytes: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    totalChunks: z.number().int().min(0).max(PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks),
    checksum: v4AttachmentChecksumSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.totalBytes === 0) !== (value.totalChunks === 0)) {
      context.addIssue({
        code: "custom",
        message: "zero-byte upload must declare zero chunks",
        path: ["totalChunks"],
      });
    }
  });

export const v4AttachmentBeginResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      uploadId: v4AttachmentUploadIdSchema,
      state: z.literal("staging"),
      nextChunkIndex: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      uploadId: v4AttachmentUploadIdSchema,
      state: z.literal("committed"),
      nextChunkIndex: z.number().int().nonnegative(),
      ref: z.string().min(1),
    })
    .strict(),
]);

export const v4AttachmentChunkParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
    chunkIndex: z.number().int().nonnegative(),
    dataBase64: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
  });

export const v4AttachmentChunkResultSchema = z
  .object({
    uploadId: v4AttachmentUploadIdSchema,
    nextChunkIndex: z.number().int().nonnegative(),
  })
  .strict();

export const v4AttachmentTerminalParamsSchema = z
  .object({
    connectionId: z.string().min(1),
    uploadId: v4AttachmentUploadIdSchema,
    sessionId: z.string().min(1),
  })
  .strict();

export const v4AttachmentCommitResultSchema = v4AttachmentPutResultSchema.strict();

export type V4AttachmentReadParams = z.infer<typeof v4AttachmentReadParamsSchema>;

export type V4AttachmentPreviewSourceParams = z.infer<typeof v4AttachmentPreviewSourceParamsSchema>;

export type V4AttachmentPreviewSourceResult = z.infer<typeof v4AttachmentPreviewSourceResultSchema>;

export const v4AttachmentReadResultSchema = z
  .object({
    dataBase64: z.string(),
    mediaType: z
      .string()
      .refine(
        (value) =>
          value.startsWith("image/") ||
          value.startsWith("video/") ||
          value.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf" ||
          value.split(";", 1)[0]?.trim().toLowerCase() === "text/plain",
        "attachment preview only supports image/video/pdf/plain text types",
      ),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      // 根因：运行时已支持材料文本，响应 schema 仍只接受媒体，导致跨进程预览失败。
      (value.mediaType.startsWith("image/") ||
        value.mediaType.split(";", 1)[0]?.trim().toLowerCase() === "text/plain") &&
      value.totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
    ) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        origin: "number",
        inclusive: true,
        message: "image/text preview exceeds total byte limit",
        path: ["totalBytes"],
      });
    }
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });

export type V4ConversationAttachmentReadParams = z.infer<
  typeof v4ConversationAttachmentReadParamsSchema
>;

export const v4ConversationAttachmentReadResultSchema = z
  .object({
    dataBase64: z.string(),
    mediaType: z.string().min(1),
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes),
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "attachment read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });

export type V4ConversationAttachmentStatParams = z.infer<
  typeof v4ConversationAttachmentStatParamsSchema
>;

export type V4ConversationAttachmentStatResult = z.infer<
  typeof v4ConversationAttachmentStatResultSchema
>;

/** conversation topic key 构造（与 parseConversationTopic 对偶）。 */
export function conversationTopic(sessionId: string): string {
  return `conversation/${sessionId}`;
}

export type HelloMessage = z.infer<typeof helloMessageSchema>;

export function hostSupportsWorkspaceHookReview(capabilities: HostCapabilities): boolean {
  return capabilities.workspaceHookReview === true;
}

export function clientSupportsWorkspaceHookReview(clientHello: ClientHello): boolean {
  return clientHello.capabilities?.workspaceHookReviewUi === true;
}

export function hostSupportsWorkflowRunDeltas(capabilities: HostCapabilities): boolean {
  return capabilities.workflowRunDeltas === true;
}

export function clientSupportsWorkflowRunDeltas(clientHello: ClientHello): boolean {
  return clientHello.capabilities?.workflowRunDeltas === true;
}

export type ConversationOpenTiming = z.infer<typeof conversationOpenTimingSchema>;

export const conversationSubscribeAckSchema = subscribeAckSchema.extend({
  openTiming: conversationOpenTimingSchema.optional(),
});

export type ConversationTopicFrame = z.infer<typeof conversationTopicFrameSchema>;

export const conversationTopicWireFrameSchema = createTopicWireFrameSchema(
  conversationTopicFrameSchema,
).superRefine((wire, context) => {
  if (!wire.topic.startsWith("conversation/") || wire.topic.length === "conversation/".length) {
    context.addIssue({ code: "custom", message: "invalid conversation topic", path: ["topic"] });
  }
});

export type SessionsIndexTopicFrame = z.infer<typeof sessionsIndexTopicFrameSchema>;

export const sessionsIndexTopicWireFrameSchema = createTopicWireFrameSchema(
  sessionsIndexTopicFrameSchema,
).superRefine((wire, context) => {
  if (!wire.topic.startsWith("sessions-index/") || wire.topic.length === "sessions-index/".length) {
    context.addIssue({ code: "custom", message: "invalid sessions-index topic", path: ["topic"] });
  }
});

export type WorkspaceConfigTopicFrame = z.infer<typeof workspaceConfigTopicFrameSchema>;

export const workspaceConfigTopicWireFrameSchema = createTopicWireFrameSchema(
  workspaceConfigTopicFrameSchema,
).superRefine((wire, context) => {
  if (
    !wire.topic.startsWith("workspace-config/") ||
    wire.topic.length === "workspace-config/".length
  ) {
    context.addIssue({
      code: "custom",
      message: "invalid workspace-config topic",
      path: ["topic"],
    });
  }
});

/** 三个生产 topic 的公共 logical / physical 路由面。 */
export const routedTopicFrameSchema = z.union([
  conversationTopicFrameSchema,
  sessionsIndexTopicFrameSchema,
  workspaceConfigTopicFrameSchema,
]);

export type RoutedTopicWireCandidate = z.infer<typeof routedTopicWireCandidateSchema>;

export type V4ConnectionFlowParams = z.infer<typeof v4ConnectionFlowParamsSchema>;

// subscribe 请求 = 通用 SubscribeParams + connectionId（重订阅替换按
// (connectionId, topic) 判定；stdio 单管道场景由 host 为每个下游客户端分配）。
export const v4ConversationSubscribeParamsSchema = subscribeParamsSchema.extend({
  additionalDirectories: z.array(z.string().trim().min(1)).max(256).optional(),
  connectionId: z.string(),
  clientMode: z.enum(["desktop-continuous", "web-remote-replayable"]),
  // 当前可信 attachment 的 workspace；cold resume 优先使用它恢复身份，live 不消费。
  workspace: zcodeWorkspaceRefSchema.optional(),
  /** host 从当前 remote workspace 的 tasks-index 精确读取的旧任务归属 allowlist。 */
  legacyTaskIds: z.array(z.string().min(1)).max(MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE).optional(),
  // 仅供 host→CLI cold resume 使用；live conversation 不消费该 hint。
  resumeThoughtLevel: z.string().trim().min(1).optional(),
  /**
   * 这条订阅收不收 `workflowRun.*` 键级增量。与 `clientMode` 同族：由**可信 host** 从该连接的
   * clientHello 注入，面向 UI 的 subscribe 选不了它——一个客户端能不能认得增量是连接的事实，
   * 不是某一次订阅可以自选的口味。缺席 = 按旧消费者处理（整键 patch + 旧界裁剪）。
   */
  workflowRunDeltas: z.boolean().optional(),
  historyFirst: z.boolean().optional(),
});

export type V4SessionsIndexSubscribeResult = z.infer<typeof v4SessionsIndexSubscribeResultSchema>;

export type V4WorkspaceConfigSubscribeResult = z.infer<
  typeof v4WorkspaceConfigSubscribeResultSchema
>;

export type V4ConversationResyncParams = z.infer<typeof v4ConversationResyncParamsSchema>;

export type V4ConversationResyncResult = z.infer<typeof v4ConversationResyncResultSchema>;

export type V4ConversationFileChangesResult = z.infer<typeof v4ConversationFileChangesResultSchema>;

export type V4ConversationWorkflowRunEventsParams = z.infer<
  typeof v4ConversationWorkflowRunEventsParamsSchema
>;

export type V4ConversationWorkflowRunsResult = z.infer<
  typeof v4ConversationWorkflowRunsResultSchema
>;

export type V4ConversationFileRewindPreviewResult = z.infer<
  typeof v4ConversationFileRewindPreviewResultSchema
>;

export type V4AttachmentBeginParams = z.infer<typeof v4AttachmentBeginParamsSchema>;

export type V4AttachmentBeginResult = z.infer<typeof v4AttachmentBeginResultSchema>;

export type V4AttachmentChunkParams = z.infer<typeof v4AttachmentChunkParamsSchema>;

export type V4AttachmentChunkResult = z.infer<typeof v4AttachmentChunkResultSchema>;

export const v4AttachmentCommitParamsSchema = v4AttachmentTerminalParamsSchema;

export type V4AttachmentCommitResult = z.infer<typeof v4AttachmentCommitResultSchema>;

export const v4AttachmentAbortParamsSchema = v4AttachmentTerminalParamsSchema;

export type V4AttachmentReadResult = z.infer<typeof v4AttachmentReadResultSchema>;

export type V4ConversationAttachmentReadResult = z.infer<
  typeof v4ConversationAttachmentReadResultSchema
>;

export type ConversationSubscribeAck = z.infer<typeof conversationSubscribeAckSchema>;

export type ConversationTopicWireFrame = z.infer<typeof conversationTopicWireFrameSchema>;

export type SessionsIndexTopicWireFrame = z.infer<typeof sessionsIndexTopicWireFrameSchema>;

export type WorkspaceConfigTopicWireFrame = z.infer<typeof workspaceConfigTopicWireFrameSchema>;

export type RoutedTopicFrame = z.infer<typeof routedTopicFrameSchema>;

export const routedTopicWireFrameSchema = z.union([
  conversationTopicWireFrameSchema,
  sessionsIndexTopicWireFrameSchema,
  workspaceConfigTopicWireFrameSchema,
]);

export const V4_NOTIFICATIONS = {
  offPeakLifecycle: "v4/offPeak/lifecycle",
  // 下行帧（snapshot / deltas），params = ConversationTopicFrame。
  conversationFrame: "v4/conversation/frame",
  // 仅 live ingest 的无正文事实；不进入 topic snapshot/recovery。
  conversationTelemetryFact: "v4/telemetry/event",
  localTtftFacts: "v4/telemetry/local-ttft",
  // 仅当前进程 live ToolCallResult 产生；历史与 replayable 链路不得补造。
  cuaPermissionObservation: "v4/cua/permission-observation",
  pluginUiToolResult: "v4/plugin-ui/tool-result",
} as const;

export type V4ConversationSubscribeParams = z.infer<typeof v4ConversationSubscribeParamsSchema>;

// 公共 subscribe response 严格只含 ACK。initial snapshot/resume 由 server 的
// request-scoped post-response outbox 在 response line 之后作为 owned notification 发出。
export const v4ConversationSubscribeResultSchema = z
  .object({
    ack: conversationSubscribeAckSchema,
  })
  .strict();

export type V4AttachmentCommitParams = z.infer<typeof v4AttachmentCommitParamsSchema>;

export type V4AttachmentAbortParams = z.infer<typeof v4AttachmentAbortParamsSchema>;

export type RoutedTopicWireFrame = z.infer<typeof routedTopicWireFrameSchema>;

export type V4ConversationSubscribeResult = z.infer<typeof v4ConversationSubscribeResultSchema>;
