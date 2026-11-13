import {
  projectShareToolDisplay,
  supportsConversationShareContent,
} from "@zcode/shared";

import {
  ConversationShareServiceError,
  sanitizeConversationShareIssues,
  type ConversationShareFailureIssue,
  type ConversationSharePublishProgress,
  type PublishTextConversationInput,
} from "../conversationShare.js";
import { buildConversationShareArtifactSnapshot } from "../conversationShareArtifactDiscovery.js";
import { ConversationShareClientError } from "../conversationShareHttpClient.js";
import { materializeConversationShareInlineImages } from "../conversationShareInlineImages.js";
import { sha256ConversationShareJson } from "../conversationShareIntegrity.js";
import { buildConversationSharePublicProjection } from "../conversationSharePublicProjection.js";
import { collectConversationShareWorkflowSnapshot } from "../conversationShareWorkflowSnapshot.js";

import { confirmUntilReady, uploadPublicationArtifacts } from "./http.js";
import { assemblePublication, validateArtifactManifest } from "./projection.js";
import {
  localizePublishedShare,
  normalizeConversationShareConnectionError,
  throwServiceError,
  type ConversationShareAgentService,
  type ConversationShareServiceRuntime,
} from "./runtime.js";
import {
  capabilitiesFingerprint,
  collectShareStructureIssues,
  loadAllRows,
  removeIndependentArtifactRows,
  sanitizeUnsupportedShareArtifacts,
  sanitizeUnsupportedShareStructures,
  selectRows,
  turnOrdinalByProductTurn,
} from "./shareRows.js";

export async function publishShare(
  runtime: ConversationShareServiceRuntime,
  input: PublishTextConversationInput,
  operationId: string,
) {
  return publishShareWithAgent(
    runtime,
    input,
    operationId,
    runtime.zcodeAgentService,
  );
}

export async function publishShareWithAgent(
  runtime: ConversationShareServiceRuntime,
  input: PublishTextConversationInput,
  operationId: string,
  agentService: ConversationShareAgentService,
) {
  runtime.logger.info(undefined, "conversation share publish started", {
    operationId,
    accessMode: input.accessMode,
    selectionKind: input.selection.kind,
    remoteWorkspace: Boolean(input.workspaceIdentity || input.remoteSessionId),
  });
  try {
    const result = await publishInternal(
      runtime,
      input,
      operationId,
      agentService,
    );
    runtime.logger.info(undefined, "conversation share publish completed", {
      operationId,
      phase: "complete",
    });
    // 发布成功即本次分享结束，该 session 的预检快照不再有消费者：立刻回收，
    // 否则长生命周期的 desktop host 会无限累积 workspace+session+turn 条目。
    runtime.previewSnapshots.clearBySession(input);
    return result;
  } catch (rawError) {
    const error = normalizeConversationShareConnectionError(rawError);
    const record =
      error !== null && typeof error === "object"
        ? (error as Record<string, unknown>)
        : null;
    runtime.logger.warn(undefined, "conversation share publish failed", {
      operationId,
      phase: runtime.progress.getPublishPhase(operationId) ?? "collecting",
      kind: typeof record?.kind === "string" ? record.kind : "unknown",
      ...(typeof record?.reasonCode === "string"
        ? { reasonCode: record.reasonCode }
        : {}),
      ...(record?.diagnostics && typeof record.diagnostics === "object"
        ? { diagnostics: record.diagnostics }
        : {}),
      ...(typeof record?.status === "number" ? { status: record.status } : {}),
      ...(typeof record?.code === "number" ? { code: record.code } : {}),
      ...(typeof record?.requestId === "string"
        ? { requestId: record.requestId }
        : {}),
      ...(error instanceof ConversationShareClientError &&
      error.details?.clientRequestId
        ? { clientRequestId: error.details.clientRequestId }
        : {}),
      errorName:
        typeof record?.name === "string"
          ? record.name
          : error instanceof Error
            ? error.name
            : "UnknownError",
    });
    throw error;
  } finally {
    runtime.progress.clearPublishPhase(operationId);
  }
}

