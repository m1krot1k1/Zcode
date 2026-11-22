import type { AgentsListResult, AgentSummary, BuiltInSubagentName } from "@zcode/shared";

interface AgentGroups {
  builtIn: AgentSummary[];
  plugin: AgentSummary[];
  user: AgentSummary[];
}

export function projectSettingsSubagents(result: AgentsListResult): AgentSummary[] {
  // Bugfix：result.agents 是运行时调用投影，插件 agent 可能同时有规范名称与裸名称别名；
  // 设置页按已安装资源展示，插件部分必须改用一文件一条的 pluginAgents 投影。
  return [...result.agents.filter((agent) => agent.source !== "plugin"), ...result.pluginAgents];
}

export function isEditableUserAgent(agent: AgentSummary): boolean {
  return (
    (agent.scope === "user" || agent.scope === "workspace") &&
    agent.source === "user" &&
    agent.readOnly !== true
  );
}

// runtime 只对 user scope 应用 disabledAgentIds（CLI 侧 isDisabledUserProfile 对
// source !== "user" 直接返回 false，workspace profile 的 source 是 "project"），服务端
// attachEnabledState 也据此对非 user scope 恒返回 enabled: true。因此 workspace agent 不能
// 展示启用开关——点了会静默回弹，还会往 user 级 agents-state.json 写入永不生效的记录。
export function supportsEnabledToggle(agent: AgentSummary): boolean {
  return isEditableUserAgent(agent) && agent.scope === "user";
}

export function isBuiltInAgent(agent: AgentSummary): boolean {
  return agent.scope === "built-in" || agent.source === "built-in";
}

/**
 * 内置 general-purpose、Explore 与插件 agent 都是只读 profile，配置入口统一为行内
 * model / effort 覆盖控件；插件 md 属于插件安装目录，升级会覆写，所以不能像 user agent 那样改文件。
 */
export function supportsModelOverride(agent: AgentSummary): boolean {
  return getBuiltInSubagentName(agent) !== null || agent.source === "plugin";
}

export function getBuiltInSubagentName(agent: AgentSummary): BuiltInSubagentName | null {
  if (!isBuiltInAgent(agent)) {
    return null;
  }
  // 合同: general-purpose/Explore + router-роли. Для start/orchestrator override — это
  // способ назначить дешёвую модель маршрутизации, не меняя модель исполнителей.
  return agent.name === "general-purpose" ||
    agent.name === "Explore" ||
    agent.name === "start" ||
    agent.name === "orchestrator"
    ? agent.name
    : null;
}

export function groupAgentsByScope(agents: readonly AgentSummary[]): AgentGroups {
  const groups: AgentGroups = { builtIn: [], plugin: [], user: [] };
  for (const agent of agents) {
    if (isEditableUserAgent(agent)) {
      groups.user.push(agent);
    } else if (agent.source === "plugin") {
      groups.plugin.push(agent);
    } else {
      groups.builtIn.push(agent);
    }
  }
  return groups;
}

/** 按完整插件 ID 分组，避免同名 marketplace 的子智能体互相合并。 */
export function groupPluginAgentsById(
  agents: readonly AgentSummary[],
): Array<[string, AgentSummary[]]> {
  const groups = new Map<string, AgentSummary[]>();
  for (const agent of agents) {
    const key =
      agent.pluginId?.trim() || agent.pluginName?.trim() || agent.name.split(":", 1)[0] || "Plugin";
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}
