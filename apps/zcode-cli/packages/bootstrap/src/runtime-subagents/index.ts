import {
  parseAgentProfileFromMarkdown,
  type AgentProfile,
  type AgentProfileParseDiagnostic,
  resolveSubagentRuntimeProfiles,
  type SubagentRuntimeConfig,
} from "@zcode/shared";

/** 独立 CLI 的磁盘 loader 复用共享纯解析器，保留原文件配置来源。 */
import type { RuntimeSubagentConfiguration } from "./contract.js";

export function parseRuntimeSubagentConfig(configuration: RuntimeSubagentConfiguration) {
  const profiles: AgentProfile[] = [];
  const diagnostics: AgentProfileParseDiagnostic[] = [];
  const nativeNames = new Set<string>();
  for (const document of configuration.documents) {
    const result = parseAgentProfileFromMarkdown(document);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
    if (!result.profile) continue;
    const profile = document.namespace
      ? { ...result.profile, name: `${document.namespace}/${result.profile.name}` }
      : result.profile;
    // 原生 `.zcode` profile 是本产品的显式配置；同名 Cursor 兼容文件不能覆盖它。
    if (document.format === "cursor" && nativeNames.has(profile.name)) continue;
    profiles.push(profile);
    if (document.format !== "cursor") nativeNames.add(profile.name);
  }
  return {
    ...resolveSubagentRuntimeProfiles(profiles, configuration.state),
    diagnostics,
  };
}

/** Host 已完成纯解析；失败回退不能混入旧模板或磁盘覆盖。 */
export function subagentProfilesFromSnapshot(snapshot: SubagentRuntimeConfig) {
  return snapshot.kind === "ready"
    ? snapshot
    : {
        profiles: [],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      };
}