async function publishInternal(
  runtime: ConversationShareServiceRuntime,
  input: PublishTextConversationInput,
  operationId: string,
  agentService: ConversationShareAgentService,
) {
  const report = (
    phase: ConversationSharePublishProgress["phase"],
    completedArtifacts = 0,
    totalArtifacts = 0,
    warnings?: {
      issues: readonly ConversationShareFailureIssue[];
      issueCount: number;
      omittedIssueCount: number;
    },
  ) => {
    runtime.progress.setPublishPhase(operationId, phase);
    runtime.logger.info(undefined, "conversation share publish phase changed", {
      operationId,
      phase,
      completedArtifacts,
      totalArtifacts,
      ...(warnings ? { warningCount: warnings.issueCount } : {}),
    });
    runtime.progress.firePublish(operationId, {
      phase,
      completedArtifacts,
      totalArtifacts,
      ...(warnings
        ? {
            warnings: warnings.issues,
            omittedWarningCount: warnings.omittedIssueCount,
          }
        : {}),
    });
  };
  report("collecting");
  if (!input.title.trim() || !input.clientRequestId.trim()) {
    throwServiceError(
      "invalid_contract",
      "Share title and request identity are required",
    );
  }
  if (
    !Number.isSafeInteger(input.disclosureAcceptedAt) ||
    input.disclosureAcceptedAt <= 0
  ) {
    throwServiceError(
      "disclosure_required",
      "Explicit disclosure confirmation is required",
    );
  }
  if (
    input.selection.kind === "rowAnchors" &&
    input.selection.rowIds.length === 0
  ) {
    throwServiceError(
      "invalid_selection",
      "At least one conversation row must be selected",
    );
  }

  const capabilities = await runtime.client.getCapabilities();
  if (!capabilities.access_modes.includes(input.accessMode)) {
    throwServiceError(
      "feature_disabled",
      "Requested share access mode is unavailable",
    );
  }

  const conversation = await loadAllRows(input, agentService);
  const selected = selectRows(conversation.rows, input.selection);
  // 无法公开承载的已定稿结构先降级：删字段或丢整行，换成非阻断提示，
  // 后续所有投影与产物发现都基于这份 sanitized rows。
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
  const publishWarnings: ConversationShareFailureIssue[] = [
    ...inlineImages.warnings,
    ...artifactSanitized.warnings,
    ...contentWarnings,
  ];
  // 修复原因：此前公开投影遇到第一个不支持结构就直接退出，用户无法知道还有哪些轮次需要取消；
  // 现在先完成整组选中内容的结构预检，返回脱敏 issues 让 UI 给出逐项可操作建议。
  const structureIssues = collectShareStructureIssues(
    selectedRows,
    conversation.rows,
  );
  if (structureIssues.length > 0) {
    const structureKind = structureIssues.some(
      (issue) => issue.code === "artifact_protocol_not_ready",
    )
      ? "artifact_protocol_not_ready"
      : structureIssues.some((issue) => issue.code === "unsafe_url")
        ? "unsafe_structure"
        : "invalid_conversation";
    throw new ConversationShareServiceError(
      structureKind,
      "Selected conversation contains unsupported structure",
      { issues: structureIssues },
    );
  }
  // 本地运行投影包含 subagent 详情与写入态 ID，后端 V1 会以 3205 拒绝；
  // confirm 前必须先生成独立的公开投影，不能直接发送选中的本地 rows。
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
  validateArtifactManifest(capabilities, registeredProjection.artifacts);
  const artifactSnapshot = await buildConversationShareArtifactSnapshot({
    zcodeAgentService: agentService,
    artifactSource: runtime.artifactSource,
    input,
    selectedRows,
    registeredArtifacts: registeredProjection.artifacts,
    inlineBytesBySourceRef: new Map([
      ...inlineImages.bytesBySourceRef,
      ...workflowSnapshot.bytes,
    ]),
    capabilities,
    revision: conversation.revision,
    logEpoch: conversation.logEpoch,
    turnOrdinalByProductTurnId: turnOrdinalByProductTurn(conversation.rows),
    preflightPreviewSnapshots: runtime.previewSnapshots.collect(
      input,
      selected.productTurnIds,
    ),
    currentCapabilitiesFingerprint: capabilitiesFingerprint(capabilities),
  });
  if (artifactSnapshot.issues.length > 0) {
    throw new ConversationShareServiceError(
      "artifact_not_allowed",
      "Conversation result artifacts are not allowed by server capabilities",
      { issues: artifactSnapshot.issues },
    );
  }
  if (artifactSnapshot.warnings.length > 0) {
    publishWarnings.push(...artifactSnapshot.warnings);
  }
  if (publishWarnings.length > 0) {
    // 非阻断：正文引用的文件或用户输入附件无法物化时，发布照常继续，但要让分享者
    // 知道哪些真实文件没有进入链接；内部 marker 已移除，内嵌图片已转换为 artifact。
    report(
      "collecting",
      0,
      0,
      sanitizeConversationShareIssues(publishWarnings),
    );
  }
  const { projection: publicProjection, confirmRequest } = assemblePublication({
    capabilities,
    rows: artifactSnapshot.rows,
    selectedProductTurnIds: selected.productTurnIds,
    additionalArtifacts: artifactSnapshot.additionalArtifacts,
    toolPresentation: supportsConversationShareContent(
      capabilities,
      "tool-presentation",
    ),
    toolImages: inlineImages.toolImages,
    sourceRows: conversation.rows,
    ...(supportsConversationShareContent(capabilities)
      ? { contentDrafts: workflowSnapshot.drafts }
      : {}),
    disclosureAcceptedAt: input.disclosureAcceptedAt,
  });

  const payloadSha256 = sha256ConversationShareJson(confirmRequest);
  const preparation = await runtime.client.createPreparation({
    client_request_id: input.clientRequestId,
    title: input.title.trim(),
    schema_version: 1,
    access_mode: input.accessMode,
    payload_sha256: payloadSha256,
    artifact_count: publicProjection.artifacts.length,
  });
  if (preparation.status === "confirmed") {
    report(
      "complete",
      publicProjection.artifacts.length,
      publicProjection.artifacts.length,
    );
    return localizePublishedShare(preparation.share, input.locale);
  }
  report("uploading", 0, publicProjection.artifacts.length);
  const uploadedArtifacts = await uploadPublicationArtifacts(
    runtime,
    preparation.preparation_id,
    publicProjection.artifacts,
    artifactSnapshot.bytesBySourceRef,
    (uploaded, total) => report("uploading", uploaded, total),
  );
  report("checking", uploadedArtifacts, publicProjection.artifacts.length);
  const share = await confirmUntilReady(
    runtime,
    preparation.preparation_id,
    confirmRequest,
  );
  report("complete", uploadedArtifacts, publicProjection.artifacts.length);
  // 服务端目前不接收 locale，只能把下发的链接改写到界面语言对应的站点；
  // localizeConversationShareUrl 只认已知分享路径形状，其它形状原样保留。
  return localizePublishedShare(share, input.locale);
}
