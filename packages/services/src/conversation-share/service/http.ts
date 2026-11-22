import type {
  ConversationShareConfirmRequest,
  ConversationShareRecord,
} from "@zcode/shared";

import { ConversationShareServiceError } from "../conversationShare.js";
import { ConversationShareClientError } from "../conversationShareHttpClient.js";

import type { ConversationSharePublicArtifact } from "../conversationSharePublicProjection.js";
import {
  throwServiceError,
  type ConversationShareServiceRuntime,
} from "./runtime.js";

/**
 * 安全检查非终态（3215）的有界串行轮询。
 *
 * 同一 preparation/DTO 必须串行重试；不能重新 prepare，也不能无限等待。
 * 超时是终态错误，把最后一次 requestId/status/code 带进 diagnostics 供排障。
 */
export async function confirmUntilReady(
  runtime: Pick<
    ConversationShareServiceRuntime,
    | "client"
    | "now"
    | "sleep"
    | "confirmPollIntervalMs"
    | "confirmPollTimeoutMs"
  >,
  preparationId: string,
  request: ConversationShareConfirmRequest,
): Promise<ConversationShareRecord> {
  let deadline: number | undefined;
  let lastRequestId: string | undefined;
  let lastStatus: number | undefined;
  let lastCode: number | undefined;
  while (true) {
    try {
      return await runtime.client.confirm(preparationId, request);
    } catch (error) {
      if (
        !(error instanceof ConversationShareClientError) ||
        error.kind !== "safety_check_pending"
      ) {
        throw error;
      }
      lastRequestId = error.requestId ?? lastRequestId;
      lastStatus = error.status ?? lastStatus;
      lastCode = error.code ?? lastCode;

      // 3215 是后端安全检查的非终态，同一 preparation/DTO 必须串行重试；
      // 不能重新 prepare，也不能无限等待。
      const currentTime = runtime.now();
      deadline ??= currentTime + runtime.confirmPollTimeoutMs;
      const remainingMs = deadline - currentTime;
      if (remainingMs <= 0) {
        throw new ConversationShareServiceError(
          "safety_check_timeout",
          "Conversation share safety check timed out",
          {
            ...(lastRequestId === undefined
              ? {}
              : { requestId: lastRequestId }),
            ...(lastStatus === undefined ? {} : { status: lastStatus }),
            ...(lastCode === undefined ? {} : { code: lastCode }),
          },
        );
      }
      const requestedDelayMs =
        error.retryAfterMs ?? runtime.confirmPollIntervalMs;
      await runtime.sleep(Math.min(requestedDelayMs, remainingMs));
      if (runtime.now() >= deadline) {
        throw new ConversationShareServiceError(
          "safety_check_timeout",
          "Conversation share safety check timed out",
          {
            ...(lastRequestId === undefined
              ? {}
              : { requestId: lastRequestId }),
            ...(lastStatus === undefined ? {} : { status: lastStatus }),
            ...(lastCode === undefined ? {} : { code: lastCode }),
          },
        );
      }
    }
  }
}

/**
 * 按 manifest 顺序上传，并逐项核对服务端回执。
 *
 * 回执与清单不一致时立即终止：继续上传只会得到一个“缺文件”的分享链接。
 */
export async function uploadPublicationArtifacts(
  runtime: Pick<ConversationShareServiceRuntime, "client">,
  preparationId: string,
  artifacts: readonly ConversationSharePublicArtifact[],
  bytesBySourceRef: ReadonlyMap<string, Uint8Array>,
  onProgress: (uploadedArtifacts: number, totalArtifacts: number) => void,
): Promise<number> {
  let uploadedArtifacts = 0;
  for (const artifact of artifacts) {
    const bytes = bytesBySourceRef.get(artifact.sourceRef);
    if (!bytes) {
      throwServiceError(
        "invalid_conversation",
        "Conversation artifact bytes are missing from the publication snapshot",
      );
    }
    const upload = await runtime.client.uploadArtifact(
      preparationId,
      artifact.descriptor,
      new Blob([Uint8Array.from(bytes).buffer], {
        type: artifact.descriptor.mime_type,
      }),
    );
    if (
      upload.artifact_id !== artifact.descriptor.artifact_id ||
      upload.size_bytes !== artifact.descriptor.size_bytes ||
      upload.sha256 !== artifact.descriptor.sha256
    ) {
      throw new ConversationShareServiceError(
        "upload_incomplete",
        "Conversation artifact upload acknowledgement does not match the manifest",
        {
          issues: [
            {
              code: "upload_incomplete",
              scope: "artifact",
              artifactDisplayName: artifact.descriptor.display_name,
              artifactType: artifact.descriptor.artifact_type,
              extension: artifact.descriptor.extension,
              mimeType: artifact.descriptor.mime_type,
              actual: upload.size_bytes,
              limit: artifact.descriptor.size_bytes,
            },
          ],
        },
      );
    }
    uploadedArtifacts += 1;
    onProgress(uploadedArtifacts, artifacts.length);
  }
  return uploadedArtifacts;
}
