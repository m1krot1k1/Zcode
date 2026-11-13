import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import { throwProjectionError } from "./errors.js";
import { assertUnique } from "./ids.js";
import { assertTerminalAndSafe, isPublicArtifactRef } from "./safety.js";

const PUBLIC_PRODUCT_TURN_ID = /^share-product-turn-[1-9]\d*$/u;
const PUBLIC_TURN_ID = /^share-turn-[1-9]\d*$/u;
const PUBLIC_ENTITY_ID = /^share-entity-[1-9]\d*$/u;
const PUBLIC_TOOL_CALL_ID = /^share-tool-call-[1-9]\d*$/u;
const PUBLIC_ARTIFACT_ID = /^share-artifact-[1-9]\d*$/u;

export function assertConversationSharePublicProjection(input: {
  rows: ConversationRow[];
  selectedProductTurnIds: string[];
}): void {
  if (input.rows.length === 0 || input.selectedProductTurnIds.length === 0) {
    throwProjectionError("invalid_conversation", "Conversation public projection cannot be empty");
  }
  assertTerminalAndSafe(input.rows);
  assertUnique(input.selectedProductTurnIds, "product turn");
  if (
    input.selectedProductTurnIds.some(
      (productTurnId) => !PUBLIC_PRODUCT_TURN_ID.test(productTurnId),
    )
  ) {
    throwProjectionError(
      "invalid_conversation",
      "Conversation public product turn identity is invalid",
    );
  }

  const selectedProductTurnIds = new Set(input.selectedProductTurnIds);
  const headerCounts = new Map<string, number>();
  const entityIds = new Set<string>();
  const toolCallIds: string[] = [];
  const artifactIds: string[] = [];
  const turnIds = new Set<string>();

  for (const [index, row] of input.rows.entries()) {
    if (row.rowId !== index + 1) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public row identities must be contiguous",
      );
    }
    if (!PUBLIC_TURN_ID.test(row.turnId)) {
      throwProjectionError("invalid_conversation", "Conversation public turn identity is invalid");
    }
    turnIds.add(row.turnId);
    if (
      !row.productTurnId ||
      !PUBLIC_PRODUCT_TURN_ID.test(row.productTurnId) ||
      !selectedProductTurnIds.has(row.productTurnId)
    ) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation row belongs to an unselected product turn",
      );
    }
    if (row.entityId) {
      if (!PUBLIC_ENTITY_ID.test(row.entityId)) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public entity identity is invalid",
        );
      }
      // entityId 是持久实体身份，同一实体可以对应多个 Row；这里只收集引用闭包，不校验 Row 间唯一性。
      entityIds.add(row.entityId);
    }
    if (row.actions !== undefined) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public rows cannot contain local actions",
      );
    }
    if (row.kind === "turnHeader") {
      headerCounts.set(row.productTurnId, (headerCounts.get(row.productTurnId) ?? 0) + 1);
      if (row.originMeta !== undefined) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public turn headers cannot contain local work identity",
        );
      }
    } else if (row.kind === "userInput") {
      if (
        row.sourceCommandId !== undefined ||
        row.rootSourceCommandId !== undefined ||
        row.clientId !== undefined ||
        row.originMeta?.workId !== undefined ||
        row.originMeta?.senderSessionId !== undefined
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public input contains local write identity",
        );
      }
      for (const attachment of row.attachments ?? []) {
        if (!isPublicArtifactRef(attachment.ref)) {
          throwProjectionError(
            "invalid_conversation",
            "Conversation public input attachment reference is invalid",
          );
        }
        if (attachment.previewRef !== undefined && !isPublicArtifactRef(attachment.previewRef)) {
          throwProjectionError(
            "invalid_conversation",
            "Conversation public input preview reference is invalid",
          );
        }
      }
    } else if (row.kind === "assistantText") {
      if (row.feedback !== undefined) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public assistant text contains local feedback",
        );
      }
    } else if (row.kind === "toolCall") {
      if (!PUBLIC_TOOL_CALL_ID.test(row.toolCallId)) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public tool call identity is invalid",
        );
      }
      toolCallIds.push(row.toolCallId);
      if (
        row.progress !== undefined ||
        row.approvalInteractionId !== undefined ||
        row.workId !== undefined
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public tool call contains local runtime identity",
        );
      }
    } else if (row.kind === "artifact") {
      if (
        !PUBLIC_ARTIFACT_ID.test(row.artifactVersionId) ||
        row.ref !== `zcode-artifact://share/${row.artifactVersionId}`
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public artifact identity is invalid",
        );
      }
      artifactIds.push(row.artifactVersionId);
    } else if (row.kind === "timelineMarker") {
      if (row.sourceCommandId !== undefined) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public timeline contains local command identity",
        );
      }
    } else if (row.kind === "subagent") {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public projection cannot contain subagent details",
      );
    } else if (row.kind === "externalAgentRun") {
      if (
        !/^share-external-run-[1-9]\d*$/u.test(row.runId) ||
        !/^share-external-command-[1-9]\d*$/u.test(row.commandId)
      ) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public external run identity is invalid",
        );
      }
      if (row.pendingPermissions !== undefined || row.diagnosticCode !== undefined) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation public external run contains private runtime details",
        );
      }
    }
  }

  assertUnique(toolCallIds, "tool call");
  assertUnique(artifactIds, "artifact");
  if (turnIds.size === 0) {
    throwProjectionError("invalid_conversation", "Conversation public projection has no turns");
  }
  for (const productTurnId of input.selectedProductTurnIds) {
    if (headerCounts.get(productTurnId) !== 1) {
      throwProjectionError(
        "invalid_conversation",
        "Conversation public product turns require exactly one header",
      );
    }
  }

  for (const row of input.rows) {
    if (row.kind !== "turnHeader") continue;
    for (const segment of row.workSegments ?? []) {
      if (segment.triggerEntityId !== undefined && !entityIds.has(segment.triggerEntityId)) {
        throwProjectionError(
          "invalid_conversation",
          "Conversation work segment entity reference is unresolved",
        );
      }
    }
  }
}
