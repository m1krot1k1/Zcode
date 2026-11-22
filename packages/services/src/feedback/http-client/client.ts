import { stat } from "node:fs/promises";

import { redactFeedbackText } from "@zcode/shared";
import type {
  ApiRequestInit,
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackTicketDetail,
} from "@zcode/shared";
import { getNetworkErrorCodes } from "#src/providers/api/networkErrorClassifier.js";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import { FeedbackUploadCanceledError } from "./errors.js";
import {
  getErrorMessage,
  getHeaderValue,
  mergeFeedbackRequestHeaders,
  readResponseError,
} from "./httpUtils.js";
import { getFeedbackMaxAttachmentBytes, uploadOssForm } from "./ossUpload.js";
import {
  readEnvelopeCode,
  resolveLogger,
  sanitizeFeedbackLogUrl,
  summarizeRequestBody,
} from "./requestLogging.js";
import { requestWithHandshakeRetry } from "./requestRetry.js";
import {
  buildFeedbackListPath,
  mapCreatedTicket,
  mapMessageToComment,
  mapTicketDetail,
  mapTicketSummary,
  toFeedbackEnvironment,
  unwrapFeedbackResponse,
} from "./ticketMapping.js";
import {
  FEEDBACK_CREATE_TIMEOUT_MS,
  type FeedbackCreateRequestOptions,
  type FeedbackHttpClientOptions,
  type FeedbackMessageResponse,
  type FeedbackTicketDetailResponse,
  type FeedbackTicketSummaryResponse,
  type FeedbackUploadCredentialResponse,
  type FeedbackUploadFileOptions,
} from "./types.js";
import { toStableNumericId } from "./valueUtils.js";

export class FeedbackHttpClient {
  constructor(private readonly options: FeedbackHttpClientOptions) {}

  private get apiBaseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  private get logger(): ServiceLogger {
    return resolveLogger(this.options.logger);
  }

