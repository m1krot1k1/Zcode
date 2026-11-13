import type {
  SettingsSyncImportMode,
  SettingsSyncSelection,
  SettingsSyncSourceScope,
} from "@zcode/shared";
import type { ImportResourceCategory, ResourceSelectionKeyPayload } from "./types.js";

/** 折叠分组的 key：只保留 source root 维度，不包含具体资源路径。 */
export function getSourceSelectionKey(
  agent: string,
  category: string,
  sourceScope?: SettingsSyncSourceScope,
): string {
  return sourceScope ? `${agent}:${category}:${sourceScope}` : `${agent}:${category}`;
}

export function getResourceSelectionKey(payload: ResourceSelectionKeyPayload): string {
  return JSON.stringify(payload);
}

export function readResourceSelectionKey(key: string): ResourceSelectionKeyPayload | null {
  try {
    const payload = JSON.parse(key) as Partial<ResourceSelectionKeyPayload>;
    if (
      typeof payload.agent !== "string" ||
      typeof payload.category !== "string" ||
      typeof payload.resourcePath !== "string"
    ) {
      return null;
    }
    return {
      agent: payload.agent,
      category: payload.category as ImportResourceCategory,
      ...(payload.sourceScope ? { sourceScope: payload.sourceScope } : {}),
      resourcePath: payload.resourcePath,
    };
  } catch {
    return null;
  }
}

export function buildExternalAgentImportSelections(
  selectedKeys: string[],
  targetScope: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode,
): SettingsSyncSelection[] {
  const grouped = new Map<string, SettingsSyncSelection>();
  for (const key of selectedKeys) {
    const payload = readResourceSelectionKey(key);
    if (!payload) {
      continue;
    }
    const groupKey = JSON.stringify([payload.agent, payload.category, payload.sourceScope ?? null]);
    const selection = grouped.get(groupKey) ?? {
      agent: payload.agent as SettingsSyncSelection["agent"],
      category: payload.category as SettingsSyncSelection["category"],
      ...(payload.sourceScope ? { sourceScope: payload.sourceScope } : {}),
      targetScope,
      importMode,
      ...(payload.category === "skills"
        ? { skillPaths: [] }
        : payload.category === "commands"
          ? { commandPaths: [] }
          : payload.category === "plugins"
            ? { pluginPaths: [] }
            : { mcpServerPaths: [] }),
    };
    if (payload.category === "skills") {
      selection.skillPaths = [...(selection.skillPaths ?? []), payload.resourcePath];
    } else if (payload.category === "commands") {
      selection.commandPaths = [...(selection.commandPaths ?? []), payload.resourcePath];
    } else if (payload.category === "plugins") {
      selection.pluginPaths = [...(selection.pluginPaths ?? []), payload.resourcePath];
    } else {
      selection.mcpServerPaths = [...(selection.mcpServerPaths ?? []), payload.resourcePath];
    }
    grouped.set(groupKey, selection);
  }
  return [...grouped.values()];
}
