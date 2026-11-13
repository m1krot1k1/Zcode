import type { ApiClient } from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

export interface FeedbackHttpClientOptions {
  baseUrl: string;
  apiClient: ApiClient;
  getAuthHeaders: () => Promise<Record<string, string>>;
  logger?: ServiceLogger;
}

export interface FeedbackUploadProgressEvent {
  uploadedBytes: number;
  totalBytes: number;
}

export interface FeedbackUploadFileOptions {
  messageId?: string;
  onUploadProgress?: (event: FeedbackUploadProgressEvent) => void;
  signal?: AbortSignal;
}

export interface FeedbackCreateRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface FeedbackApiEnvelope<T> {
  code: number;
  msg?: string;
  data: T;
}

export interface FeedbackTicketSummaryResponse {
  ticket_id: string;
  device_mid?: string;
  title?: string | null;
  status?: string | null;
  created_at?: number | string | null;
  updated_at?: number | string | null;
}

export interface FeedbackTicketDetailResponse extends FeedbackTicketSummaryResponse {
  content?: {
    description?: string | null;
    category?: string | null;
    function?: string | null;
    severity?: string | null;
  } | null;
  environment?: Record<string, unknown> | null;
  attachments?: FeedbackAttachmentResponse[] | null;
  messages?: FeedbackMessageResponse[] | null;
}

export interface FeedbackMessageResponse {
  message_id: string;
  ticket_id?: string;
  sender_type?: string | null;
  content?: { text?: string | null } | null;
  attachments?: FeedbackAttachmentResponse[] | null;
  created_at?: number | string | null;
}

export interface FeedbackAttachmentResponse {
  attachment_id?: string | number | null;
  id?: string | number | null;
  file_name?: string | null;
  filename?: string | null;
  size?: number | null;
  content_type?: string | null;
  download_url?: string | null;
  preview_url?: string | null;
  created_at?: number | string | null;
}

export interface FeedbackUploadCredentialResponse {
  attachment_id: string;
  max_size: number;
  callback: {
    url: string;
    body: string;
    content_type: string;
  };
  oss: {
    host: string;
    path: string;
    policy: string;
    x_oss_signature: string;
    x_oss_signature_version: string;
    x_oss_credential: string;
    x_oss_security_token: string;
    x_oss_date: string;
  };
}

export const FEEDBACK_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const FEEDBACK_MAX_LOG_ATTACHMENT_BYTES = 1024 * 1024 * 1024;
export const FEEDBACK_CREATE_TIMEOUT_MS = 30_000;
