import type {
  AgentCoreAdvancedSettings,
  BrowserAssistantSettings,
  ChatAutocompleteSettings,
  CodeIndexSettings,
  ProactiveSuggestionSettings,
  ParallelJobsSettings,
  PromptEnhancerSettings,
  SandboxSettings,
} from "@zcode/shared";

/**
 * Контракт managed-модуля `ui-settings-stage4`.
 *
 * Владелец значений — `settingService`; модуль только описывает группы,
 * подписи и правила частичных патчей. Второй копии истины здесь нет:
 * компоненты читают `AppSettings` и пишут патч через `updateSharedSettings`.
 */

export type Stage4SettingsGroupId =
  | "agentReasoning"
  | "promptEnhancer"
  | "chatAutocomplete"
  | "proactiveSuggestion"
  | "parallelJobs"
  | "codeIndex"
  | "sandbox"
  | "browser";

export interface Stage4SettingsGroupDescriptor {
  id: Stage4SettingsGroupId;
  titleId: string;
  descriptionId: string;
}

/** Порядок групп повторяет порядок инкрементов 4.1 → 4.6. */
export const STAGE4_SETTINGS_GROUPS: readonly Stage4SettingsGroupDescriptor[] = [
  {
    id: "agentReasoning",
    titleId: "settings.stage4.agentReasoning.title",
    descriptionId: "settings.stage4.agentReasoning.description",
  },
  {
    id: "promptEnhancer",
    titleId: "settings.stage4.promptEnhancer.title",
    descriptionId: "settings.stage4.promptEnhancer.description",
  },
  {
    id: "chatAutocomplete",
    titleId: "settings.stage4.chatAutocomplete.title",
    descriptionId: "settings.stage4.chatAutocomplete.description",
  },
  {
    id: "proactiveSuggestion",
    titleId: "settings.stage4.proactiveSuggestion.title",
    descriptionId: "settings.stage4.proactiveSuggestion.description",
  },
  {
    id: "parallelJobs",
    titleId: "settings.stage4.parallelJobs.title",
    descriptionId: "settings.stage4.parallelJobs.description",
  },
  {
    id: "codeIndex",
    titleId: "settings.stage4.codeIndex.title",
    descriptionId: "settings.stage4.codeIndex.description",
  },
  {
    id: "sandbox",
    titleId: "settings.stage4.sandbox.title",
    descriptionId: "settings.stage4.sandbox.description",
  },
  {
    id: "browser",
    titleId: "settings.stage4.browser.title",
    descriptionId: "settings.stage4.browser.description",
  },
];

/** Секции, которые реально меняют поведение рантайма. */
export interface Stage4SettingsPatchSurface {
  agentCoreAdvanced?: AgentCoreAdvancedSettings;
  promptEnhancerSettings?: PromptEnhancerSettings;
  chatAutocompleteSettings?: ChatAutocompleteSettings;
  proactiveSuggestionSettings?: ProactiveSuggestionSettings;
  parallelJobsSettings?: ParallelJobsSettings;
  codeIndexSettings?: CodeIndexSettings;
  sandboxSettings?: SandboxSettings;
  browserAssistantSettings?: BrowserAssistantSettings;
}

/**
 * Частичное обновление вложенной секции.
 *
 * `settingService` мержит объекты на уровне `AppSettings`, поэтому вложенную
 * секцию нужно передавать целиком. Хелпер гарантирует, что новая копия не потеряет
 * поля, которые UI не показывает (например `modelOverride`).
 */
export function mergeStage4Section<T extends object>(current: T, patch: Partial<T>): T {
  return { ...current, ...patch };
}

/** Поиск по настройкам: строка совпадает, если содержит любой из ключей i18n. */
export function matchesStage4Search(
  query: string,
  candidates: readonly (string | null | undefined)[],
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return candidates.some((candidate) => candidate?.toLowerCase().includes(needle));
}
