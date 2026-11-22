import { extname } from "node:path";

import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import { isObjectRecord } from "./valueUtils.js";

const defaultLogger = createServiceLogger("feedback-http");

export function readEnvelopeCode(value: unknown): number | undefined {
  if (!isObjectRecord(value)) {
    return undefined;
  }
  const { code } = value;
  return typeof code === "number" ? code : undefined;
}

function summarizeStringField(value: unknown): { present: boolean; length?: number } {
  if (typeof value !== "string") {
    return { present: false };
  }
  return { present: true, length: value.length };
}

function summarizeFileNameField(value: unknown): {
  present: boolean;
  length?: number;
  extension?: string;
} {
  const summary = summarizeStringField(value);
  if (typeof value !== "string") {
    return summary;
  }
  const extension = extname(value);
  return extension ? { ...summary, extension } : summary;
}

function summarizeFeedbackCreateBody(body: Record<string, unknown>): Record<string, unknown> {
  const content = isObjectRecord(body.content) ? body.content : {};
  const environment = isObjectRecord(body.environment) ? body.environment : {};
  return {
    fields: Object.keys(body).sort(),
    title: summarizeStringField(body.title),
    hasDeviceMid: typeof body.device_mid === "string" && body.device_mid.length > 0,
    content: {
      fields: Object.keys(content).sort(),
      description: summarizeStringField(content.description),
      category: typeof content.category === "string" ? content.category : undefined,
      function: typeof content.function === "string" ? content.function : undefined,
      severity: typeof content.severity === "string" ? content.severity : undefined,
    },
    contact: summarizeStringField(body.contact),
    environment: {
      fields: Object.keys(environment).sort(),
      appVersion: environment.app_version,
      platform: environment.platform,
      releaseChannel: environment.release_channel,
      osCategory: environment.os_category,
      osVersion: environment.os_version,
      source: environment.source,
    },
  };
}

function summarizeUploadCredentialBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    fields: Object.keys(body).sort(),
    hasTicketId: typeof body.ticket_id === "string" && body.ticket_id.length > 0,
    hasMessageId: typeof body.message_id === "string" && body.message_id.length > 0,
    fileName: summarizeFileNameField(body.file_name),
    size: typeof body.size === "number" ? body.size : undefined,
  };
}

export function summarizeRequestBody(
  path: string,
  method: string,
  body: RequestInit["body"] | null | undefined,
): Record<string, unknown> | undefined {
  if (typeof body !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isObjectRecord(parsed)) {
      return { jsonType: typeof parsed };
    }
    // 反馈创建失败时 RPC 日志只记录了 database error，缺少 HTTP 边界证据。
    // 这里仅记录字段和值摘要，避免把用户反馈正文、联系方式、token 或完整设备 ID 写入日志。
    if (method.toUpperCase() === "POST" && path === "/feedback/ticket") {
      return summarizeFeedbackCreateBody(parsed);
    }
    // 日志包超出反馈后端单附件限制时只返回 parameter error；
    // 上传凭证日志需要记录脱敏后的 file_name/size，才能从客户端侧定位是哪个附件被拒绝。
    if (method.toUpperCase() === "POST" && path === "/feedback/attachment/upload-credential") {
      return summarizeUploadCredentialBody(parsed);
    }
    return { fields: Object.keys(parsed).sort() };
  } catch {
    return { unparsable: true, length: body.length };
  }
}

export function sanitizeFeedbackLogUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // 工单详情和消息路径包含 ticket id，完整 URL 落盘会泄露用户工单标识。
    // 日志只保留目标 origin 和路由模板，并移除查询参数，实际请求仍使用原始 URL。
    const pathname = parsed.pathname.replace(/(\/feedback\/ticket\/)[^/]+(?=\/|$)/, "$1:ticketId");
    return `${parsed.origin}${pathname}`;
  } catch {
    return "<invalid-feedback-url>";
  }
}

export function resolveLogger(logger: ServiceLogger | undefined): ServiceLogger {
  return logger ?? defaultLogger;
}
