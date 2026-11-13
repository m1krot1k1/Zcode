import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { ConversationShareCapabilities } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  ZCODE_ATTACHMENT_FAULT_CODES,
  readZCodeAttachmentFaultCode,
} from "@zcode/shared/zcode-protocol-v4";

import {
  ConversationShareServiceError,
  type ConversationShareAllowedArtifact,
  type ConversationShareFailureIssue,
  type ConversationSharePreflightInput,
  type ConversationShareTurnPreflightResult,
  type PublishTextConversationInput,
} from "../conversationShare.js";

import {
  throwServiceError,
  type ConversationShareAgentService,
} from "./runtime.js";

const MISSING_ARTIFACT_ERRNOS = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

export interface ConversationRowsRead {
  rows: ConversationRow[];
  revision: number;
  logEpoch: string;
}

export function isMissingArtifactReadError(error: unknown): boolean {
  return (
    error instanceof ConversationShareServiceError &&
    error.reasonCode === "artifact_read_failed" &&
    typeof error.diagnostics?.errno === "string" &&
    MISSING_ARTIFACT_ERRNOS.has(error.diagnostics.errno)
  );
}

export function turnOrdinalByProductTurn(
  rows: readonly ConversationRow[],
): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    if (
      row.kind !== "turnHeader" ||
      !row.productTurnId ||
      result.has(row.productTurnId)
    )
      continue;
    result.set(row.productTurnId, result.size + 1);
  }
  return result;
}

export function rowTurnOrdinal(
  row: ConversationRow,
  ordinals: Map<string, number>,
): number | undefined {
  return row.productTurnId ? ordinals.get(row.productTurnId) : undefined;
}

function hasUnsafeShareString(value: unknown): boolean {
  if (typeof value === "string") return /^(?:data|file):/iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsafeShareString);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) => (key === "ref" ? false : hasUnsafeShareString(entry)),
  );
}

function hasUnsupportedArtifactReference(value: unknown): boolean {
  if (typeof value === "string") return /^zcode-artifact:\/\//iu.test(value);
  if (Array.isArray(value)) return value.some(hasUnsupportedArtifactReference);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) =>
      key === "ref" ? false : hasUnsupportedArtifactReference(entry),
  );
}

/**
 * V1 公开投影承载不了的已定稿内部结构静默移除：删掉不能公开的字段或整行，保留该轮其余
 * 内容，让发布不再被整体打死，也不把内部渲染结构暴露成用户错误。
 *
 * 只降级「已定稿但无法承载」的内容；运行中的轮次/行/工具/子代理仍由
 * collectShareStructureIssues 阻断 —— 那些内容尚未定稿，跳过等于分享半成品。
 */
export function sanitizeUnsupportedShareStructures(
  rows: readonly ConversationRow[],
): ConversationRow[] {
  const sanitized: ConversationRow[] = [];
  for (const row of rows) {
    if (row.kind === "timelineMarker") {
      // 运行中的 marker 留着，让 collectShareStructureIssues 照旧阻断——内容尚未定稿。
      // 被阻断的发布不会进入投影，保留该 marker 无副作用。
      const markerRunning =
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running");
      if (markerRunning) {
        sanitized.push(row);
        continue;
      }
      if (
        row.marker.type === "forkNotice" ||
        row.marker.type === "forkCreated" ||
        row.marker.type === "checkpointRestored"
      ) {
        // 分支/回滚 marker 只携带本地会话关系，公开页本来就不渲染；直接移除，不能把
        // 内部时间线结构计入“文件被跳过”或打扰用户。
        continue;
      }
      // 其余 marker 静默剥掉，不打扰分享者：
      // - compact（上下文已压缩）纯运行时记账，对只读读者没有价值；而且它的 lane 是
      //   assistantWork，留在 flow 尾部会顶掉「最终正文」折叠锚点，让整轮过程默认展开
      //   （conversationTurnWorkSegments.ts 的 assistantHistoryDefaultOpen）——这是它必须走的主因。
      // - goalVerify / goalSet / retryNotice 在分享页本来就不渲染，纯占位吃 max_rows 配额。
      // - modelChange 只能显示一句泛化的「模型已切换」，信息量低且暴露内部切模型行为。
      continue;
    }
    if (row.kind === "toolCall" && row.toolName === "EnterPlanMode") {
      // EnterPlanMode 只是内部模式切换边界，渲染层（isVisibleAssistantWorkRow）本来就过滤掉，
      // 但它仍会进 payload 白吃 max_rows / max_payload_bytes 配额，永远不显示。
      continue;
    }
    sanitized.push(row);
  }
  return sanitized;
}

