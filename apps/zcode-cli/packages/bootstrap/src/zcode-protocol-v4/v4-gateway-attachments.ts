// V4 conversation gateway 的领域模块（从 v4-gateway 拆出）：attachmentBegin / attachmentChunk / attachmentCommit 等。
// 状态与宿主出口一律经 GatewayContext 显式传入，模块自身不持有状态。

import { isFileSystemPortError, type FileSystemErrorCode } from "@zcode/contracts";
import { extractMarkdownArtifactImageRefs } from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  readZCodeAttachmentFaultCode,
  v4AttachmentAbortParamsSchema,
  v4AttachmentBeginParamsSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  type AttachmentRef,
  type V4AttachmentBeginResult,
  type V4AttachmentChunkResult,
  type V4AttachmentCommitResult,
  type V4AttachmentPreviewSourceResult,
  type V4AttachmentReadResult,
  type V4ConversationAttachmentReadResult,
  type V4ConversationAttachmentStatResult,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { GatewayContext } from "./v4-gateway-context.js";

/** begin 只 admission metadata，不解码/暂存 full payload。 */
export async function attachmentBegin(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4AttachmentBeginResult> {
  const params = v4AttachmentBeginParamsSchema.parse(rawParams);
  if (!ctx.host.putSessionAttachment) {
    throw new Error("fault.attachment.putUnsupported");
  }
  if (!ctx.host.sessionExists(params.sessionId)) {
    await ctx.coldResume.ensureResumed(params.sessionId);
  }
  return ctx.attachmentUploads.begin(params);
}

export async function attachmentChunk(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4AttachmentChunkResult> {
  return ctx.attachmentUploads.chunk(v4AttachmentChunkParamsSchema.parse(rawParams));
}

export function attachmentCommit(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4AttachmentCommitResult> {
  return ctx.attachmentUploads.commit(v4AttachmentCommitParamsSchema.parse(rawParams));
}

export async function attachmentAbort(ctx: GatewayContext, rawParams: unknown): Promise<void> {
  await ctx.attachmentUploads.abort(v4AttachmentAbortParamsSchema.parse(rawParams));
}

export async function attachmentRead(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4AttachmentReadResult> {
  const params = v4AttachmentReadParamsSchema.parse(rawParams);
  if (!ctx.host.readSessionAttachment) {
    throw new Error("fault.attachment.readUnsupported");
  }
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.host.sessionExists(params.sessionId)
      ? await ctx.ensureColdReadyPublisher(params.sessionId)
      : await ctx.hydratePublisher(params.sessionId);
  const resolution = ctx.resolveReadableMediaAttachment(
    publisher,
    params.sessionId,
    params.ref,
    params.target,
    params.attachmentIndex,
  );
  if (!resolution) {
    // renderer 传来的 ref 不能直接成为文件路径；必须先由当前 session
    // 的权威 user row 证明归属，避免跨 session 或任意路径读取。
    throw new Error("fault.attachment.previewRefNotAuthorized");
  }

  const payload = await ctx.readAttachmentPayload(
    params.sessionId,
    params.ref,
    resolution.attachment.mime,
    resolution.messageId,
    resolution.attachmentIndex,
  );
  if (params.offset > payload.bytes.byteLength) {
    throw new Error("fault.attachment.previewRangeInvalid");
  }
  const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
  const chunk = payload.bytes.subarray(params.offset, end);
  return {
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: payload.mediaType,
    totalBytes: payload.bytes.byteLength,
    nextOffset: end < payload.bytes.byteLength ? end : null,
  };
}

export async function conversationAttachmentRead(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationAttachmentReadResult> {
  const params = v4ConversationAttachmentReadParamsSchema.parse(rawParams);
  if (!ctx.host.readSessionAttachment) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.readUnsupported);
  }
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.host.sessionExists(params.sessionId)
      ? await ctx.ensureColdReadyPublisher(params.sessionId)
      : await ctx.hydratePublisher(params.sessionId);
  const row = publisher
    .getSnapshot()
    .rows.window.find(
      (candidate) =>
        candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
    );
  if (row?.kind !== "userInput") {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
  }
  const attachment = row.attachments?.[params.attachmentIndex];
  if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized);
  }
  const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
  let payload: { bytes: Uint8Array; mediaType: string };
  try {
    payload = await ctx.readAttachmentPayload(
      params.sessionId,
      params.ref,
      attachment.mime,
      messageId,
      params.attachmentIndex,
      true,
    );
  } catch (error) {
    throw toShareStatFault(error);
  }
  if (params.offset > payload.bytes.byteLength) {
    throw new Error("fault.attachment.previewRangeInvalid");
  }
  const end = Math.min(payload.bytes.byteLength, params.offset + params.limit);
  const chunk = payload.bytes.subarray(params.offset, end);
  return v4ConversationAttachmentReadResultSchema.parse({
    dataBase64: Buffer.from(chunk).toString("base64"),
    mediaType: payload.mediaType,
    totalBytes: payload.bytes.byteLength,
    nextOffset: end < payload.bytes.byteLength ? end : null,
  });
}

export async function conversationAttachmentStat(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4ConversationAttachmentStatResult> {
  const params = v4ConversationAttachmentStatParamsSchema.parse(rawParams);
  if (!ctx.host.statSessionAttachment) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.statUnsupported);
  }
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.host.sessionExists(params.sessionId)
      ? await ctx.ensureColdReadyPublisher(params.sessionId)
      : await ctx.hydratePublisher(params.sessionId);
  const row = publisher
    .getSnapshot()
    .rows.window.find(
      (candidate) =>
        candidate.rowId === params.target.rowId && candidate.entityId === params.target.entityId,
    );
  if (row?.kind !== "userInput") {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
  }
  const attachment = row.attachments?.[params.attachmentIndex];
  if (!attachment || (attachment.ref !== params.ref && attachment.previewRef !== params.ref)) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized);
  }
  const messageId = publisher.getMessageIdForRow(row.rowId) ?? undefined;
  let result: { totalBytes: number; mediaType: string; mtimeMs?: number };
  try {
    result = await ctx.host.statSessionAttachment(params.sessionId, {
      ref: params.ref,
      mime: attachment.mime,
      ...(messageId ? { messageId } : {}),
      attachmentIndex: params.attachmentIndex,
    });
  } catch (error) {
    // 「附件确实不在了」是 share 预检唯一能确定判定为跳过的分类，必须以稳定码上抛；
    // 否则 service 只能猜错误文本。
    throw toShareStatFault(error);
  }
  // stat 结果曾被 30MiB 的 schema 上限卡住，超大附件在这里抛 ZodError，
  // 于是 share 预检把「已知容量超限」这个确定阻断降级成 deferred 并静默丢内容。
  // 上限放宽后仍需要一个显式出口：真的超过协议可表达范围时给出稳定码。
  if (result.totalBytes > PROTOCOL_V4_LIMITS.attachmentStatMaxBytes) {
    throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge);
  }
  return v4ConversationAttachmentStatResultSchema.parse(result);
}

