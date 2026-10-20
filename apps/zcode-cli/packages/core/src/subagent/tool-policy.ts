import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "@zcode/contracts";
import { filterDisallowedToolNames } from "../tool/tool-visibility.js";

export const SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS = [
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
] as const;

export function buildSubagentChildDisallowRules(
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  return [
    ...SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS,
    ...(disallowedTools ?? []),
  ];
}

/** Потолок вложенности по умолчанию. Выше него runtime не поднимается. */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 64;

/** Жёсткий предохранитель: бесконечная рекурсия Agent/Task порождает fork-bomb. */
export const ABSOLUTE_MAX_SUBAGENT_DEPTH = 64;

export interface ChildNestingDecision {
  depth: number;
  maySpawn: boolean;
}

/**
 * Корень имеет глубину 0 и может порождать, пока 0 < max.
 * Child на глубине max уже не может. max <= 0 запрещает порождение всем, включая корень.
 * Нечисло и пустая строка остаются на умолчании, а не превращаются в безлимит.
 */
export function resolveMaxSubagentDepth(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_SUBAGENT_DEPTH;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_MAX_SUBAGENT_DEPTH;
  return Math.min(parsed, ABSOLUTE_MAX_SUBAGENT_DEPTH);
}

export function runtimeMaySpawnSubagents(depth: number | undefined, maxDepth: number): boolean {
  if (maxDepth <= 0) return false;
  return (depth ?? 0) < maxDepth;
}

export function decideChildNesting(
  parentDepth: number | undefined,
  maxDepth: number,
): ChildNestingDecision {
  const depth = (parentDepth ?? 0) + 1;
  return { depth, maySpawn: runtimeMaySpawnSubagents(depth, maxDepth) };
}

export function filterSubagentChildToolNames(
  toolNames: readonly string[],
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  // 子 agent 没有独立的 plan approval 恢复面，暴露 plan tools 会让
  // ExitPlanMode 等待用户确认并卡住父 turn，因此所有子 agent 工具面统一剔除。
  return filterDisallowedToolNames(
    toolNames,
    buildSubagentChildDisallowRules(disallowedTools),
  );
}
