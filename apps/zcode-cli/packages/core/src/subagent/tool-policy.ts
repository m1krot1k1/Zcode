import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "@zcode/contracts";
import { AGENT_TOOL_NAME, TASK_TOOL_NAME } from "../tool/compat.js";
import { filterDisallowedToolNames, getToolRuleName } from "../tool/tool-visibility.js";

export const SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS = [
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
] as const;

export function buildSubagentChildDisallowRules(
  disallowedTools: readonly string[] | undefined,
): readonly string[] {
  const rules = new Set<string>([
    ...SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS,
    ...(disallowedTools ?? []),
  ]);

  // Agent и Task — два provider-facing имени одной возможности. Запрет любого имени
  // должен закрывать оба, иначе alias позволяет обойти унаследованный запрет.
  if ([...rules].some((rule) => isSubagentDispatchRule(rule))) {
    rules.add(AGENT_TOOL_NAME);
    rules.add(TASK_TOOL_NAME);
  }
  return [...rules];
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

export function isSubagentDispatchRule(rule: string): boolean {
  const name = getToolRuleName(rule);
  return name === AGENT_TOOL_NAME || name === TASK_TOOL_NAME;
}

/** Match a child Agent/Task alias against the same capability in the parent allowlist. */
export function isToolAllowedByParentAllowlist(
  toolName: string,
  parentAllowlist: readonly string[] | undefined,
): boolean {
  if (parentAllowlist === undefined) return true;
  if (parentAllowlist.includes(toolName)) return true;
  if (toolName === AGENT_TOOL_NAME) return parentAllowlist.includes(TASK_TOOL_NAME);
  if (toolName === TASK_TOOL_NAME) return parentAllowlist.includes(AGENT_TOOL_NAME);
  return false;
}