export async function attachmentPreviewSource(
  ctx: GatewayContext,
  rawParams: unknown,
): Promise<V4AttachmentPreviewSourceResult> {
  const params = v4AttachmentPreviewSourceParamsSchema.parse(rawParams);
  const existingReady = ctx.readyFlights.get(params.sessionId);
  const publisher = existingReady
    ? await existingReady
    : !ctx.host.sessionExists(params.sessionId)
      ? await ctx.ensureColdReadyPublisher(params.sessionId)
      : await ctx.hydratePublisher(params.sessionId);
  const resolution = ctx.resolveReadableMediaAttachment(
    publisher,
    params.sessionId,
    params.ref,
    params.target,
    params.attachmentIndex,
  );
  if (!resolution) {
    throw new Error("fault.attachment.previewRefNotAuthorized");
  }
  if (
    params.clientMode !== "desktop-continuous" ||
    !resolution.attachment.mime.startsWith("video/") ||
    !ctx.host.resolveSessionAttachmentPreviewSource
  ) {
    return { kind: "chunked" };
  }
  const result = await ctx.host.resolveSessionAttachmentPreviewSource(params.sessionId, {
    ref: params.ref,
    mime: resolution.attachment.mime,
    ...(resolution.messageId ? { messageId: resolution.messageId } : {}),
    ...(resolution.attachmentIndex !== undefined
      ? { attachmentIndex: resolution.attachmentIndex }
      : {}),
  });
  return v4AttachmentPreviewSourceResultSchema.parse(result);
}

