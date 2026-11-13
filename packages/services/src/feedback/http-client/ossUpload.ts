import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { FeedbackAttachmentKind } from "@zcode/shared";
import { FeedbackUploadCanceledError } from "./errors.js";
import {
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_LOG_ATTACHMENT_BYTES,
  type FeedbackUploadCredentialResponse,
  type FeedbackUploadProgressEvent,
} from "./types.js";

export function getFeedbackMaxAttachmentBytes(kind: FeedbackAttachmentKind): number {
  return kind === "log" ? FEEDBACK_MAX_LOG_ATTACHMENT_BYTES : FEEDBACK_MAX_ATTACHMENT_BYTES;
}

export async function uploadOssForm(
  credential: FeedbackUploadCredentialResponse,
  filePath: string,
  filename: string,
  contentType: string,
  options: {
    size: number;
    onUploadProgress?: (event: FeedbackUploadProgressEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const uploadUrl = new URL(credential.oss.host);
    const requestImpl = uploadUrl.protocol === "https:" ? httpsRequest : httpRequest;
    const boundary = `----zcode-feedback-${randomUUID()}`;
    const fields = buildOssFormFields(credential);
    const fieldBuffers = fields.map(([name, value]) => createMultipartField(boundary, name, value));
    const fileHeader = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${escapeMultipartValue(filename)}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    );
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength =
      fieldBuffers.reduce((total, buffer) => total + buffer.byteLength, 0) +
      fileHeader.byteLength +
      options.size +
      closing.byteLength;
    let uploadedBytes = 0;
    let settled = false;
    let stream: ReturnType<typeof createReadStream> | null = null;

    if (options.signal?.aborted) {
      reject(new FeedbackUploadCanceledError());
      return;
    }

    const req = requestImpl(
      uploadUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(contentLength),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            const body = Buffer.concat(chunks).toString("utf8");
            reject(new Error(`OSS upload failed: HTTP ${statusCode}${body ? `: ${body}` : ""}`));
            return;
          }
          options.onUploadProgress?.({
            uploadedBytes: options.size,
            totalBytes: options.size,
          });
          resolve();
        });
      },
    );

    const abortUpload = () => {
      if (settled) return;
      settled = true;
      const error = new FeedbackUploadCanceledError();
      stream?.destroy(error);
      req.destroy(error);
      reject(error);
    };
    options.signal?.addEventListener("abort", abortUpload, { once: true });

    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(options.signal?.aborted ? new FeedbackUploadCanceledError() : error);
    });

    for (const buffer of fieldBuffers) {
      req.write(buffer);
    }
    req.write(fileHeader);

    stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      stream?.pause();
      uploadedBytes += Buffer.byteLength(chunk);
      // 这里按文件内容进度上报，不把 multipart 表单头尾计入用户可见进度。
      options.onUploadProgress?.({
        uploadedBytes: Math.min(uploadedBytes, options.size),
        totalBytes: options.size,
      });
      const canContinue = req.write(chunk, () => {
        if (stream && !stream.destroyed) {
          stream.resume();
        }
      });
      if (!canContinue) {
        req.once("drain", () => {
          if (stream && !stream.destroyed) {
            stream.resume();
          }
        });
      }
    });
    stream.on("error", (error) => {
      req.destroy(error);
    });
    stream.on("end", () => {
      req.write(closing);
      req.end();
    });
  });
}

function buildOssFormFields(credential: FeedbackUploadCredentialResponse): Array<[string, string]> {
  const encodedCallback = Buffer.from(
    JSON.stringify({
      callbackUrl: credential.callback.url,
      callbackBody: credential.callback.body,
      callbackBodyType: credential.callback.content_type,
    }),
    "utf-8",
  ).toString("base64");
  const fields: Array<[string, string]> = [
    ["key", credential.oss.path],
    ["policy", credential.oss.policy],
    ["x-oss-signature", credential.oss.x_oss_signature],
    ["x-oss-signature-version", credential.oss.x_oss_signature_version],
    ["x-oss-credential", credential.oss.x_oss_credential],
    ["x-oss-security-token", credential.oss.x_oss_security_token],
    ["x-oss-date", credential.oss.x_oss_date],
    ["callback", encodedCallback],
    ["success_action_status", "200"],
  ];
  return fields.filter(([, value]) => value);
}

function createMultipartField(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeMultipartValue(name)}"\r\n\r\n` +
      `${value}\r\n`,
  );
}

function escapeMultipartValue(value: string): string {
  return value.replace(/["\r\n]/g, "_");
}
