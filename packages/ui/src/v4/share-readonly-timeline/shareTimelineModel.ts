import type {
  ConversationShareWorkflowContentBlock,
  ShareToolPresentationPayload,
} from "@zcode/shared";
import {
  conversationShareContentEnvelopeSchema,
  decodeConversationShareContentBlocks,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationTurnRenderUnits,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import type { z } from "zod";

type ShareContentEnvelope = z.infer<
  typeof conversationShareContentEnvelopeSchema
>;

export interface ShareTimelineModel {
  toolSnapshots: ReadonlyMap<number, ShareToolPresentationPayload>;
  blocks: readonly ConversationShareWorkflowContentBlock[];
  envelopes: readonly ShareContentEnvelope[];
  fallbacks: ReadonlyMap<number, string>;
  allUnits: readonly ConversationTurnRenderUnit[];
  units: ReadonlyMap<string, ConversationTurnRenderUnit>;
}

function selectWorkflowBlocks(
  allBlocks: ReturnType<typeof decodeConversationShareContentBlocks>,
  rows: readonly ConversationRow[],
): ConversationShareWorkflowContentBlock[] {
  return allBlocks
    .filter((block) => block.type === "workflow")
    .filter((block) =>
      rows.some(
        (row) =>
          row.rowId === block.fallback_row_id &&
          row.kind === "assistantText" &&
          row.productTurnId === block.product_turn_id,
      ),
    );
}

/**
 * 把分享内容块 / 信封与 rows 对齐，得到渲染单元。
 *
 * 纯函数（不含 hook）：Content 里原先按「先解码再 unit 化」的顺序顺序执行，
 * 这里保持同样的顺序与过滤条件，避免摘要/占位块认领关系变化。
 */
export function buildShareTimelineModel(
  rows: readonly ConversationRow[],
  contentBlocks: readonly unknown[] | undefined,
): ShareTimelineModel {
  const rowsById = new Map(rows.map((row) => [row.rowId, row] as const));
  const allBlocks = decodeConversationShareContentBlocks(contentBlocks).filter(
    (block) => {
      const row = rowsById.get(block.fallback_row_id);
      return (
        row?.productTurnId === block.product_turn_id &&
        row.kind ===
          (block.type === "tool-presentation" ? "toolCall" : "assistantText")
      );
    },
  );
  const toolSnapshots = new Map(
    allBlocks.flatMap((block) =>
      block.type === "tool-presentation" &&
      rows.some(
        (row) =>
          row.kind === "toolCall" &&
          row.rowId === block.fallback_row_id &&
          row.productTurnId === block.product_turn_id,
      )
        ? [[block.fallback_row_id, block.payload] as const]
        : [],
    ),
  );
  const blocks = selectWorkflowBlocks(allBlocks, rows);
  const envelopes = (contentBlocks ?? []).flatMap((raw) => {
    const parsed = conversationShareContentEnvelopeSchema.safeParse(raw);
    return parsed.success &&
      rows.some(
        (row) =>
          row.kind === "assistantText" &&
          row.rowId === parsed.data.fallback_row_id &&
          row.productTurnId === parsed.data.product_turn_id,
      )
      ? [parsed.data]
      : [];
  });
  const claimed = new Set(envelopes.map((block) => block.fallback_row_id));
  const claimedResources = new Set(
    allBlocks.flatMap((block) => block.resource_ids),
  );
  const fallbacks = new Map(
    rows.flatMap((row) =>
      row.kind === "assistantText" ? [[row.rowId, row.text] as const] : [],
    ),
  );
  const allUnits = buildConversationTurnRenderUnits(rows);
  const units = new Map(
    buildConversationTurnRenderUnits(
      rows.filter(
        (row) =>
          !claimed.has(row.rowId) &&
          !(
            row.kind === "artifact" &&
            claimedResources.has(row.artifactVersionId)
          ),
      ),
    ).map((unit) => [unit.key, unit]),
  );

  return { toolSnapshots, blocks, envelopes, fallbacks, allUnits, units };
}
