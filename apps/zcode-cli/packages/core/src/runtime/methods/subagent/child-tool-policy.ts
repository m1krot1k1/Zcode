/** Границы tool surface child runtime: делегирование, allowlist, alias координатора. */
import { RESPOND_TO_COORDINATOR_TOOL_NAME } from "@zcode/contracts";
import type { ExploreSubagentRuntimeRequest, Model } from "../../deps.js";
import type { AgentRuntimeInternal } from "../../internal.js";
import { modelSupportsNativeWebSearch } from "../config.js";
import {
  buildSubagentChildDisallowRules,
  filterDelegationToolNames,
  filterSubagentChildToolNames,
  isToolAllowedByParentAllowlist,
} from "../../../subagent/tool-policy.js";

/**
 * Router-delegation candidate set of this runtime, bounded by the session that owns it.
 *
 * Root и session-рантаймы применяют свой `toolAllowlist` (`*` = allow-all) и общие child
 * disallow-правила. У `subagent_child` `toolAllowlist` — это производная поверхность
 * профиля, а не allowlist сессии, и его `delegationToolAllowlist` уже ограничен тем, кто
 * выдал грант; повторное ограничение здесь срезало бы worker-набор у read-only
 * start/orchestrator. Функция экспортируется, чтобы spawn и каталог агентов применяли
 * одну и ту же границу.
 */
export function resolveRuntimeDelegationToolNames(
  runtime: Pick<AgentRuntimeInternal, "config">,
): readonly string[] {
  return filterDelegationToolNames({
    candidates: runtime.config.delegationToolAllowlist,
    parentAllowlist:
      runtime.config.taskType === "subagent_child" ? undefined : runtime.config.toolAllowlist,
    disallowedTools: runtime.config.toolDisallowlist,
  });
}

/** 导出仅供 core 单测验证 child 能力清单的 WebSearch 条件过滤。 */
export function resolveSubagentToolAllowlist(
  this: AgentRuntimeInternal,
  request: ExploreSubagentRuntimeRequest,
  visibleMcpToolNames: readonly string[],
  childModel: Model,
): readonly string[] {
  const disallowedRules = buildSubagentChildDisallowRules([
    ...(this.config.toolDisallowlist ?? []),
    ...(request.disallowedTools ?? []),
  ]);
  const inheritsAvailableTools =
    request.allowedTools.length === 0 || request.allowedTools.includes("*");
  const parentAllowedMcpToolNames = filterMcpToolNamesByParentAllowlist(
    visibleMcpToolNames,
    this.config.toolAllowlist,
  );
  // Фактическая поверхность родителя = зарегистрированные built-in инструменты ∪
  // делегируемый набор. Объединение, а не подмена: иначе router-грант терял зарегистрированные
  // инструменты (CreateWorkflow, alias Agent), которых нет в worker-константе. Сам грант
  // ограничен политикой выдавшей его сессии (toolAllowlist / toolDisallowlist).
  const parentBuiltInToolNames = [
    ...new Set([
      ...this.getTools()
        // child MCP must use the same descriptors as the parent's current MCP snapshot.
        .filter((tool) => tool.permission?.permission !== "mcp")
        .map((tool) => tool.name),
      ...resolveRuntimeDelegationToolNames(this),
    ]),
    // WebSearch 是否进入 child 能力清单取决于 child Active Model，而不是父注册表：
    // 否则 SubagentSpawned.allowedTools 会把 child 实际拿不到的条件工具持久化出去。
  ].filter((toolName) => toolName !== "WebSearch" || modelSupportsNativeWebSearch(childModel));
  const parentAvailableToolNames = [...parentBuiltInToolNames, ...parentAllowedMcpToolNames];
  const inheritedParentToolNames = filterSubagentChildToolNames(
    parentAvailableToolNames,
    disallowedRules,
  );

  if (inheritsAvailableTools) {
    const inheritedTools = new Set(inheritedParentToolNames);
    // Task is a compatibility alias, not an independent capability. Add it only when
    // Agent is actually available to this parent and neither alias is ancestor-denied.
    if (inheritedTools.has("Agent")) inheritedTools.add("Task");
    return appendCoordinatorResponseTool([...inheritedTools]);
  }
  if (request.allowedTools.length > 0) {
    // 修复原因：递归 Task 的显式 profile tools 曾能绕过父级可见工具面，且 Agent/Task
    // alias 可能绕开祖先禁令。修复依据：按父级实际可用能力取交集，再对两个 alias 统一应用禁令。
    return appendCoordinatorResponseTool(
      filterSubagentChildToolNames(request.allowedTools, disallowedRules).filter(
        (toolName) =>
          toolName === RESPOND_TO_COORDINATOR_TOOL_NAME ||
          isToolAllowedByParentAllowlist(toolName, inheritedParentToolNames),
      ),
    );
  }
  return appendCoordinatorResponseTool([]);
}

function filterMcpToolNamesByParentAllowlist(
  toolNames: readonly string[],
  parentAllowlist: readonly string[] | undefined,
): readonly string[] {
  if (parentAllowlist === undefined) return toolNames;
  const allowed = new Set(parentAllowlist);
  return toolNames.filter((toolName) => allowed.has(toolName));
}

function appendCoordinatorResponseTool(toolNames: readonly string[]): readonly string[] {
  if (toolNames.includes(RESPOND_TO_COORDINATOR_TOOL_NAME)) {
    return toolNames;
  }

  // child 控制通道不受 profile 工具列表约束；全局 toolDisallowlist 仍在 runtime 注册边界生效。
  return [...toolNames, RESPOND_TO_COORDINATOR_TOOL_NAME];
}
