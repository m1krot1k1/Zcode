import { redactFeedbackText } from "@zcode/shared";
import type {
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackCommentAttachment,
  FeedbackDeviceInfo,
  FeedbackListQuery,
  FeedbackTicketDetail,
  FeedbackTicketEvent,
  FeedbackTicketFramework,
  FeedbackTicketSeverity,
  FeedbackTicketStatus,
  FeedbackTicketSummary,
  FeedbackTicketType,
} from "@zcode/shared";
import { resolveClientConfigPlatform } from "#src/runtime-tools/clientPlatform.js";
import type {
  FeedbackApiEnvelope,
  FeedbackAttachmentResponse,
  FeedbackMessageResponse,
  FeedbackTicketDetailResponse,
  FeedbackTicketSummaryResponse,
} from "./types.js";
import {
  isObjectRecord,
  normalizeFeedbackTime,
  readString,
  toStableNumericId,
} from "./valueUtils.js";

export function buildFeedbackListPath(query: FeedbackListQuery): string {
  const params = new URLSearchParams();
  // 新反馈列表接口支持服务端 limit/offset；只在客户端 slice 会导致刷新列表总是拉全量。
  if (query.limit !== undefined && query.limit >= 0) {
    params.set("limit", String(query.limit));
  }
  if (query.offset !== undefined && query.offset >= 0) {
    params.set("offset", String(query.offset));
  }
  const suffix = params.toString();
  return suffix ? `/feedback/ticket?${suffix}` : "/feedback/ticket";
}

export function unwrapFeedbackResponse<T>(value: unknown): T {
  if (!isObjectRecord(value) || !("code" in value)) {
    return value as T;
  }
  const envelope = value as unknown as FeedbackApiEnvelope<T>;
  if (envelope.code !== 0) {
    throw new Error(envelope.msg?.trim() || `Feedback API error ${envelope.code}`);
  }
  return envelope.data;
}

export function toFeedbackEnvironment(input: CreateFeedbackTicketInput): Record<string, unknown> {
  const device = input.device ?? {};
  const environment: Record<string, unknown> = {};
  assignDefined(environment, "app_version", device.appVersion);
  // 反馈后端与 client/configs 使用同一套平台键；传 desktop 会让反馈无法按真实系统架构归类。
  assignDefined(
    environment,
    "platform",
    resolveClientConfigPlatform(device.osPlatform, device.osArch),
  );
  assignDefined(environment, "release_channel", process.env.ZCODE_ENV?.trim() || "stable");
  assignDefined(environment, "os_category", device.osPlatform ?? process.platform);
  assignDefined(environment, "os_version", device.osVersion ?? device.osRelease ?? process.version);
  assignDefined(environment, "build_commit_id", device.buildCommitId);
  assignDefined(environment, "build_time", device.buildTime);
  assignDefined(environment, "electron_version", device.electronVersion);
  assignDefined(environment, "node_version", device.nodeVersion);
  assignDefined(environment, "os_type", device.osType);
  assignDefined(environment, "os_platform", device.osPlatform);
  assignDefined(environment, "os_release", device.osRelease);
  assignDefined(environment, "os_arch", device.osArch);
  assignDefined(environment, "agent_provider", device.agentProvider);
  assignDefined(environment, "agent_framework", device.agentFramework ?? input.framework);
  assignDefined(environment, "agent_model", device.agentModel);
  assignDefined(environment, "agent_model_display", device.agentModelDisplay);
  assignDefined(environment, "source", input.source);
  return environment;
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined || value === null || value === "") {
    return;
  }
  target[key] = typeof value === "string" ? redactFeedbackText(value) : value;
}

export function mapCreatedTicket(
  ticket: FeedbackTicketSummaryResponse,
  input: CreateFeedbackTicketInput,
): FeedbackTicketDetail {
  const createdAt = normalizeFeedbackTime(ticket.created_at);
  const detail: FeedbackTicketDetail = {
    id: ticket.ticket_id,
    title: input.title,
    type: input.type,
    status: mapFeedbackStatus(ticket.status),
    created_at: createdAt,
    updated_at: normalizeFeedbackTime(ticket.updated_at, createdAt),
    description: input.description,
    attachments: [],
    comments: [],
    events: [],
  };
  assignOptionalTicketFields(detail, {
    severity: input.severity,
    module: input.module,
    framework: input.framework,
    reporter: input.reporter ?? null,
    device: input.device ?? null,
  });
  return detail;
}