export function sanitizeUnsupportedShareArtifacts(
  rows: readonly ConversationRow[],
  capabilities: ConversationShareCapabilities,
  ordinalRows: readonly ConversationRow[],
): { rows: ConversationRow[]; warnings: ConversationShareFailureIssue[] } {
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const warnings: ConversationShareFailureIssue[] = [];
  const retained = rows.filter((row) => {
    if (row.kind !== "artifact") return true;
    const extension = fileExtension(row.displayName);
    const mimeType = normalizedMimeType(row.mimeType);
    const allowed = capabilities.allowed_artifacts.find(
      (candidate) =>
        candidate.type === row.artifactType &&
        candidate.extensions.some(
          (value) => value.replace(/^\./u, "").toLowerCase() === extension,
        ) &&
        candidate.mime_types.some((value) => value.toLowerCase() === mimeType),
    );
    if (allowed) return true;
    warnings.push({
      code: "artifact_type_not_allowed",
      scope: "artifact",
      rowId: row.rowId,
      ...(row.productTurnId && ordinals.has(row.productTurnId)
        ? { turnOrdinal: ordinals.get(row.productTurnId) }
        : {}),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
      artifactDisplayName: row.displayName,
      artifactType: row.artifactType,
      ...(extension ? { extension } : {}),
      mimeType,
      allowedFormats: allowedFormatLabels(capabilities),
      allowedArtifacts: allowedArtifactSummaries(capabilities),
    });
    return false;
  });
  return { rows: retained, warnings };
}

