import {
  projectShareToolDisplay,
  supportsConversationShareContent,
  buildConversationPreviewArtifactCandidates,
  CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT,
  extractConversationPreviewFileReferences,
  type ConversationPreviewArtifactCandidate,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import {
  ConversationShareServiceError,
  sanitizeConversationShareIssues,
  type ConversationShareFailureIssue,
  type ConversationSharePreflightInput,
  type ConversationSharePreflightResult,
} from "../conversationShare.js";
import { getConversationSharePreviewCandidateFingerprint } from "../conversationShareArtifactDiscovery.js";
import { materializeConversationShareInlineImages } from "../conversationShareInlineImages.js";
import { buildConversationSharePublicProjection } from "../conversationSharePublicProjection.js";
import {
  collectConversationShareWorkflowSnapshot,
  isWorkflowShareFallbackRow,
} from "../conversationShareWorkflowSnapshot.js";

import { collectArtifactManifestIssues } from "./projection.js";

import {
  mapWithConcurrency,
  normalizeConversationShareConnectionError,
  settle,
  SHARE_PREFLIGHT_STAT_CONCURRENCY,
  type ConversationShareAgentService,
  type ConversationShareServiceRuntime,
} from "./runtime.js";
import { previewPreflightKey } from "./keys.js";
import {
  allowedArtifactFor,
  allowedArtifactSummaries,
  attachmentDisplayName,
  buildTurnPreflightResults,
  capabilitiesFingerprint,
  collectShareStructureIssues,
  fileExtension,
  isAttachmentAuthorizationError,
  isAttachmentTooLargeError,
  isDefiniteMissingAttachment,
  isMissingArtifactReadError,
  loadAllRows,
  normalizedMimeType,
  removeIndependentArtifactRows,
  rowTurnOrdinal,
  sanitizeUnsupportedShareArtifacts,
  sanitizeUnsupportedShareStructures,
  selectRows,
  turnOrdinalByProductTurn,
} from "./shareRows.js";

/** 预检入口：连接不可用时统一换成 `connection_unavailable`，其余错误保持原样。 */
export async function preflightShare(
  runtime: ConversationShareServiceRuntime,
  input: ConversationSharePreflightInput,
  agentService: ConversationShareAgentService,
): Promise<ConversationSharePreflightResult> {
  try {
    return await runPreflight(runtime, input, agentService);
  } catch (error) {
    throw normalizeConversationShareConnectionError(error);
  }
}

async function runPreflight(
  runtime: ConversationShareServiceRuntime,
  input: ConversationSharePreflightInput,
  agentService: ConversationShareAgentService,
): Promise<ConversationSharePreflightResult> {
  const capabilities = await runtime.client.getCapabilities();
  const supportedArtifactTypes = allowedArtifactSummaries(capabilities);
  const conversation = await loadAllRows(input, agentService);
  const blockingIssues: ConversationShareFailureIssue[] = [];
  const skippableWarnings: ConversationShareFailureIssue[] = [];
  const deferredIssues: ConversationShareFailureIssue[] = [];

  let selected: { rows: ConversationRow[]; productTurnIds: string[] };
  try {
    selected = selectRows(conversation.rows, input.selection);
  } catch (error) {
    if (error instanceof ConversationShareServiceError) {
      blockingIssues.push({
        code: "invalid_selection",
        scope: "conversation",
      });
      return {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        blockingIssues,
        skippableWarnings,
        deferredIssues,
        supportedArtifactTypes,
        turnResults: [],
      };
    }
    throw error;
  }

  const inlineImages = materializeConversationShareInlineImages(
    removeIndependentArtifactRows(
      sanitizeUnsupportedShareStructures(selected.rows),
    ),
    capabilities,
    turnOrdinalByProductTurn(conversation.rows),
  );
  const artifactSanitized = sanitizeUnsupportedShareArtifacts(
    inlineImages.rows,
    capabilities,
    conversation.rows,
  );
  const workflowSnapshot = await collectConversationShareWorkflowSnapshot({
    agent: agentService,
    input,
    rows: artifactSanitized.rows,
    allRows: conversation.rows,
    capabilities,
    capturedAt: runtime.now(),
    preflight: true,
  });
  if (!supportsConversationShareContent(capabilities, "tool-presentation")) {
    for (const row of selected.rows) {
      if (
        row.kind === "toolCall" &&
        (projectShareToolDisplay(row.output?.display) ||
          row.display?.kind === "node_repl_images")
      )
        inlineImages.warnings.push({
          code: "content_unavailable",
          scope: "turn",
          productTurnId: row.productTurnId,
          rowId: row.rowId,
        });
    }
  }
  const selectedRows = workflowSnapshot.rows;
  const contentWarnings: ConversationShareFailureIssue[] =
    workflowSnapshot.drafts.flatMap((draft) =>
      draft.payload.unavailable ||
      draft.payload.artifacts.some((artifact) => artifact.unavailable) ||
      !supportsConversationShareContent(capabilities)
        ? [
            {
              code: "content_unavailable",
              scope: "turn",
              productTurnId: draft.productTurnId,
              turnOrdinal: turnOrdinalByProductTurn(conversation.rows).get(
                draft.productTurnId,
              ),
            },
          ]
        : [],
    );
  skippableWarnings.push(
    ...inlineImages.warnings,
    ...artifactSanitized.warnings,
    ...contentWarnings,
  );
  blockingIssues.push(
    ...collectShareStructureIssues(selectedRows, conversation.rows),
  );
  let hasShareableContent = selectedRows.some((row) => {
    if (row.kind === "turnHeader" || row.kind === "timelineMarker")
      return false;
    if (row.kind === "assistantText" || row.kind === "reasoning")
      return row.text.trim().length > 0;
    if (row.kind === "userInput") return row.text.trim().length > 0;
    if (row.kind === "toolCall") {
      return Boolean(
        row.inputText?.trim() ||
        row.output?.text?.trim() ||
        row.error?.message?.trim(),
      );
    }
    return true;
  });

  const turnOrdinalByProductTurnId = turnOrdinalByProductTurn(
    conversation.rows,
  );
  // 先把需要 stat 的附件收集齐，再有界并发跑，最后按原顺序分类。
  // 拆成两轮是为了在拿到远程并发收益的同时，让 issue 的产生顺序与串行实现一致。
  const attachmentChecks: {
    row: Extract<ConversationRow, { kind: "userInput" }> & {
      entityId: string;
    };
    attachmentIndex: number;
    attachment: NonNullable<
      Extract<ConversationRow, { kind: "userInput" }>["attachments"]
    >[number];
    allowed: ReturnType<typeof allowedArtifactFor>;
    baseIssue: Omit<ConversationShareFailureIssue, "code">;
  }[] = [];
  for (const row of selectedRows) {
    if (row.kind !== "userInput" || !row.attachments) continue;
    for (const [attachmentIndex, attachment] of row.attachments.entries()) {
      const extension = fileExtension(attachment.fileName);
      const mimeType = normalizedMimeType(attachment.mime);
      const allowed = allowedArtifactFor(capabilities, extension, mimeType);
      const baseIssue = {
        scope: "artifact" as const,
        rowId: row.rowId,
        ...(row.productTurnId &&
        turnOrdinalByProductTurnId.has(row.productTurnId)
          ? { turnOrdinal: turnOrdinalByProductTurnId.get(row.productTurnId) }
          : {}),
        ...(row.productTurnId ? { productTurnId: row.productTurnId } : {}),
        artifactDisplayName: attachmentDisplayName(attachment.fileName),
        ...(extension ? { extension } : {}),
        mimeType,
        ...(allowed
          ? { artifactType: allowed.type }
          : { artifactType: extension ?? "unknown" }),
        allowedArtifacts: supportedArtifactTypes,
      } satisfies Partial<ConversationShareFailureIssue>;
      if (!row.entityId) {
        blockingIssues.push({
          code: "input_attachment",
          scope: "artifact",
          rowId: row.rowId,
          ...(baseIssue.turnOrdinal === undefined
            ? {}
            : { turnOrdinal: baseIssue.turnOrdinal }),
          ...(baseIssue.productTurnId === undefined
            ? {}
            : { productTurnId: baseIssue.productTurnId }),
          artifactDisplayName: attachmentDisplayName(attachment.fileName),
        });
        continue;
      }
      attachmentChecks.push({
        row: { ...row, entityId: row.entityId },
        attachmentIndex,
        attachment,
        allowed,
        baseIssue,
      });
    }
  }
  const attachmentStats = await mapWithConcurrency(
    attachmentChecks,
    SHARE_PREFLIGHT_STAT_CONCURRENCY,
    (check) =>
      settle(() =>
        agentService.conversationAttachmentStatV4({
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity
            ? { workspaceIdentity: input.workspaceIdentity }
            : {}),
          ...(input.remoteSessionId
            ? { remoteSessionId: input.remoteSessionId }
            : {}),
          sessionId: input.sessionId,
          target: { rowId: check.row.rowId, entityId: check.row.entityId },
          attachmentIndex: check.attachmentIndex,
          ref: check.attachment.ref,
        }),
      ),
  );
  for (const [checkIndex, check] of attachmentChecks.entries()) {
    const { row, attachment, allowed, baseIssue } = check;
    const settled = attachmentStats[checkIndex]!;
    if (settled.ok) {
      const stat = settled.value;
      if (!allowed) {
        // 即使类型不支持，也必须先完成选择阶段存在性检查；只有存在的附件才展示
        // artifact_type_not_allowed，避免把已经清理的附件误报成能力问题。
        //
        // 类型判定必须排在体积判定之前：不支持的类型根本不会被上传，它的体积
        // 与分享无关。反过来会把「格式不支持（可跳过）」升级成「体积超限（阻断）」，
        // 用户被一个压缩也解决不了的错误挡住。
        skippableWarnings.push({
          code: "artifact_type_not_allowed",
          ...baseIssue,
        });
      } else if (stat.totalBytes > capabilities.max_artifact_bytes) {
        blockingIssues.push({
          code: "artifact_size_limit",
          ...baseIssue,
          actual: stat.totalBytes,
          limit: capabilities.max_artifact_bytes,
        });
      } else if (attachment.bytes > 0 && stat.totalBytes !== attachment.bytes) {
        skippableWarnings.push({
          code: "artifact_changed",
          ...baseIssue,
          availability: "changed",
        });
      } else {
        hasShareableContent = true;
      }
    } else {
      const error = settled.error;
      if (isAttachmentAuthorizationError(error)) {
        blockingIssues.push({
          code: "artifact_protocol_not_ready",
          scope: "artifact",
          rowId: row.rowId,
          ...(baseIssue.turnOrdinal === undefined
            ? {}
            : { turnOrdinal: baseIssue.turnOrdinal }),
          ...(baseIssue.productTurnId === undefined
            ? {}
            : { productTurnId: baseIssue.productTurnId }),
          artifactDisplayName: attachmentDisplayName(attachment.fileName),
        });
      } else if (isAttachmentTooLargeError(error)) {
        // 附件大到连 stat 都无法表达时，仍然是「已知容量超限」这一确定阻断，
        // 绝不能降级成 deferred —— 那会让发布悄悄丢掉这个附件。
        blockingIssues.push({
          code: "artifact_size_limit",
          ...baseIssue,
          limit: capabilities.max_artifact_bytes,
        });
      } else if (isDefiniteMissingAttachment(error)) {
        skippableWarnings.push({
          code: "input_attachment_unavailable",
          ...baseIssue,
          availability: "not_found",
        });
      } else {
        hasShareableContent = true;
        deferredIssues.push({
          code: "artifact_read_failed",
          ...baseIssue,
          availability: "unknown",
        });
      }
    }
  }

  if (!hasShareableContent) {
    blockingIssues.push({
      code: "no_shareable_content",
      scope: "conversation",
    });
  }

  if (blockingIssues.length > 0) {
    const sanitizedBlockingIssues =
      sanitizeConversationShareIssues(blockingIssues);
    const sanitizedWarnings =
      sanitizeConversationShareIssues(skippableWarnings);
    const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
    return {
      revision: conversation.revision,
      logEpoch: conversation.logEpoch,
      capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
      blockingIssues: sanitizedBlockingIssues.issues,
      skippableWarnings: sanitizedWarnings.issues,
      deferredIssues: sanitizedDeferred.issues,
      supportedArtifactTypes,
      turnResults: buildTurnPreflightResults(
        selected.productTurnIds,
        turnOrdinalByProductTurnId,
        sanitizedBlockingIssues.issues,
        sanitizedWarnings.issues,
        sanitizedDeferred.issues,
      ),
    };
  }

  const registeredProjection = buildConversationSharePublicProjection({
    rows: selectedRows,
    selectedProductTurnIds: selected.productTurnIds,
    toolPresentation: supportsConversationShareContent(
      capabilities,
      "tool-presentation",
    ),
    toolImages: inlineImages.toolImages,
    sourceRows: conversation.rows,
  });
  if (registeredProjection.rows.length > capabilities.max_rows) {
    blockingIssues.push({
      code: "rows_limit",
      scope: "conversation",
      actual: registeredProjection.rows.length,
      limit: capabilities.max_rows,
    });
  }
  const manifestIssues = collectArtifactManifestIssues(
    capabilities,
    registeredProjection.artifacts,
  ).map((issue) => {
    // 内嵌图片的容量问题必须带轮次定位，否则拆分 turn 缓存时会漏掉文件级阻断。
    const row = selectedRows.find(
      (candidate) =>
        candidate.kind === "artifact" &&
        candidate.displayName === issue.artifactDisplayName,
    );
    return row
      ? {
          ...issue,
          rowId: row.rowId,
          productTurnId: row.productTurnId,
          turnOrdinal: rowTurnOrdinal(row, turnOrdinalByProductTurnId),
        }
      : issue;
  });
  blockingIssues.push(
    ...manifestIssues.filter(
      (issue) => issue.code !== "artifact_type_not_allowed",
    ),
  );
  skippableWarnings.push(
    ...manifestIssues.filter(
      (issue) => issue.code === "artifact_type_not_allowed",
    ),
  );

  const headersByProductTurnId = new Map<
    string,
    Extract<ConversationRow, { kind: "turnHeader" }>
  >();
  const assistantTextByProductTurnId = new Map<string, string[]>();
  for (const row of selectedRows) {
    if (row.kind === "turnHeader" && row.productTurnId) {
      headersByProductTurnId.set(row.productTurnId, row);
    }
    if (
      row.kind === "assistantText" &&
      row.productTurnId &&
      !isWorkflowShareFallbackRow(row)
    ) {
      const texts = assistantTextByProductTurnId.get(row.productTurnId) ?? [];
      texts.push(row.text);
      assistantTextByProductTurnId.set(row.productTurnId, texts);
    }
  }

  for (const [productTurnId, textParts] of assistantTextByProductTurnId) {
    const header = headersByProductTurnId.get(productTurnId);
    if (!header) continue;
    const assistantText = textParts.join("\n\n");
    const references = extractConversationPreviewFileReferences(
      assistantText,
      input.workspacePath,
    );
    const needsFileChanges = references.some(
      (reference) => reference.kind === "markdown" || reference.kind === "html",
    );
    let fileChanges:
      | Array<{ path: string; state: "active" | "reverted" }>
      | undefined;
    if (needsFileChanges && header.fileChanges?.state !== "reverted") {
      if (!header.entityId) {
        deferredIssues.push({
          code: "artifact_read_failed",
          scope: "artifact",
          rowId: header.rowId,
          turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
          productTurnId,
          availability: "unknown",
        });
        continue;
      }
      const result = await agentService.conversationFileChangesV4({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity
          ? { workspaceIdentity: input.workspaceIdentity }
          : {}),
        ...(input.remoteSessionId
          ? { remoteSessionId: input.remoteSessionId }
          : {}),
        sessionId: input.sessionId,
        target: { rowId: header.rowId, entityId: header.entityId },
        baseRevision: conversation.revision,
        baseLogEpoch: conversation.logEpoch,
      });
      fileChanges = result.items.map((item) => ({
        path: item.path,
        state:
          result.state === "reverted"
            ? ("reverted" as const)
            : ("active" as const),
      }));
    }

    const candidates = buildConversationPreviewArtifactCandidates({
      assistantText,
      productTurnId,
      workspacePath: input.workspacePath,
      fileChanges,
    });
    const visibleCandidates: ConversationPreviewArtifactCandidate[] = [];
    const previewCanonicalPaths = new Set<string>();
    let previewStatSettled = runtime.artifactSource.stat !== undefined;
    // stat 并发发起，判定仍按候选原顺序进行：去重和可见卡片上限都依赖顺序，
    // 而每次 stat 在远程 workspace 下都是一次往返。
    const artifactSourceStat = runtime.artifactSource.stat;
    const candidateStats = artifactSourceStat
      ? await mapWithConcurrency(
          candidates,
          SHARE_PREFLIGHT_STAT_CONCURRENCY,
          (candidate) =>
            settle(() =>
              artifactSourceStat({
                workspacePath: input.workspacePath,
                ref: candidate.sourceRef,
              }),
            ),
        )
      : [];
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const issue = {
        scope: "artifact" as const,
        rowId: header.rowId,
        turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
        productTurnId,
        artifactDisplayName: candidate.displayName,
        artifactType: candidate.artifactType,
        extension: fileExtension(candidate.displayName),
        mimeType: candidate.mimeType,
        allowedArtifacts: supportedArtifactTypes,
      } satisfies Omit<ConversationShareFailureIssue, "code">;

      // 先检查候选上限内的全部路径，再从存在的路径里取 UI 同样的可见卡片上限。
      // 这样不会因为前面几个文件存在就漏掉后续候选的存在性检查。
      const settled = candidateStats[candidateIndex];
      if (!settled) {
        previewStatSettled = false;
        deferredIssues.push({
          code: "artifact_read_failed",
          ...issue,
          availability: "unknown",
        });
        continue;
      }
      if (settled.ok) {
        if (previewCanonicalPaths.has(settled.value.canonicalPath)) continue;
        previewCanonicalPaths.add(settled.value.canonicalPath);
      } else {
        if (isMissingArtifactReadError(settled.error)) {
          // Assistant 预览文件已不存在时，UI 也不会显示这张卡片，因此不产生 Share warning。
          continue;
        }
        previewStatSettled = false;
        deferredIssues.push({
          code: "artifact_read_failed",
          ...issue,
          availability: "unknown",
        });
        continue;
      }
      if (visibleCandidates.length < CONVERSATION_PREVIEW_CARD_VISIBLE_LIMIT) {
        visibleCandidates.push(candidate);
      }
    }

    for (const candidate of visibleCandidates) {
      const issue = {
        scope: "artifact" as const,
        rowId: header.rowId,
        turnOrdinal: turnOrdinalByProductTurnId.get(productTurnId),
        productTurnId,
        artifactDisplayName: candidate.displayName,
        artifactType: candidate.artifactType,
        extension: fileExtension(candidate.displayName),
        mimeType: candidate.mimeType,
        allowedArtifacts: supportedArtifactTypes,
      } satisfies Omit<ConversationShareFailureIssue, "code">;
      const allowed =
        candidate.previewKind === "video" || candidate.previewKind === "audio"
          ? undefined
          : allowedArtifactFor(
              capabilities,
              fileExtension(candidate.displayName),
              candidate.mimeType,
            );
      if (!allowed) {
        skippableWarnings.push({ code: "artifact_type_not_allowed", ...issue });
      }
    }
    const snapshotKey = previewPreflightKey(input, productTurnId);
    if (previewStatSettled) {
      runtime.previewSnapshots.set(snapshotKey, {
        revision: conversation.revision,
        logEpoch: conversation.logEpoch,
        capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
        candidateFingerprint:
          getConversationSharePreviewCandidateFingerprint(candidates),
        visibleSourceRefs: visibleCandidates.map(
          (candidate) => candidate.sourceRef,
        ),
      });
    } else {
      runtime.previewSnapshots.delete(snapshotKey);
    }
  }

  const sanitizedBlockingIssues =
    sanitizeConversationShareIssues(blockingIssues);
  const sanitizedWarnings = sanitizeConversationShareIssues(skippableWarnings);
  const sanitizedDeferred = sanitizeConversationShareIssues(deferredIssues);
  return {
    revision: conversation.revision,
    logEpoch: conversation.logEpoch,
    capabilitiesFingerprint: capabilitiesFingerprint(capabilities),
    blockingIssues: sanitizedBlockingIssues.issues,
    skippableWarnings: sanitizedWarnings.issues,
    deferredIssues: sanitizedDeferred.issues,
    supportedArtifactTypes,
    turnResults: buildTurnPreflightResults(
      selected.productTurnIds,
      turnOrdinalByProductTurnId,
      sanitizedBlockingIssues.issues,
      sanitizedWarnings.issues,
      sanitizedDeferred.issues,
    ).map((result) => ({
      ...result,
      rowBudget: {
        count: registeredProjection.rows.filter(
          (row) =>
            row.productTurnId ===
            registeredProjection.selectedProductTurnIds[
              selected.productTurnIds.indexOf(result.productTurnId)
            ],
        ).length,
        limit: capabilities.max_rows,
      },
    })),
  };
}