export function mapTicketSummary(ticket: FeedbackTicketSummaryResponse): FeedbackTicketSummary {
  const createdAt = normalizeFeedbackTime(ticket.created_at);
  return {
    id: ticket.ticket_id,
    title: readString(ticket.title) ?? ticket.ticket_id,
    type: "bug",
    status: mapFeedbackStatus(ticket.status),
    created_at: createdAt,
    updated_at: normalizeFeedbackTime(ticket.updated_at, createdAt),
  };
}

export function mapTicketDetail(ticket: FeedbackTicketDetailResponse): FeedbackTicketDetail {
  const summary = mapTicketSummary(ticket);
  const type = parseFeedbackTicketType(ticket.content?.category, summary.type);
  const severity = parseFeedbackTicketSeverity(ticket.content?.severity);
  const device = environmentToDeviceInfo(ticket.environment);
  const comments = (ticket.messages ?? []).map((message, index) =>
    mapMessageToComment(message, index + 1),
  );
  const detail: FeedbackTicketDetail = {
    ...summary,
    type,
    description: readString(ticket.content?.description) ?? "",
    attachments: (ticket.attachments ?? []).map((attachment, index) =>
      mapAttachment(attachment, index + 1),
    ),
    comments,
    events: buildDetailEvents(summary.created_at, comments),
  };
  assignOptionalTicketFields(detail, { severity, device });
  return detail;
}

function assignOptionalTicketFields(
  target: FeedbackTicketDetail,
  fields: {
    severity?: FeedbackTicketSeverity;
    module?: FeedbackTicketDetail["module"];
    framework?: FeedbackTicketFramework;
    reporter?: FeedbackTicketDetail["reporter"];
    device?: FeedbackDeviceInfo | null;
  },
): void {
  if (fields.severity) target.severity = fields.severity;
  if (fields.module) target.module = fields.module;
  if (fields.framework) target.framework = fields.framework;
  if (fields.reporter !== undefined) target.reporter = fields.reporter;
  if (fields.device !== undefined) target.device = fields.device;
}

function buildDetailEvents(createdAt: string, comments: FeedbackComment[]): FeedbackTicketEvent[] {
  const events: FeedbackTicketEvent[] = [
    {
      id: 1,
      type: "created",
      summary: "已提交",
      created_at: createdAt,
    },
  ];
  comments.forEach((comment, index) => {
    events.push({
      id: index + 2,
      type: comment.is_staff ? "staff_replied" : "user_replied",
      summary: comment.is_staff ? "客服已回复" : "用户补充了反馈",
      payload: { comment_id: comment.id },
      created_at: comment.created_at,
    });
  });
  return events;
}

export function mapMessageToComment(
  message: FeedbackMessageResponse,
  fallbackId: number,
): FeedbackComment {
  const senderType = readString(message.sender_type);
  return {
    id: toStableNumericId(message.message_id, fallbackId),
    // 补充消息附件必须使用原始 message_id 请求上传凭证，数字展示 id 不能反推后端 ID。
    message_id: message.message_id,
    body: readString(message.content?.text) ?? "",
    is_staff: senderType === "staff" || senderType === "admin",
    attachments: (message.attachments ?? []).map((attachment, index) =>
      mapAttachmentToCommentAttachment(attachment, index + 1),
    ),
    created_at: normalizeFeedbackTime(message.created_at),
  };
}