export function collectShareStructureIssues(
  rows: readonly ConversationRow[],
  ordinalRows: readonly ConversationRow[] = rows,
): ConversationShareFailureIssue[] {
  const issues: ConversationShareFailureIssue[] = [];
  const ordinals = turnOrdinalByProductTurn(ordinalRows);
  const add = (
    row: ConversationRow,
    code: ConversationShareFailureIssue["code"],
  ) => {
    issues.push({
      code,
      scope: code === "missing_product_turn" ? "conversation" : "turn",
      ...(row.rowId === undefined ? {} : { rowId: row.rowId }),
      ...(rowTurnOrdinal(row, ordinals) === undefined
        ? {}
        : { turnOrdinal: rowTurnOrdinal(row, ordinals) }),
      ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
    });
  };
  for (const row of rows) {
    if (!row.productTurnId) add(row, "missing_product_turn");
    if (row.kind === "turnHeader" && row.state === "running")
      add(row, "running_turn");
    if (
      (row.kind === "assistantText" || row.kind === "reasoning") &&
      row.state === "streaming"
    ) {
      add(row, "streaming_row");
    }
    if (
      row.kind === "toolCall" &&
      (row.status === "inputStreaming" ||
        row.status === "pendingApproval" ||
        row.status === "running")
    ) {
      add(row, "active_tool_call");
    }
    if (row.kind === "subagent" && row.status === "running")
      add(row, "active_subagent");
    if (row.kind === "timelineMarker") {
      // 只有「运行中」的时间线操作仍阻断；fork/checkpoint/compact summaryRef 已由
      // sanitizeUnsupportedShareStructures 降级为跳过。
      if (
        (row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")
      ) {
        add(row, "unsupported_timeline");
      }
    }
    if (hasUnsafeShareString(row)) add(row, "unsafe_url");
    if (hasUnsupportedArtifactReference(row))
      add(row, "artifact_protocol_not_ready");
  }
  return issues;
}

export function allowedFormatLabels(
  capabilities: ConversationShareCapabilities,
): string[] {
  return capabilities.allowed_artifacts.flatMap((allowed) =>
    allowed.extensions.map(
      (extension) =>
        `${allowed.type.toUpperCase()} (.${extension.replace(/^\./u, "")})`,
    ),
  );
}

export function allowedArtifactSummaries(
  capabilities: ConversationShareCapabilities,
): ConversationShareAllowedArtifact[] {
  return capabilities.allowed_artifacts.map((allowed) => ({
    type: allowed.type,
    extensions: [...allowed.extensions],
    mimeTypes: [...allowed.mime_types],
  }));
}

export function capabilitiesFingerprint(
  capabilities: ConversationShareCapabilities,
): string {
  return createHash("sha256")
    .update(JSON.stringify(capabilities))
    .digest("hex");
}

export function fileExtension(fileName: string): string | undefined {
  const baseName = fileName.replace(/\\/gu, "/").split("/").at(-1) ?? fileName;
  const dot = baseName.lastIndexOf(".");
  return dot > 0 && dot < baseName.length - 1
    ? baseName.slice(dot + 1).toLowerCase()
    : undefined;
}

export function normalizedMimeType(mime: string): string {
  return (
    mime.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream"
  );
}

export function attachmentDisplayName(fileName: string): string {
  return basename(fileName.replace(/\\/gu, "/")) || "附件";
}

export function allowedArtifactFor(
  capabilities: ConversationShareCapabilities,
  extension: string | undefined,
  mimeType: string,
) {
  if (!extension) return undefined;
  return capabilities.allowed_artifacts.find(
    (allowed) =>
      allowed.extensions.some(
        (value) => value.replace(/^\./u, "").toLowerCase() === extension,
      ) && allowed.mime_types.some((value) => value.toLowerCase() === mimeType),
  );
}

/**
 * 附件错误分类统一走协议侧稳定 fault 码（见 attachment-faults.ts）。
 *
 * 不能按 `error.message` 正则分类：RPC 包装/schema 校验一变就失效——
 * 超大附件的 ZodError 曾因此被误判成「未知」并降级成 deferred，静默丢内容。
 * 仅在 fault 码缺席时保留一条 errno 文本兜底，用于尚未带结构化码的旧 zcode-cli。
 */
export function isDefiniteMissingAttachment(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotFound ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.statNotFile
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|not found|not_found|statNotFile|is_directory/iu.test(message);
}

export function isAttachmentAuthorizationError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  if (faultCode) {
    return (
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadNotAuthorized ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted ||
      faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return /shareStatNotAuthorized|shareReadNotAuthorized|connectionUntrusted/iu.test(
    message,
  );
}

/** 附件体积超出协议/通道可承载范围：选择阶段就应作为确定阻断呈现。 */
export function isAttachmentTooLargeError(error: unknown): boolean {
  const faultCode = readZCodeAttachmentFaultCode(error);
  return (
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge ||
    faultCode === ZCODE_ATTACHMENT_FAULT_CODES.previewTooLarge
  );
}

export function buildTurnPreflightResults(
  productTurnIds: readonly string[],
  turnOrdinalByProductTurnId: ReadonlyMap<string, number>,
  blockingIssues: readonly ConversationShareFailureIssue[],
  skippableWarnings: readonly ConversationShareFailureIssue[],
  deferredIssues: readonly ConversationShareFailureIssue[],
): ConversationShareTurnPreflightResult[] {
  return productTurnIds.map((productTurnId) => {
    const turnOrdinal = turnOrdinalByProductTurnId.get(productTurnId);
    const forTurn = (issues: readonly ConversationShareFailureIssue[]) =>
      issues.filter(
        (issue) =>
          issue.turnOrdinal === turnOrdinal ||
          (issue.turnOrdinal === undefined &&
            issue.rowId === undefined &&
            issue.artifactDisplayName === undefined &&
            (issue.scope === "conversation" || issue.scope === "transport")),
      );
    return {
      productTurnId,
      blockingIssues: forTurn(blockingIssues),
      skippableWarnings: forTurn(skippableWarnings),
      deferredIssues: forTurn(deferredIssues),
    };
  });
}

export function removeIndependentArtifactRows(
  rows: readonly ConversationRow[],
): ConversationRow[] {
  // 文件候选来自用户输入附件和最终可见的 Assistant 预览卡片；内嵌图片随后独立转换。历史 artifact row
  // 若没有对应预览卡片，不再作为第三条独立发现来源进入公开 projection。
  return rows.filter((row) => row.kind !== "artifact");
}

export function selectRows(
  rows: ConversationRow[],
  selection: PublishTextConversationInput["selection"],
): { rows: ConversationRow[]; productTurnIds: string[] } {
  let selectedProductTurnIds: Set<string>;
  if (selection.kind === "all") {
    selectedProductTurnIds = new Set(
      rows
        .filter((row) => row.kind === "turnHeader")
        .map((row) => row.productTurnId)
        .filter((value): value is string => value !== undefined),
    );
  } else if (selection.kind === "productTurns") {
    if (selection.productTurnIds.length === 0) {
      throwServiceError(
        "invalid_selection",
        "At least one product turn must be selected",
      );
    }
    selectedProductTurnIds = new Set(selection.productTurnIds);
  } else {
    if (selection.rowIds.length === 0) {
      throwServiceError(
        "invalid_selection",
        "At least one conversation row must be selected",
      );
    }
    const rowsById = new Map(rows.map((row) => [row.rowId, row]));
    selectedProductTurnIds = new Set<string>();
    for (const rowId of new Set(selection.rowIds)) {
      const row = rowsById.get(rowId);
      if (!row?.productTurnId) {
        throwServiceError(
          "invalid_selection",
          "A selected row no longer exists",
        );
      }
      selectedProductTurnIds.add(row.productTurnId);
    }
  }

  const orderedProductTurnIds: string[] = [];
  const headerCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "turnHeader" || !row.productTurnId) continue;
    headerCounts.set(
      row.productTurnId,
      (headerCounts.get(row.productTurnId) ?? 0) + 1,
    );
    if (selectedProductTurnIds.has(row.productTurnId)) {
      orderedProductTurnIds.push(row.productTurnId);
    }
  }
  if (
    orderedProductTurnIds.length === 0 ||
    orderedProductTurnIds.length !== selectedProductTurnIds.size ||
    orderedProductTurnIds.some(
      (productTurnId) => headerCounts.get(productTurnId) !== 1,
    )
  ) {
    throwServiceError(
      "invalid_selection",
      "Selected product turns are incomplete or ambiguous",
    );
  }

  const selectedTurnIds = new Set(
    rows
      .filter(
        (row) =>
          row.kind === "turnHeader" &&
          row.productTurnId !== undefined &&
          selectedProductTurnIds.has(row.productTurnId),
      )
      .map((row) => row.turnId),
  );

  return {
    productTurnIds: orderedProductTurnIds,
    // 旧投影可能缺 productTurnId；只要 turnId 落在已选轮次也必须保留，让校验显式拒绝，
    // 不能在过滤时静默丢行后发布一份不完整会话。
    rows: rows.filter(
      (row) =>
        (row.productTurnId !== undefined &&
          selectedProductTurnIds.has(row.productTurnId)) ||
        (row.productTurnId === undefined && selectedTurnIds.has(row.turnId)),
    ),
  };
}

