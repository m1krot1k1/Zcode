import { conversationShareContentBlockSchema, projectShareToolDisplay } from "@zcode/shared";
import type { ArtifactRow, ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import { assertConversationSharePublicProjection } from "./assert.js";
import { throwProjectionError } from "./errors.js";
import { assertUnique, buildIdMaps, requiredMappedId } from "./ids.js";
import { projectRow } from "./rows.js";
import { assertTerminalAndSafe } from "./safety.js";
import type {
  ConversationSharePublicArtifact,
  ConversationSharePublicProjection,
} from "./types.js";

import type { ShareContentDraft } from "../conversationShareWorkflowSnapshot.js";

export function buildConversationSharePublicProjection(input: {
  rows: ConversationRow[];
  selectedProductTurnIds: string[];
  additionalArtifacts?: ConversationSharePublicArtifact[];
  contentDrafts?: ShareContentDraft[];
  toolPresentation?: boolean;
  toolImages?: ReadonlyMap<number, Array<{ resourceId: string; mimeType: string }>>;
  sourceRows?: readonly ConversationRow[];
}): ConversationSharePublicProjection {
  assertTerminalAndSafe(input.rows);
  assertUnique(input.selectedProductTurnIds, "source product turn");
  if (input.selectedProductTurnIds.length === 0) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation product turn selection cannot be empty",
    );
  }

  const selectedProductTurnIds = new Set(input.selectedProductTurnIds);
  if (
    input.rows.some((row) => !row.productTurnId || !selectedProductTurnIds.has(row.productTurnId))
  ) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation rows fall outside the selected product turns",
    );
  }

  // 本地运行投影包含 subagent 详情和写入态标识，不能直接作为公开载荷；
  // 必须先过滤非 V1 Row，再基于剩余内容生成一套闭合的公开 ID。
  const retainedRows = input.rows.filter(
    (row) => row.kind !== "subagent" && row.kind !== "hookInvocation",
  );
  const sourceArtifactRows = retainedRows.filter(
    (row): row is ArtifactRow => row.kind === "artifact",
  );
  assertUnique(
    sourceArtifactRows.map((row) => row.artifactVersionId),
    "source artifact",
  );
  assertUnique(
    sourceArtifactRows.map((row) => row.logicalArtifactKey),
    "source artifact logical key",
  );
  const ids = buildIdMaps(retainedRows, input.selectedProductTurnIds);
  const rows = retainedRows.map((row, index) => projectRow(row, index, ids));
  const artifacts = sourceArtifactRows.map((sourceRow) => {
    const projected = rows.find(
      (row): row is ArtifactRow =>
        row.kind === "artifact" &&
        row.artifactVersionId === ids.artifactIds.get(sourceRow.artifactVersionId),
    );
    if (!projected?.productTurnId) {
      throwProjectionError("invalid_conversation", "Projected artifact row is missing");
    }
    const extension = extensionOf(projected.displayName);
    return {
      sourceRef: sourceRow.ref,
      descriptor: {
        artifact_id: projected.artifactVersionId,
        logical_artifact_key: projected.logicalArtifactKey,
        producer_product_turn_id: projected.productTurnId,
        artifact_version: 1,
        state: projected.state,
        ref: projected.ref,
        artifact_type: projected.artifactType,
        display_name: projected.displayName,
        extension,
        mime_type: projected.mimeType,
        size_bytes: projected.sizeBytes,
        sha256: projected.sha256,
      },
    };
  });
  const additionalArtifacts = (input.additionalArtifacts ?? []).map((artifact) => ({
    ...artifact,
    descriptor: {
      ...artifact.descriptor,
      producer_product_turn_id: requiredMappedId(
        ids.productTurnIds,
        artifact.descriptor.producer_product_turn_id,
        "input attachment product turn",
      ),
    },
  }));
  const allArtifactIds = [
    ...artifacts.map((artifact) => artifact.descriptor.artifact_id),
    ...additionalArtifacts.map((artifact) => artifact.descriptor.artifact_id),
  ];
  assertUnique(allArtifactIds, "artifact manifest");
  const projection: ConversationSharePublicProjection = {
    rows,
    selectedProductTurnIds: input.selectedProductTurnIds.map((productTurnId) =>
      requiredMappedId(ids.productTurnIds, productTurnId, "product turn"),
    ),
    artifacts: [...artifacts, ...additionalArtifacts],
  };
  if (input.contentDrafts?.length) {
    projection.contentBlocks = input.contentDrafts.map((draft, index) => {
      const entityId = requiredMappedId(ids.entityIds, draft.entityId, "content fallback");
      const fallback = rows.find((row) => row.entityId === entityId);
      if (!fallback) throwProjectionError("invalid_conversation", "Content fallback is missing");
      const contentArtifacts = draft.payload.artifacts.map((artifact) =>
        "resource_id" in artifact && artifact.resource_id
          ? {
              ...artifact,
              resource_id: requiredMappedId(
                ids.artifactIds,
                artifact.resource_id,
                "content resource",
              ),
            }
          : artifact,
      );
      return conversationShareContentBlockSchema.parse({
        id: `share-content-${index + 1}`,
        type: "workflow",
        version: draft.version ?? 1,
        product_turn_id: requiredMappedId(ids.productTurnIds, draft.productTurnId, "content turn"),
        fallback_row_id: fallback.rowId,
        captured_at: draft.capturedAt,
        resource_ids: contentArtifacts.flatMap((artifact) =>
          "resource_id" in artifact && artifact.resource_id ? [artifact.resource_id] : [],
        ),
        payload: { ...draft.payload, artifacts: contentArtifacts },
      });
    });
  }
  if (input.toolPresentation) {
    const originalRows = new Map(input.sourceRows?.map((row) => [row.rowId, row] as const) ?? []);
    const agentTypes = new Map(
      input.sourceRows?.flatMap((row) =>
        row.kind === "subagent" ? [[row.parentToolCallId, row.subagentType] as const] : [],
      ) ?? [],
    );
    const toolBlocks = retainedRows.flatMap((sourceRow, index) => {
      if (sourceRow.kind !== "toolCall") return [];
      const display = projectShareToolDisplay(sourceRow.output?.display);
      const images = (input.toolImages?.get(sourceRow.rowId) ?? []).flatMap((image) => {
        const id = ids.artifactIds.get(image.resourceId);
        return id ? [{ resource_id: id, mime_type: image.mimeType }] : [];
      });
      const agentType = agentTypes.get(sourceRow.toolCallId);
      const original = originalRows.get(sourceRow.rowId);
      const originalTool = original?.kind === "toolCall" ? original : sourceRow;
      const appName =
        originalTool.cuaApp?.name ??
        (originalTool.output?.display?.kind === "cua"
          ? originalTool.output.display.targetApp?.displayName
          : undefined) ??
        (originalTool.display?.kind === "node_repl_images"
          ? originalTool.display.app?.displayName
          : undefined);
      if (!display && !images.length && !agentType && !appName) return [];
      return [
        conversationShareContentBlockSchema.parse({
          id: `share-content-${(projection.contentBlocks?.length ?? 0) + index + 1}`,
          type: "tool-presentation",
          version: 1,
          product_turn_id: rows[index]!.productTurnId,
          fallback_row_id: rows[index]!.rowId,
          captured_at: sourceRow.endedAt ?? sourceRow.createdAt,
          resource_ids: [...new Set(images.map((image) => image.resource_id))],
          payload: {
            ...(display ? { display } : {}),
            ...(images.length ? { images } : {}),
            ...(agentType ? { agent_type: agentType } : {}),
            ...(appName ? { app_name: appName } : {}),
          },
        }),
      ];
    });
    if (toolBlocks.length)
      projection.contentBlocks = [...(projection.contentBlocks ?? []), ...toolBlocks];
  }
  assertConversationSharePublicProjection(projection);
  return projection;
}

function extensionOf(displayName: string): string {
  const fileName = displayName.trim();
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) {
    throwProjectionError("invalid_conversation", "Conversation artifact extension is missing");
  }
  return fileName.slice(dot + 1).toLowerCase();
}
