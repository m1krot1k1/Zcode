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
  for (const document of configuration.documents) {
    const result = parseAgentProfileFromMarkdown(document);
    if (result.diagnostic) diagnostics.push(result.diagnostic);
    if (!result.profile) continue;
    const profile = document.namespace
      ? { ...result.profile, name: `${document.namespace}/${result.profile.name}` }
      : result.profile;
    // 修复依据：profile loader 只从 ZCode 所有的配置根读取；解析器不再保留 Cursor 格式标签或优先级分支。
    profiles.push(profile);
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