function mapAttachment(
  attachment: FeedbackAttachmentResponse,
  fallbackId: number,
): FeedbackAttachment {
  const filename =
    readString(attachment.file_name) ?? readString(attachment.filename) ?? "attachment";
  const contentType = readString(attachment.content_type);
  return {
    id: toStableNumericId(attachment.attachment_id ?? attachment.id, fallbackId),
    kind: inferAttachmentKind(filename, contentType),
    filename,
    size: typeof attachment.size === "number" ? attachment.size : 0,
    redacted: false,
    content_type: contentType ?? null,
    download_url: readString(attachment.download_url) ?? null,
    preview_url: readString(attachment.preview_url) ?? null,
    created_at: normalizeFeedbackTime(attachment.created_at),
  };
}

function mapAttachmentToCommentAttachment(
  attachment: FeedbackAttachmentResponse,
  fallbackId: number,
): FeedbackCommentAttachment {
  const mapped = mapAttachment(attachment, fallbackId);
  return {
    id: mapped.id,
    filename: mapped.filename,
    size: mapped.size,
    content_type: mapped.content_type,
    download_url: mapped.download_url,
    preview_url: mapped.preview_url,
  };
}

function inferAttachmentKind(
  filename: string,
  contentType?: string | null,
): FeedbackAttachmentKind {
  if (contentType?.startsWith("image/")) {
    return "image";
  }
  if (/\.zip$/i.test(filename)) {
    return "log";
  }
  if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(filename)) {
    return "image";
  }
  return "other";
}

function mapFeedbackStatus(status: unknown): FeedbackTicketStatus {
  switch (readString(status)) {
    case "closed":
    case "已归档":
      return "已归档";
    case "submitted":
    // 兼容后端或历史缓存里仍返回旧中文状态的工单。
    case "待评估":
    case "已提交":
    default:
      return "已提交";
  }
}

function parseFeedbackTicketType(value: unknown, fallback: FeedbackTicketType): FeedbackTicketType {
  switch (readString(value)) {
    case "usage":
      return "usage";
    case "feature":
      return "feature";
    case "performance":
      return "performance";
    case "bug":
      return "bug";
    default:
      return fallback;
  }
}

function parseFeedbackTicketSeverity(value: unknown): FeedbackTicketSeverity | undefined {
  switch (readString(value)) {
    case "P1-高":
      return "P1-高";
    case "P2-中":
      return "P2-中";
    case "P3-低":
      return "P3-低";
    default:
      return undefined;
  }
}

function environmentToDeviceInfo(
  environment: Record<string, unknown> | null | undefined,
): FeedbackDeviceInfo | null {
  if (!environment) {
    return null;
  }
  const device: FeedbackDeviceInfo = {};
  assignDeviceString(device, "appVersion", environment.app_version);
  assignDeviceString(device, "buildCommitId", environment.build_commit_id);
  assignDeviceString(device, "buildTime", environment.build_time);
  assignDeviceString(device, "electronVersion", environment.electron_version);
  assignDeviceString(device, "nodeVersion", environment.node_version);
  assignDeviceString(device, "osType", environment.os_type);
  assignDeviceString(device, "osPlatform", environment.os_platform ?? environment.os_category);
  assignDeviceString(device, "osRelease", environment.os_release);
  assignDeviceString(device, "osVersion", environment.os_version);
  assignDeviceString(device, "osArch", environment.os_arch);
  assignDeviceString(device, "agentProvider", environment.agent_provider);
  assignDeviceString(device, "agentFramework", environment.agent_framework);
  assignDeviceString(device, "agentModel", environment.agent_model);
  assignDeviceString(device, "agentModelDisplay", environment.agent_model_display);
  const optionCount = environment.agent_model_option_count;
  if (typeof optionCount === "number") {
    device.agentModelOptionCount = optionCount;
  }
  const preview = environment.agent_model_options_preview;
  if (Array.isArray(preview)) {
    device.agentModelOptionsPreview = preview.filter(
      (item): item is string => typeof item === "string",
    );
  }
  return Object.keys(device).length > 0 ? device : null;
}

function assignDeviceString(
  target: FeedbackDeviceInfo,
  key: keyof FeedbackDeviceInfo,
  value: unknown,
): void {
  const stringValue = readString(value);
  if (stringValue) {
    (target as Record<string, unknown>)[key] = stringValue;
  }
}
