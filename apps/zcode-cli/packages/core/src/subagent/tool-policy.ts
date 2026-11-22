import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
} from "@zcode/contracts";
import { AGENT_TOOL_NAME, TASK_TOOL_NAME } from "../tool/compat.js";
import { filterDisallowedToolNames, getToolRuleName } from "../tool/tool-visibility.js";

const SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS = [
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

function isSubagentDispatchRule(rule: string): boolean {
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

interface DelegationToolFilterInput {
  /** Candidate worker capabilities, normally the runtime's delegationToolAllowlist. */
  candidates: readonly string[] | undefined;
  /**
   * Allowlist of the session that issues the grant. `undefined` means unconstrained.
   * Router children pass `undefined` because their grant was already bounded by the
   * ancestor session and their own toolAllowlist is only the profile-derived surface.
   */
  parentAllowlist?: readonly string[] | undefined;
  /** Session disallowlist; alias closure and forced child rules are applied by the filter. */
  disallowedTools: readonly string[] | undefined;
}

/**
 * Bounds the router-delegation candidate set by the issuing session's tool policy.
 *
 * This is the single place that combines the allowlist bound (`*` means allow-all,
 * Agent/Task count as one capability) with the shared child disallow rules. Spawn
 * resolution and the model-visible agent catalog both call it, so the advertised
 * delegation capability cannot drift from what a spawned child actually receives.
 */
export function filterDelegationToolNames(
  input: DelegationToolFilterInput,
): readonly string[] {
  const candidates = input.candidates ?? [];
  if (candidates.length === 0) return [];
  const allowAll = input.parentAllowlist?.includes("*") ?? false;
  const allowlisted = allowAll
    ? candidates
    : candidates.filter((toolName) =>
        isToolAllowedByParentAllowlist(toolName, input.parentAllowlist),
      );
  return filterSubagentChildToolNames(allowlisted, input.disallowedTools);
}