  private async request<T>(
    path: string,
    init?: ApiRequestInit,
    authHeaders?: Record<string, string>,
  ): Promise<T> {
    const headers = mergeFeedbackRequestHeaders(
      authHeaders ?? (await this.options.getAuthHeaders()),
      init?.headers,
    );
    const url = `${this.apiBaseUrl}${path}`;
    const method = init?.method ?? "GET";
    const requestId = getHeaderValue(headers, "x-request-id");
    const logContext = {
      method,
      url: sanitizeFeedbackLogUrl(url),
      requestId,
      hasAuthorization: Boolean(getHeaderValue(headers, "Authorization")),
      hasDeviceMid: Boolean(getHeaderValue(headers, "X-Device-Mid")),
      acceptLanguage: getHeaderValue(headers, "Accept-Language"),
      body: summarizeRequestBody(path, method, init?.body),
    };
    const startedAt = Date.now();
    let requestAttemptCount = 1;
    this.logger.info(undefined, "反馈 HTTP 请求开始", logContext);
    let response: Response;
    try {
      response = await requestWithHandshakeRetry(
        () =>
          this.options.apiClient.request(url, {
            ...init,
            headers,
          }),
        ({ attempt, error, nextAttempt }) => {
          requestAttemptCount = nextAttempt;
          this.logger.warn(undefined, "反馈 HTTP 建连失败，准备重试", {
            ...logContext,
            attempt,
            nextAttempt,
            maxAttempts: 3,
            error: getErrorMessage(error),
            errorCodes: getNetworkErrorCodes(error),
          });
        },
      );
    } catch (error) {
      this.logger.warn(undefined, "反馈 HTTP 请求网络失败", {
        ...logContext,
        durationMs: Date.now() - startedAt,
        attemptCount: requestAttemptCount,
        error: getErrorMessage(error),
        errorCodes: getNetworkErrorCodes(error),
      });
      throw error;
    }
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      const message = await readResponseError(response);
      this.logger.warn(undefined, "反馈 HTTP 请求失败", {
        ...logContext,
        durationMs,
        status: response.status,
        statusText: response.statusText,
        msg: message,
      });
      throw new Error(message);
    }
    if (response.status === 204) {
      this.logger.info(undefined, "反馈 HTTP 请求成功", {
        ...logContext,
        durationMs,
        status: response.status,
      });
      return undefined as T;
    }
    let responseJson: unknown;
    try {
      responseJson = await response.json();
    } catch (error) {
      this.logger.warn(undefined, "反馈 HTTP 响应解析失败", {
        ...logContext,
        durationMs,
        status: response.status,
        error: getErrorMessage(error),
      });
      throw error;
    }
    try {
      const result = unwrapFeedbackResponse<T>(responseJson);
      this.logger.info(undefined, "反馈 HTTP 请求成功", {
        ...logContext,
        durationMs,
        status: response.status,
        code: readEnvelopeCode(responseJson),
      });
      return result;
    } catch (error) {
      this.logger.warn(undefined, "反馈 HTTP 请求业务失败", {
        ...logContext,
        durationMs,
        status: response.status,
        code: readEnvelopeCode(responseJson),
        msg: getErrorMessage(error),
      });
      throw error;
    }
  }

  async create(
    input: CreateFeedbackTicketInput,
    options: FeedbackCreateRequestOptions = {},
  ): Promise<FeedbackTicketDetail> {
    const authHeaders = await this.options.getAuthHeaders();
    const deviceMid = getHeaderValue(authHeaders, "X-Device-Mid");
    if (!deviceMid) {
      throw new Error("Missing feedback device_mid");
    }
    const { locale } = input;
    const ticket = await this.request<FeedbackTicketSummaryResponse>(
      "/feedback/ticket",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(locale ? { "Accept-Language": locale } : {}),
        },
        // 创建工单是用户可见的第一阶段，不能无限等待网络或后端悬挂。
        // 超时和取消都收敛到统一 ApiClient，避免 UI 停在“正在连接反馈服务”。
        timeoutMs: options.timeoutMs ?? FEEDBACK_CREATE_TIMEOUT_MS,
        signal: options.signal,
        body: JSON.stringify({
          title: redactFeedbackText(input.title),
          device_mid: deviceMid,
          content: {
            description: redactFeedbackText(input.description),
            category: input.type,
            function: input.module,
            severity: input.severity,
          },
          contact: input.contact,
          environment: toFeedbackEnvironment(input),
        }),
      },
      authHeaders,
    );
    return mapCreatedTicket(ticket, input);
  }

  async list(query: FeedbackListQuery = {}): Promise<FeedbackListResult> {
    const result = await this.request<{ items?: FeedbackTicketSummaryResponse[] }>(
      buildFeedbackListPath(query),
    );
    const mapped = (result.items ?? []).map((item) => mapTicketSummary(item));
    const filtered = mapped.filter((item) => {
      if (query.status && item.status !== query.status) return false;
      if (query.type && item.type !== query.type) return false;
      return true;
    });
    return {
      items: filtered,
      total: filtered.length,
    };
  }

  async get(id: string): Promise<FeedbackTicketDetail> {
    const ticket = await this.request<FeedbackTicketDetailResponse>(
      `/feedback/ticket/${encodeURIComponent(id)}`,
    );
    return mapTicketDetail(ticket);
  }

  async comment(id: string, body: string): Promise<FeedbackComment> {
    const message = await this.request<FeedbackMessageResponse>(
      `/feedback/ticket/${encodeURIComponent(id)}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { text: redactFeedbackText(body) } }),
      },
    );
    return mapMessageToComment(message, 1);
  }

  async uploadFile(
    ticketId: string,
    kind: FeedbackAttachmentKind,
    filePath: string,
    filename: string,
    contentType: string,
    options?: FeedbackUploadFileOptions,
  ): Promise<FeedbackAttachment> {
    if (options?.signal?.aborted) {
      throw new FeedbackUploadCanceledError();
    }
    const fileStats = await stat(filePath);
    const maxAttachmentBytes = getFeedbackMaxAttachmentBytes(kind);
    if (fileStats.size > maxAttachmentBytes) {
      // 日志附件允许上传到 1GB；普通反馈附件仍保持较小上限。
      // 客户端先校验可以避免无意义请求，并给 UI 返回稳定错误。
      throw new Error(`Feedback attachment exceeds max size ${maxAttachmentBytes}`);
    }
    const credential = await this.request<FeedbackUploadCredentialResponse>(
      "/feedback/attachment/upload-credential",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticket_id: ticketId,
          ...(options?.messageId ? { message_id: options.messageId } : {}),
          file_name: filename,
          size: fileStats.size,
        }),
      },
    );
    if (fileStats.size > credential.max_size) {
      throw new Error(`Feedback attachment exceeds max size ${credential.max_size}`);
    }
    await uploadOssForm(credential, filePath, filename, contentType, {
      size: fileStats.size,
      onUploadProgress: options?.onUploadProgress,
      signal: options?.signal,
    });
    return {
      id: toStableNumericId(credential.attachment_id, 1),
      kind,
      filename,
      size: fileStats.size,
      redacted: false,
      content_type: contentType,
      download_url: null,
      preview_url: null,
      created_at: new Date().toISOString(),
    };
  }
}