export function resolveReadableMediaAttachment(
  ctx: GatewayContext,
  publisher: ConversationTopicPublisher,
  sessionId: string,
  ref: string,
  target?: { rowId: number; entityId: string },
  attachmentIndex?: number,
): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null {
  const isPreviewable = (attachment: AttachmentRef) => {
    const mime = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    // 根因：原预览仅放行图片、视频和 PDF，文本附件即使归属当前行也被拒绝。
    // 文本只开放既有材料标记，后续仍须通过权威行、附件索引和 ref 的归属校验。
    return (
      mime.startsWith("image/") ||
      mime.startsWith("video/") ||
      mime === "application/pdf" ||
      (mime === "text/plain" &&
        (attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text"))
    );
  };
  const matchesRef = (attachment: AttachmentRef) =>
    attachment.ref === ref || attachment.previewRef === ref;
  if (target && attachmentIndex !== undefined) {
    const row = publisher
      .getSnapshot()
      .rows.window.find(
        (candidate) => candidate.rowId === target.rowId && candidate.entityId === target.entityId,
      );
    if (row?.kind !== "userInput") return null;
    const attachment = row.attachments?.[attachmentIndex];
    if (!attachment || !isPreviewable(attachment) || !matchesRef(attachment)) {
      return null;
    }
    // 热态 renderer 可能还持有 original ref，而 hydrate 后的权威 row 已补
    // previewRef；两者属于同一个 row/index，授权不能因投影时序不同而误判为跨行读取。
    const messageId = publisher.getMessageIdForRow(row.rowId);
    return {
      attachment,
      attachmentIndex,
      ...(messageId ? { messageId } : {}),
    };
  }

  // 旧 renderer 没有 row target，无法按消息定位持久 artifact；一旦
  // previewRef 存在就只能授权该 durable ref，不能重新放行可变的原始路径。
  for (const row of publisher.getSnapshot().rows.window) {
    if (row.kind === "userInput") {
      for (const attachment of row.attachments ?? []) {
        if (!isPreviewable(attachment)) continue;
        if ((attachment.previewRef ?? attachment.ref) === ref) return { attachment };
      }
    }
    if (
      row.kind === "assistantText" &&
      artifactRefBelongsToSession(ref, sessionId) &&
      extractMarkdownArtifactImageRefs(row.text).includes(ref)
    ) {
      // assistant Markdown 可以引用工具产出的 session artifact，
      // 但旧授权只查看 userInput.attachments，导致合法图片到 UI 后被 harden
      // 拦截。仍以当前 session 的权威投影做精确 ref 授权，绝不接受 renderer
      // 自报的任意 artifact/path。Markdown 是模型可控文本，所以 URI authority
      // 还必须与当前请求 session 精确匹配；仅“当前投影里出现过”不能证明它有权
      // 读取另一个 session 的 artifact。
      return {
        attachment: {
          ref,
          fileName: "assistant-image",
          mime: "image/*",
          bytes: 0,
        },
      };
    }
  }
  // 排队项还没写入 transcript row。若只扫已发送行，队列缩略图和撤回前的读取都会被
  // previewRefNotAuthorized。授权范围仍是当前 session 快照里的 previewable ref，不接受任意路径。
  for (const item of publisher.getSnapshot().queue.items) {
    for (const attachment of item.attachments) {
      if (!isPreviewable(attachment)) continue;
      if ((attachment.previewRef ?? attachment.ref) === ref) return { attachment };
    }
  }
  return null;
}

/**
 * 读取附件全部字节（带 TTL/容量缓存）。
 *
 * 注意语义：conversationAttachmentRead 的 offset/limit 是**切片**，不是流式读取——
 * 每个首次请求都会把整个附件物化进内存再切片，后续 chunk 命中同一份缓存。
 * 接入方不要把 chunk 协议当作「按需分段拉取」来规划超大文件；真正的 range 读取
 * 需要 host 侧 readBinaryFile 支持 offset（尚未实现）。
 */
export function readAttachmentPayload(
  ctx: GatewayContext,
  sessionId: string,
  ref: string,
  mime: string,
  messageId?: string,
  attachmentIndex?: number,
  allowGeneric = false,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const now = ctx.now();
  ctx.pruneBinaryReadCache(now);
  // 首段标签 `att`：这张表与 dwf 产物字节共用（见 BinaryReadCacheEntry），两个键空间
  // 只能靠一个不可能相等的首段隔离。
  const key = `att\u0000${sessionId}\u0000${messageId ?? "legacy"}\u0000${attachmentIndex ?? -1}\u0000${ref}`;
  const cached = ctx.binaryReadCache.get(key);
  if (cached) {
    cached.accessedAt = now;
    return cached.payload;
  }

  // 预览读取曾复用上传的 20MiB 总量上限；video 使用已有全局输入上限，
  // image 和上传事务继续保持原边界。
  const maxBytes = allowGeneric
    ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
    : mime.startsWith("video/")
      ? PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes
      : PROTOCOL_V4_LIMITS.attachmentMaxBytes;
  const payload = ctx.host.readSessionAttachment!(sessionId, {
    ref,
    mime,
    maxBytes,
    ...(messageId ? { messageId } : {}),
    ...(attachmentIndex !== undefined ? { attachmentIndex } : {}),
  })
    .then((result) => {
      const resultMime = result.mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (
        !allowGeneric &&
        !resultMime.startsWith("image/") &&
        !resultMime.startsWith("video/") &&
        resultMime !== "application/pdf" &&
        !(
          resultMime === "text/plain" &&
          mime.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
        )
      ) {
        throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewNotMedia);
      }
      if (result.bytes.byteLength > maxBytes) {
        throw new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge);
      }
      const current = ctx.binaryReadCache.get(key);
      if (current) {
        current.bytes = result.bytes.byteLength;
        ctx.binaryReadCacheBytes += result.bytes.byteLength;
        ctx.pruneBinaryReadCache(ctx.now());
      }
      return result;
    })
    .catch((error) => {
      ctx.deleteBinaryReadCacheEntry(key);
      throw error;
    });
  ctx.binaryReadCache.set(key, { sessionId, accessedAt: now, bytes: null, payload });
  return payload;
}

