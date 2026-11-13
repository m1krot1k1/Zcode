import {
  type ZCodeBackgroundTaskControlItem,
  type ZCodeTurnSteerCommandKind,
  type ZCodeTurnSteerSource,
  type InputId,
  type ZCodeContextCompactionTimelinePhase,
  type ZCodeGoalVerificationTimelineMeta,
  type ZCodeTimelineStatus,
  type ZCodeTimelineTrigger,
  type ZCodeToolProjectionMemory,
} from "@zcode/shared";

export const MODEL_CONFIG_ID = "model";
export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
export const MODE_CONFIG_ID = "mode";

export const STREAMING_TOOL_INPUT_INFO_LOG_LINE_BUCKET = 50;
export const streamingToolInputProjectionLogBuckets = new Map<string, number>();
export const COMPACTION_PROJECTION_DIAG_LIMIT = 200;
export const compactionProjectionDiagSignatures = new Set<string>();

export interface ZCodeSessionEventProjectionState extends ZCodeToolProjectionMemory {
  activePromptInputIdBySession?: Map<string, InputId>;
  rewindControlTurnKeys?: Set<string>;
  activeApiRetrySessionIds?: Set<string>;
  backgroundTaskControlsBySession?: Map<
    string,
    ZCodeBackgroundTaskControlItem[]
  >;
  streamedTurnKeys?: Set<string>;
}

export type ZCodeSessionProjectionMode = "active-live" | "background-summary";

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function goalVerificationTimelineStatusValue(
  value: unknown,
): ZCodeGoalVerificationTimelineMeta["status"] | undefined {
  return value === "started" ||
    value === "completed" ||
    value === "failed_closed" ||
    value === "cancelled"
    ? value
    : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function timelineStatusValue(
  value: unknown,
): ZCodeTimelineStatus | undefined {
  return value === "started" ||
    value === "retrying" ||
    value === "skipped" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
    ? value
    : undefined;
}

export function timelineTriggerValue(
  value: unknown,
): ZCodeTimelineTrigger | undefined {
  return value === "manual" ||
    value === "auto" ||
    value === "reactive" ||
    value === "partial" ||
    value === "session_memory"
    ? value
    : undefined;
}

export function compactionPhaseValue(
  value: unknown,
): ZCodeContextCompactionTimelinePhase | undefined {
  return value === "standalone_turn" ||
    value === "pre_request" ||
    value === "mid_turn" ||
    value === "reactive"
    ? value
    : undefined;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function turnSteerSourceValue(
  value: unknown,
): ZCodeTurnSteerSource | undefined {
  return value === "plan_approval_feedback" ||
    value === "workflow_refine_feedback"
    ? value
    : undefined;
}

export function turnSteerCommandKindValue(
  value: unknown,
): ZCodeTurnSteerCommandKind | undefined {
  return value === "sendGoalCommand" ||
    value === "sendText" ||
    value === "compact"
    ? value
    : undefined;
}
