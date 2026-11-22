import type { Stage4Settings } from "./settings.js";

/**
 * Runtime-проекция настроек Этапа 4 в Хост/CLI.
 *
 * Чистая функция без IO: UI-настройки → значения, которые реально читают
 * `resolveSessionRuntimePreferences` и `cliConfigSyncBridge`. Так UI, Host и
 * CLI используют один маппинг и не выводят поведение из дефолтов заново.
 */

export interface SessionRuntimePreferencesPatch {
  workingContextCeilingTokens: number;
  enableAutoRepairLoop: boolean;
  autoRepairLoopLimits: { maxIterations: number; maxElapsedMs: number };
  workspaceBoundary: "strict" | "ask" | "allow";
  subagentMaxParallel: number;
}

export interface CliConfigRuntimePatch {
  /** Значения, которые пишутся в `<dataBaseDir>/cli/config.json`. */
  compact: { workingContextCeilingTokens: number; enabled: boolean };
  autoRepair: {
    enabled: boolean;
    maxIterations: number;
    maxElapsedMs: number;
  };
  sandbox: {
    mode: "auto" | "bwrap" | "seatbelt" | "off";
    networkAccess: "allow" | "deny";
    commandTimeoutMs: number;
  };
  codeIndex: {
    autoStartOnWorkspaceOpen: boolean;
    enableVectorChannel: boolean;
    searchResultTokenBudget: number;
    excludedDirectories: readonly string[];
  };
  browser: {
    telemetryEnabled: boolean;
    screenshotBudgetBytes: number;
    ariaSnapshotMaxNodes: number;
    autoCloseDialogs: boolean;
  };
  subagents: { maxParallel: number; pathConflictPolicy: "block" | "wave" | "worktree" };
  promptEnhancer: {
    enabled: boolean;
    style: Stage4Settings["promptEnhancerSettings"]["style"];
    maxContextSources: number;
    includeCodeIndexContext: boolean;
    includeConversationHistory: boolean;
  };
  chatAutocomplete: {
    enabled: boolean;
    debounceMs: number;
    acceptWordOnArrowRight: boolean;
    minPrefixChars: number;
    cursorAtEndOnly: boolean;
  };
}

export function projectStage4SettingsToSessionPreferences(
  settings: Stage4Settings,
): SessionRuntimePreferencesPatch {
  return {
    workingContextCeilingTokens: settings.agentCoreAdvanced.workingContextCeilingTokens,
    enableAutoRepairLoop: settings.agentCoreAdvanced.enableAutoRepairLoop,
    autoRepairLoopLimits: {
      maxIterations: settings.agentCoreAdvanced.autoRepairLoopMaxIterations,
      maxElapsedMs: settings.agentCoreAdvanced.autoRepairLoopMaxElapsedMs,
    },
    // Песочница `off` — единственный режим, где граница workspace ослаблена осознанно.
    workspaceBoundary: settings.sandboxSettings.mode === "off" ? "allow" : "ask",
    subagentMaxParallel: settings.parallelJobsSettings.maxParallelSubagents,
  };
}

export function projectStage4SettingsToCliConfig(settings: Stage4Settings): CliConfigRuntimePatch {
  return {
    compact: {
      workingContextCeilingTokens: settings.agentCoreAdvanced.workingContextCeilingTokens,
      enabled: true,
    },
    autoRepair: {
      enabled: settings.agentCoreAdvanced.enableAutoRepairLoop,
      maxIterations: settings.agentCoreAdvanced.autoRepairLoopMaxIterations,
      maxElapsedMs: settings.agentCoreAdvanced.autoRepairLoopMaxElapsedMs,
    },
    sandbox: {
      mode: settings.sandboxSettings.mode,
      networkAccess: settings.sandboxSettings.allowBashNetwork ? "allow" : "deny",
      commandTimeoutMs: settings.sandboxSettings.commandTimeoutMs,
    },
    codeIndex: {
      autoStartOnWorkspaceOpen: settings.codeIndexSettings.autoStartOnWorkspaceOpen,
      enableVectorChannel: settings.codeIndexSettings.enableVectorChannel,
      searchResultTokenBudget: settings.codeIndexSettings.searchResultTokenBudget,
      excludedDirectories: [...settings.codeIndexSettings.excludedDirectories],
    },
    browser: { ...settings.browserAssistantSettings },
    subagents: {
      maxParallel: settings.parallelJobsSettings.maxParallelSubagents,
      pathConflictPolicy: settings.parallelJobsSettings.pathConflictPolicy,
    },
    promptEnhancer: {
      enabled: settings.promptEnhancerSettings.enabled,
      style: settings.promptEnhancerSettings.style,
      maxContextSources: settings.promptEnhancerSettings.maxContextSources,
      includeCodeIndexContext: settings.promptEnhancerSettings.includeCodeIndexContext,
      includeConversationHistory: settings.promptEnhancerSettings.includeConversationHistory,
    },
    chatAutocomplete: {
      enabled: settings.chatAutocompleteSettings.enabled,
      debounceMs: settings.chatAutocompleteSettings.debounceMs,
      acceptWordOnArrowRight: settings.chatAutocompleteSettings.acceptWordOnArrowRight,
      minPrefixChars: settings.chatAutocompleteSettings.minPrefixChars,
      cursorAtEndOnly: settings.chatAutocompleteSettings.cursorAtEndOnly,
    },
  };
}
