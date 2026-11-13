import { basename } from "node:path";

import type { ConversationShareContinuation } from "@zcode/shared";

import {
  ConversationShareServiceError,
  type ConversationShareFailureIssue,
} from "../conversationShare.js";

import type { ConversationShareServiceRuntime } from "./runtime.js";

export function sanitizeFileSegment(value: string): string {
  const forbidden = new Set(["<", ">", ":", '"', "/", "\\", "|", "?", "*"]);
  return [...value.normalize("NFKC")]
    .map((character) =>
      character.codePointAt(0)! < 32 || forbidden.has(character)
        ? "-"
        : character,
    )
    .join("");
}

export function uniqueImportedFileName(
  displayName: string,
  artifactId: string,
  usedNames: Set<string>,
): string {
  const base =
    sanitizeFileSegment(basename(displayName.replace(/\\/gu, "/")))
      .replace(/^[. ]+|[. ]+$/gu, "")
      .slice(0, 180) || "artifact";
  let candidate = base;
  if (usedNames.has(candidate.toLowerCase())) {
    const dot = base.lastIndexOf(".");
    const suffix =
      artifactId.replace(/[^A-Za-z0-9]/gu, "").slice(-8) || "artifact";
    candidate =
      dot > 0
        ? `${base.slice(0, dot)}-${suffix}${base.slice(dot)}`
        : `${base}-${suffix}`;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

/**
 * 下载单个 artifact 的字节：带单请求超时（含读 body）与 Content-Length 预检。
 *
 * download 兜底不能是裸 fetch（无 AbortSignal），且 size/SHA-256 校验不能在
 * arrayBuffer() 之后才执行——挂住的连接会让导入无限停在 downloading 阶段（undici 默认
 * ~300s 兜底，体验上等于卡死）；被篡改的存储还能让客户端先把超大 payload 全量读进内存
 * 再发现不符。超时按 network 失败；Content-Length 声明超过 manifest 的 size_bytes 时
 * 在读 body 前直接判 integrity 失败并中断连接——完整性校验放在无界下载之后只保证
 * 正确性，不保护客户端资源。
 */
export async function downloadArtifactBytes(
  runtime: Pick<
    ConversationShareServiceRuntime,
    "download" | "downloadTimeoutMs"
  >,
  artifact: ConversationShareContinuation["artifacts"][number],
): Promise<{ bytes: Uint8Array; responseMimeType?: string }> {
  const artifactIssue = (
    code: ConversationShareFailureIssue["code"],
    extra?: { actual?: number; limit?: number },
  ): ConversationShareFailureIssue => ({
    code,
    scope: "artifact",
    artifactDisplayName: artifact.display_name,
    artifactType: artifact.artifact_type,
    extension: artifact.extension,
    mimeType: artifact.mime_type,
    phase: "downloading",
    ...(extra?.actual === undefined ? {} : { actual: extra.actual }),
    ...(extra?.limit === undefined ? {} : { limit: extra.limit }),
  });
  const controller = new AbortController();
  const abortTimer = setTimeout(
    () => controller.abort(),
    runtime.downloadTimeoutMs,
  );
  try {
    const response = await runtime.download(artifact.download_url, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ConversationShareServiceError(
        "network",
        "Conversation artifact download failed",
        { issues: [artifactIssue("unknown")] },
      );
    }
    const declaredBytes = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredBytes) && declaredBytes > artifact.size_bytes) {
      // body 已确定不会通过校验：先中断连接再抛错，不把超大响应读进内存。
      controller.abort();
      throw new ConversationShareServiceError(
        "invalid_contract",
        "Conversation artifact integrity check failed",
        {
          issues: [
            artifactIssue("artifact_changed", {
              actual: declaredBytes,
              limit: artifact.size_bytes,
            }),
          ],
        },
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const responseMimeType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim();
    return { bytes, responseMimeType };
  } catch (error) {
    if (
      controller.signal.aborted &&
      !(error instanceof ConversationShareServiceError)
    ) {
      throw new ConversationShareServiceError(
        "network",
        "Conversation artifact download timed out",
        {
          issues: [artifactIssue("unknown")],
        },
      );
    }
    throw error;
  } finally {
    clearTimeout(abortTimer);
  }
}
