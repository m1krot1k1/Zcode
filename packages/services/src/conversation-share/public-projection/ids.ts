import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

import { throwProjectionError } from "./errors.js";

export interface PublicIdMaps {
  productTurnIds: Map<string, string>;
  turnIds: Map<string, string>;
  entityIds: Map<string, string>;
  toolCallIds: Map<string, string>;
  artifactIds: Map<string, string>;
  artifactKeys: Map<string, string>;
}

export function allocateIds(values: Iterable<string>, prefix: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of values) {
    if (!result.has(value)) {
      result.set(value, `${prefix}-${result.size + 1}`);
    }
  }
  return result;
}

export function requiredMappedId(
  ids: Map<string, string>,
  sourceId: string,
  label: string,
): string {
  const mapped = ids.get(sourceId);
  if (!mapped) {
    throwProjectionError(
      "invalid_conversation",
      `Conversation ${label} reference is outside the shared projection`,
    );
  }
  return mapped;
}

export function buildIdMaps(
  rows: ConversationRow[],
  selectedProductTurnIds: string[],
): PublicIdMaps {
  return {
    productTurnIds: allocateIds(selectedProductTurnIds, "share-product-turn"),
    turnIds: allocateIds(
      rows.map((row) => row.turnId),
      "share-turn",
    ),
    entityIds: allocateIds(
      rows.flatMap((row) => (row.entityId ? [row.entityId] : [])),
      "share-entity",
    ),
    toolCallIds: allocateIds(
      rows.flatMap((row) => (row.kind === "toolCall" ? [row.toolCallId] : [])),
      "share-tool-call",
    ),
    artifactIds: allocateIds(
      rows.flatMap((row) => (row.kind === "artifact" ? [row.artifactVersionId] : [])),
      "share-artifact",
    ),
    artifactKeys: allocateIds(
      rows.flatMap((row) => (row.kind === "artifact" ? [row.logicalArtifactKey] : [])),
      "share-artifact-key",
    ),
  };
}

export function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throwProjectionError(
      "invalid_conversation",
      `Conversation public ${label} identities must be unique`,
    );
  }
}
