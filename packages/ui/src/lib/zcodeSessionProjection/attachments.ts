import {
  type ZCodePromptAttachment,
  type ZCodeMessagePart,
} from "@zcode/shared";
import { asRecord, numberValue, stringValue } from "./primitives.js";

export function mapPromptAttachmentsFromParts(
  parts: readonly ZCodeMessagePart[],
): ZCodePromptAttachment[] | undefined {
  const attachments = parts
    .filter(
      (part): part is Extract<ZCodeMessagePart, { type: "file" }> =>
        part.type === "file",
    )
    .map(mapPromptAttachmentFromFilePart)
    .filter(
      (attachment): attachment is ZCodePromptAttachment =>
        attachment !== undefined,
    );
  return attachments.length > 0 ? attachments : undefined;
}

function mapPromptAttachmentFromFilePart(
  part: Extract<ZCodeMessagePart, { type: "file" }>,
): ZCodePromptAttachment | undefined {
  const mimeType = part.mime || "application/octet-stream";
  const metadata = asRecord(part.metadata);
  const filename =
    part.filename?.trim() || filenameFromPathLike(part.url) || "attachment";
  const sizeBytes = numberValue(metadata.sizeBytes);
  const dataBase64 = dataBase64FromDataUrl(part.url);
  const localPath = localPathFromAttachmentPart(part.url, metadata);

  // Bugfix: desktop-continuous 历史恢复走 session projection，不经过 legacy task adapter。
  // file part 若不反投影成 attachments，用户发送过的图片/文件会在恢复 UI 里消失。
  if (mimeType.startsWith("image/")) {
    return {
      kind: "image",
      filename,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.startsWith("audio/")) {
    return {
      kind: "audio",
      filename,
      mimeType,
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.startsWith("video/")) {
    return {
      kind: "video",
      filename,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf") {
    return {
      kind: "pdf",
      filename,
      mimeType: "application/pdf",
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  const preview = asRecord(metadata.preview);
  const textContent = !localPath ? stringValue(preview.text) : undefined;
  return {
    kind: "file",
    filename,
    mimeType,
    sizeBytes: sizeBytes ?? 0,
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(textContent !== undefined ? { textContent } : {}),
    ...(localPath ? { localPath } : {}),
  };
}

function dataBase64FromDataUrl(value: string): string | undefined {
  const commaIndex = value.indexOf(",");
  if (
    value.slice(0, "data:".length).toLowerCase() !== "data:" ||
    commaIndex < 0
  ) {
    return undefined;
  }
  const headerParts = value.slice("data:".length, commaIndex).split(";");
  if (headerParts.at(-1)?.trim().toLowerCase() !== "base64") return undefined;
  return value.slice(commaIndex + 1) || undefined;
}

function localPathFromAttachmentPart(
  url: string,
  metadata: Record<string, unknown>,
): string | undefined {
  const originalUrl = stringValue(metadata.originalUrl);
  if (originalUrl && isAbsolutePathLike(originalUrl)) {
    return originalUrl;
  }
  return isAbsolutePathLike(url) ? url : undefined;
}

function isAbsolutePathLike(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\")
  );
}

function filenameFromPathLike(value: string): string | undefined {
  if (value.startsWith("data:")) {
    return undefined;
  }
  const pathPart = value.split(/[?#]/u)[0] ?? "";
  const segments = pathPart.split(/[\\/]/u).filter(Boolean);
  const filename = segments.at(-1)?.trim();
  return filename && !filename.includes("://") ? filename : undefined;
}
