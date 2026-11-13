import type {
  SettingsSyncAgentSummary,
  SettingsSyncImportMode,
  SettingsSyncImportResult,
  SettingsSyncSourceRootSummary,
  SettingsSyncSourceScope,
} from "@zcode/shared";
import type {
  ImportIntl,
  ImportItemResult,
  ImportItemSummary,
  ImportResourceCategory,
} from "./types.js";

export const SOURCE_ROOT_SCOPE_ORDER: SettingsSyncSourceScope[] = ["global", "project"];
export const IMPORT_MODE_ORDER: SettingsSyncImportMode[] = ["symlink", "copy"];

export function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getImportResults(
  result: SettingsSyncImportResult | null,
  category: ImportResourceCategory,
): ImportItemResult[] {
  return (
    result?.taskResults.flatMap((taskResult) =>
      category === "skills"
        ? (taskResult.skillResults ?? [])
        : category === "commands"
          ? (taskResult.commandResults ?? [])
          : category === "plugins"
            ? (taskResult.pluginResults ?? [])
            : (taskResult.mcpServerResults ?? []),
    ) ?? []
  );
}

export function formatAgentName(agent: string, intl: ImportIntl): string {
  switch (agent) {
    case "cline":
      return intl.formatMessage({ id: "settingsSync.agent.cline" });
    case "claudeCode":
      return intl.formatMessage({ id: "settingsSync.agent.claudeCode" });
    case "codexCli":
      return intl.formatMessage({ id: "settingsSync.agent.codexCli" });
    case "openCode":
      return intl.formatMessage({ id: "settingsSync.agent.openCode" });
    case "openClaw":
      return intl.formatMessage({ id: "settingsSync.agent.openClaw" });
    case "augment":
      return intl.formatMessage({ id: "settingsSync.agent.augment" });
    case "continue":
      return intl.formatMessage({ id: "settingsSync.agent.continue" });
    case "goose":
      return intl.formatMessage({ id: "settingsSync.agent.goose" });
    case "qwenCode":
      return intl.formatMessage({ id: "settingsSync.agent.qwenCode" });
    case "qode":
      return intl.formatMessage({ id: "settingsSync.agent.qode" });
    case "qodeCn":
      return intl.formatMessage({ id: "settingsSync.agent.qodeCn" });
    case "windsurf":
      return intl.formatMessage({ id: "settingsSync.agent.windsurf" });
    case "trae":
      return intl.formatMessage({ id: "settingsSync.agent.trae" });
    case "traeCn":
      return intl.formatMessage({ id: "settingsSync.agent.traeCn" });
    case "kiroCli":
      return intl.formatMessage({ id: "settingsSync.agent.kiroCli" });
    case "roo":
      return intl.formatMessage({ id: "settingsSync.agent.roo" });
    case "codeBuddy":
      return intl.formatMessage({ id: "settingsSync.agent.codeBuddy" });
    case "agents":
      return intl.formatMessage({ id: "settingsSync.agent.agents" });
    case "zcode":
      return intl.formatMessage({ id: "settingsSync.agent.zcode" });
    default:
      return agent;
  }
}

export function getResourceCategory(
  agent: SettingsSyncAgentSummary,
  resourceCategory: ImportResourceCategory,
) {
  return agent.categories.find((summary) => summary.category === resourceCategory);
}

export function formatSourceRootScope(
  scope: SettingsSyncSourceScope,
  intl: ImportIntl,
  resourceCategory: ImportResourceCategory,
): string {
  return intl.formatMessage({ id: `settings.${resourceCategory}.import.scope.${scope}` });
}

export function getSourceRootItems(
  sourceRoot: SettingsSyncSourceRootSummary,
  resourceCategory: ImportResourceCategory,
): ImportItemSummary[] {
  return resourceCategory === "skills"
    ? (sourceRoot.skills ?? [])
    : resourceCategory === "commands"
      ? (sourceRoot.commands ?? [])
      : resourceCategory === "plugins"
        ? (sourceRoot.plugins ?? [])
        : (sourceRoot.mcpServers ?? []);
}

function normalizePathForScope(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

export function inferSourceRootScope(
  path: string,
  workspacePath: string | null | undefined,
): SettingsSyncSourceScope {
  if (!workspacePath) {
    return "global";
  }
  const normalizedPath = normalizePathForScope(path);
  const normalizedWorkspacePath = normalizePathForScope(workspacePath);
  return normalizedPath === normalizedWorkspacePath ||
    normalizedPath.startsWith(`${normalizedWorkspacePath}/`)
    ? "project"
    : "global";
}

export function getSourceRoots(
  agent: SettingsSyncAgentSummary,
  workspacePath: string | null | undefined,
  resourceCategory: ImportResourceCategory,
): SettingsSyncSourceRootSummary[] {
  const category = getResourceCategory(agent, resourceCategory);
  if (!category) {
    return [];
  }
  if (category.sourceRoots && category.sourceRoots.length > 0) {
    return category.sourceRoots;
  }
  return (category.sourcePaths ?? []).map((path) => ({
    scope: inferSourceRootScope(path, workspacePath),
    path,
    discoveredCount: category.discoveredCount,
    importableCount: category.importableCount,
    skippedCount: category.skippedCount,
  }));
}

export interface SourceRootScopeGroup {
  scope: SettingsSyncSourceScope;
  rows: Array<{
    agent: SettingsSyncAgentSummary;
    sourceRoot: SettingsSyncSourceRootSummary;
  }>;
}

export function groupAgentsBySourceRootScope(
  agents: SettingsSyncAgentSummary[],
  workspacePath: string | null | undefined,
  resourceCategory: ImportResourceCategory,
): SourceRootScopeGroup[] {
  return SOURCE_ROOT_SCOPE_ORDER.map((scope) => ({
    scope,
    rows: agents.flatMap((agent) =>
      getSourceRoots(agent, workspacePath, resourceCategory)
        .filter((sourceRoot) => sourceRoot.scope === scope)
        .filter((sourceRoot) =>
          getSourceRootItems(sourceRoot, resourceCategory).some((item) => item.importable),
        )
        .map((sourceRoot) => ({ agent, sourceRoot })),
    ),
  }));
}