export function pruneBinaryReadCache(ctx: GatewayContext, now = ctx.now()): void {
  for (const [key, entry] of ctx.binaryReadCache) {
    if (now - entry.accessedAt > PROTOCOL_V4_LIMITS.attachmentReadCacheTtlMs) {
      ctx.deleteBinaryReadCacheEntry(key);
    }
  }
  if (ctx.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) return;
  const oldest = [...ctx.binaryReadCache.entries()]
    .filter(([, entry]) => entry.bytes !== null)
    .sort((left, right) => left[1].accessedAt - right[1].accessedAt);
  for (const [key] of oldest) {
    ctx.deleteBinaryReadCacheEntry(key);
    if (ctx.binaryReadCacheBytes <= PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes) break;
  }
}

export function deleteBinaryReadCacheEntry(ctx: GatewayContext, key: string): void {
  const entry = ctx.binaryReadCache.get(key);
  if (!entry) return;
  ctx.binaryReadCache.delete(key);
  ctx.binaryReadCacheBytes = Math.max(0, ctx.binaryReadCacheBytes - (entry.bytes ?? 0));
}

function artifactRefBelongsToSession(ref: string, sessionId: string): boolean {
  return ref.startsWith(`zcode-artifact://${encodeURIComponent(sessionId)}/`);
}

/** 附件在文件系统层「确定不存在」的错误码集合。 */
const MISSING_ATTACHMENT_FS_CODES = new Set<FileSystemErrorCode>([
  "not_found",
  "is_directory",
  "not_file",
]);

/**
 * 把 host / FileSystemPort 抛出的错误归一成带稳定码的附件 fault。
 * host 已经给出结构化 fault 码时原样透传，其余按 FileSystemPortError.code 判定；
 * 都不匹配则保持原错误，让上层按「未知」处理，而不是猜成确定分类。
 */
function toShareStatFault(error: unknown): unknown {
  if (readZCodeAttachmentFaultCode(error)) return error;
  if (isFileSystemPortError(error) && MISSING_ATTACHMENT_FS_CODES.has(error.code)) {
    return new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound, {
      cause: error,
    });
  }
  return error;
}
