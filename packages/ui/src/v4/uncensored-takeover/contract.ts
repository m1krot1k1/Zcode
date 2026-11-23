/**
 * ui-uncensored-takeover 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 数据唯一来源是 `subagentRowSchema.takeover`（由 Chat sub-run 投影写入），卡片只读取、
 * 不请求、不写 store，因此没有第二个状态源。
 */
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";

/** Persisted takeover facts of one refused task item; owned by the subagent row. */
export type UncensoredTakeover = NonNullable<SubagentRow["takeover"]>;

/**
 * All takeover states in display order. Kept in sync with
 * `subagentRowSchema.takeover.status`; `contract.test.ts` compares both sets.
 */
export const UNCENSORED_TAKEOVER_STATUSES = [
  "running",
  "done",
  "refused",
  "error",
  "no-enabled-models",
] as const satisfies readonly UncensoredTakeover["status"][];

export type UncensoredTakeoverStatus = (typeof UNCENSORED_TAKEOVER_STATUSES)[number];

/**
 * Fully formatted display strings. Defaults come from the `chat.uncensoredTakeover.*`
 * catalogs; an override replaces that whole line, so the caller owns its interpolation.
 */
export interface UncensoredTakeoverCardLabels {
  title: string;
  itemLine: string;
  providerLine: string;
  modelLine: string;
  reasonLine: string;
  outputLabel: string;
  statusLabel: string;
  noEnabledModelsHint: string;
}

/** Read-only card props. Rendering is a pure function of the row facts and labels. */
export interface UncensoredTakeoverCardProps {
  takeover: UncensoredTakeover;
  /** Pre-formatted overrides; omitted entries resolve from the active locale. */
  labels?: Partial<UncensoredTakeoverCardLabels>;
  className?: string;
}
