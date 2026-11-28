import { createHash } from "node:crypto";
import {
  UNCENSORED_TAKEOVER_ENTRY_TYPE,
  uncensoredTakeoverEntryPayloadSchema,
  type BuildTakeoverEntryInput,
  type UncensoredTakeoverEntryPayload,
  type UncensoredTakeoverSessionEntry,
} from "./contract.js";
import { normalizeItemText } from "./detect.js";

export const TAKEOVER_AGENT_ID_PREFIX = "uncensored-takeover";

/** Idempotency key: taskId + whitespace-normalized item text (position is excluded). */
export function takeoverIdempotencyKey(taskId: string, itemText: string): string {
  return `${taskId}\u0000${normalizeItemText(itemText)}`;
}

/** Deterministic agent id shared by live events and the durable row. */
export function takeoverAgentId(taskId: string, itemIndex: number, itemText: string): string {
  const digest = createHash("sha256")
    .update(takeoverIdempotencyKey(taskId, itemText))
    .digest("hex")
    .slice(0, 16);
  return `${TAKEOVER_AGENT_ID_PREFIX}:${taskId}:${itemIndex}:${digest}`;
}

export function buildTakeoverEntry(
  input: BuildTakeoverEntryInput,
): UncensoredTakeoverSessionEntry {
  return {
    id: input.agentId,
    sessionID: input.sessionId,
    type: UNCENSORED_TAKEOVER_ENTRY_TYPE,
    time: { created: input.createdAt, updated: input.updatedAt },
    data: {
      kind: "uncensored_takeover",
      taskId: input.taskId,
      itemIndex: input.itemIndex,
      itemText: input.itemText,
      providerId: input.terminal.providerId,
      providerName: input.terminal.providerName,
      modelId: input.terminal.modelId,
      status: input.terminal.status,
      output: input.terminal.output,
      ...(input.terminal.reason ? { reason: input.terminal.reason } : {}),
      ...(input.terminal.toolsExecuted === undefined
        ? {}
        : { toolsExecuted: input.terminal.toolsExecuted }),
      agentId: input.agentId,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    },
  };
}

export function parseTakeoverEntryData(data: unknown): UncensoredTakeoverEntryPayload | null {
  const parsed = uncensoredTakeoverEntryPayloadSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
