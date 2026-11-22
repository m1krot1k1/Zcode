import type {
  ConversationShareArtifactDescriptor,
  ConversationShareCapabilities,
  ConversationShareConfirmRequest,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import {
  ConversationShareServiceError,
  type ConversationShareFailureIssue,
} from "../conversationShare.js";
import {
  buildConversationSharePublicProjection,
  type ConversationSharePublicArtifact,
} from "../conversationSharePublicProjection.js";
import { buildConversationShareConfirmRequest } from "../conversationShareIntegrity.js";
import type { ShareContentDraft } from "../conversationShareWorkflowSnapshot.js";

import { allowedArtifactSummaries, allowedFormatLabels } from "./shareRows.js";

export type ConversationSharePublicProjection = ReturnType<
  typeof buildConversationSharePublicProjection
>;

/**
 * 清单校验：重复 ID、单文件/总量超限与类型白名单都在同一处判定。
 *
 * 返回 issue 而不是直接抛错，让 preflight 能把同一条规则降级成可操作提示，
 * 发布路径则通过 validateArtifactManifest 立即失败。
 */
export function collectArtifactManifestIssues(
  capabilities: ConversationShareCapabilities,
  artifacts: Array<{
    sourceRef: string;
    descriptor: ConversationShareArtifactDescriptor;
  }>,
): ConversationShareFailureIssue[] {
  const artifactIds = new Set<string>();
  const issues: ConversationShareFailureIssue[] = [];
  if (artifacts.length > capabilities.max_artifact_count) {
    issues.push({
      code: "artifact_count_limit",
      scope: "conversation",
      actual: artifacts.length,
      limit: capabilities.max_artifact_count,
    });
  }
  let declaredTotalBytes = 0;
  for (const { descriptor } of artifacts) {
    if (artifactIds.has(descriptor.artifact_id)) {
      issues.push({
        code: "artifact_manifest",
        scope: "artifact",
        artifactDisplayName: descriptor.display_name,
      });
      continue;
    }
    artifactIds.add(descriptor.artifact_id);
    declaredTotalBytes += descriptor.size_bytes;
    if (descriptor.size_bytes > capabilities.max_artifact_bytes) {
      issues.push({
        code: "artifact_size_limit",
        scope: "artifact",
        artifactDisplayName: descriptor.display_name,
        artifactType: descriptor.artifact_type,
        extension: descriptor.extension,
        mimeType: descriptor.mime_type,
        actual: descriptor.size_bytes,
        limit: capabilities.max_artifact_bytes,
      });
    }
    const allowed = capabilities.allowed_artifacts.some(
      (candidate) =>
        candidate.type === descriptor.artifact_type &&
        candidate.extensions.some(
          (extension) =>
            extension.replace(/^\./u, "").toLowerCase() ===
            descriptor.extension,
        ) &&
        candidate.mime_types.some(
          (mimeType) =>
            mimeType.toLowerCase() === descriptor.mime_type.toLowerCase(),
        ),
    );
    if (!allowed) {
      issues.push({
        code: "artifact_type_not_allowed",
        scope: "artifact",
        artifactDisplayName: descriptor.display_name,
        artifactType: descriptor.artifact_type,
        extension: descriptor.extension,
        mimeType: descriptor.mime_type,
        allowedFormats: allowedFormatLabels(capabilities),
        allowedArtifacts: allowedArtifactSummaries(capabilities),
      });
    }
  }
  if (declaredTotalBytes > capabilities.max_total_artifact_bytes) {
    issues.push({
      code: "artifact_total_size_limit",
      scope: "conversation",
      actual: declaredTotalBytes,
      limit: capabilities.max_total_artifact_bytes,
    });
  }
  return issues;
}

export function validateArtifactManifest(
  capabilities: ConversationShareCapabilities,
  artifacts: Array<{
    sourceRef: string;
    descriptor: ConversationShareArtifactDescriptor;
  }>,
): void {
  const issues = collectArtifactManifestIssues(capabilities, artifacts);
  if (issues.length > 0) {
    const hasTypeIssue = issues.some(
      (issue) => issue.code === "artifact_type_not_allowed",
    );
    throw new ConversationShareServiceError(
      hasTypeIssue ? "artifact_not_allowed" : "limit_exceeded",
      "Conversation artifacts cannot be shared",
      { issues },
    );
  }
}

/**
 * 发布前的公开投影与 confirm 请求组装。
 *
 * `projection` 只包含后端 V1 能接受的公开行；confirm 请求的 payload 上限也在这里
 * 校验，避免把超限 DTO 交给 HTTP 层再被 3205 拒绝。
 */
export function assemblePublication(input: {
  capabilities: ConversationShareCapabilities;
  rows: ConversationRow[];
  selectedProductTurnIds: string[];
  additionalArtifacts: ConversationSharePublicArtifact[];
  toolPresentation: boolean;
  toolImages: ReadonlyMap<
    number,
    Array<{ resourceId: string; mimeType: string }>
  >;
  sourceRows: readonly ConversationRow[];
  contentDrafts?: ShareContentDraft[];
  disclosureAcceptedAt: number;
}): {
  projection: ConversationSharePublicProjection;
  confirmRequest: ConversationShareConfirmRequest;
  payloadBytes: number;
} {
  const projection = buildConversationSharePublicProjection({
    rows: input.rows,
    selectedProductTurnIds: input.selectedProductTurnIds,
    additionalArtifacts: input.additionalArtifacts,
    toolPresentation: input.toolPresentation,
    toolImages: input.toolImages,
    sourceRows: input.sourceRows,
    ...(input.contentDrafts ? { contentDrafts: input.contentDrafts } : {}),
  });
  validateArtifactManifest(input.capabilities, projection.artifacts);
  if (projection.rows.length > input.capabilities.max_rows) {
    throw new ConversationShareServiceError(
      "limit_exceeded",
      "Conversation contains too many rows to share",
      {
        issues: [
          {
            code: "rows_limit",
            scope: "conversation",
            actual: projection.rows.length,
            limit: input.capabilities.max_rows,
          },
        ],
      },
    );
  }

  const confirmRequest = buildConversationShareConfirmRequest({
    selected_product_turn_ids: projection.selectedProductTurnIds,
    projection: {
      rows: projection.rows,
      ...(projection.contentBlocks
        ? { content_blocks: projection.contentBlocks }
        : {}),
    },
    artifacts: projection.artifacts.map((artifact) => artifact.descriptor),
    disclosure_confirmation: {
      version: 1,
      accepted_at: input.disclosureAcceptedAt,
      acknowledged_no_secret_detection: true,
    },
  });
  const payloadBytes = Buffer.byteLength(
    JSON.stringify(confirmRequest),
    "utf8",
  );
  if (payloadBytes > input.capabilities.max_payload_bytes) {
    throw new ConversationShareServiceError(
      "limit_exceeded",
      "Conversation share payload is too large",
      {
        issues: [
          {
            code: "payload_size_limit",
            scope: "conversation",
            actual: payloadBytes,
            limit: input.capabilities.max_payload_bytes,
          },
        ],
      },
    );
  }
  return { projection, confirmRequest, payloadBytes };
}
