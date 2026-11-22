import type { ModelToolContract } from "../deps.js";
import { registerBuiltInTools } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import {
  resolveBuiltInToolAllowlist,
  resolveRuntimeDisallowedTools,
  resolveRuntimeDynamicWorkflowToolsIncluded,
  shouldIncludeTaskAlias,
} from "../helpers/tool-allowlist.js";
import { isToolNameDisallowed } from "../../tool/tool-visibility.js";

export function resolveRuntimeEmbeddedSearchEnabled(runtime: AgentRuntimeInternal): boolean {
  const builtInToolAllowlist = resolveBuiltInToolAllowlist(runtime.config);
  const decision = resolveEmbeddedSearchBranchCapability({
    bashAvailable:
      (builtInToolAllowlist === undefined || builtInToolAllowlist.includes("Bash")) &&
      !isToolNameDisallowed("Bash", runtime.config.toolDisallowlist),
  });
  return decision.useEmbeddedSearchBranch;
}

export function refreshBranchAwareBuiltInTools(runtime: AgentRuntimeInternal): void {
  const embeddedSearchEnabled = resolveRuntimeEmbeddedSearchEnabled(runtime);
  // Glob/Grep остаются зарегистрированными: embedded search в Bash — дополнение,
  // а не замена. Иначе child allowlist, построенный из tool surface родителя,
  // теряет оба инструмента и профиль обещает то, чего у ребёнка нет.

  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    // 原因：本函数是第二个注册入口，registry.register 会覆盖同名记录，而
    // silentDuplicateWarnings 会吞掉重复告警；此前漏传 alias 标志，把首次装配时可见的 Task
    // 覆盖成 providerVisible:false，initializeSessionShellEnvironmentIfNeeded 之后 alias 消失。
    // 修复依据：与首次装配共用同一个 shouldIncludeTaskAlias，规则不在此处重写。
    includeTaskAlias: shouldIncludeTaskAlias(runtime.config.taskType),
    embeddedSearchEnabled,
    // 本函数是**第二个**
    // 注册入口，且刻意只传一个精简选项集。对「只有 true 才注册」的门（OffPeak / Cron / Workflow…）
    // 省略是安全的；但动态工作流灰度门的极性相反——「缺席即开启」，省略等于把首次装配剃掉的
    // 十个工具在 shell 快照初始化时原样加回来（registry.register 会覆盖同名项，
    // silentDuplicateWarnings 还把告警吞掉，所以全程无声）。推导因此必须与 runtime-tools.ts
    // 共用同一个 helper，不能在这里重写一遍判断。
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime),
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    // 结构性禁用 (workflow_child) 与 turn 级名单的合并在同一 helper 内完成；
    // 直接传 config.toolDisallowlist 会让 refresh 丢掉结构性禁用。
    disallowedTools: resolveRuntimeDisallowedTools(runtime.config),
    silentDuplicateWarnings: true,
  });
  runtime.cachedTools = null;
}

export function filterEmbeddedSearchRuntimeVisibleTools(
  _runtime: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  // Не скрываем Glob/Grep: они входят в явный allowlist профилей и должны быть
  // видны модели наравне с embedded find/grep внутри Bash.
  return tools;
}