export async function loadAllRows(
  input: Pick<
    PublishTextConversationInput | ConversationSharePreflightInput,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "sessionId"
  >,
  agentService: ConversationShareAgentService,
): Promise<ConversationRowsRead> {
  const pages: ConversationRow[][] = [];
  let beforeRowId: number | undefined;
  let logEpoch: string | undefined;
  let revision: number | undefined;

  while (true) {
    const result = await agentService.conversationRowsRangeV4({
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity
        ? { workspaceIdentity: input.workspaceIdentity }
        : {}),
      ...(input.remoteSessionId
        ? { remoteSessionId: input.remoteSessionId }
        : {}),
      sessionId: input.sessionId,
      ...(beforeRowId === undefined ? {} : { beforeRowId }),
      limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
    });
    if (
      (logEpoch !== undefined && result.atLogEpoch !== logEpoch) ||
      (revision !== undefined && result.atRevision !== revision)
    ) {
      throwServiceError(
        "invalid_conversation",
        "Conversation changed while preparing share",
      );
    }
    logEpoch = result.atLogEpoch;
    revision = result.atRevision;
    pages.unshift(result.rows);
    if (!result.hasMore) break;
    const firstRowId = result.rows[0]?.rowId;
    if (firstRowId === undefined || firstRowId === beforeRowId) {
      throwServiceError(
        "invalid_contract",
        "Conversation row pagination did not advance",
      );
    }
    beforeRowId = firstRowId;
  }

  const rows = pages.flat();
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    if (previous.rowId >= current.rowId) {
      throwServiceError(
        "invalid_contract",
        "Conversation rows are not globally ordered",
      );
    }
  }
  if (logEpoch === undefined || revision === undefined) {
    throwServiceError(
      "invalid_contract",
      "Conversation rows are missing a read watermark",
    );
  }
  return { rows, revision, logEpoch };
}
