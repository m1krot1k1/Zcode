import {
  DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
  type GhostAutocompleteConfig,
} from "./contract.js";

/** Композер собирает конфигурацию плагина из настроек `chatAutocompleteSettings`. */
export function buildGhostConfig(settings: {
  enabled: boolean;
  debounceMs: number;
  acceptWordOnArrowRight: boolean;
  minPrefixChars: number;
  cursorAtEndOnly: boolean;
  context: GhostAutocompleteConfig["context"];
  modelOverride: { providerId: string; modelId: string } | null;
}): GhostAutocompleteConfig {
  return {
    ...DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
    enabled: settings.enabled,
    baseDebounceMs: settings.debounceMs,
    minPrefixChars: settings.minPrefixChars,
    cursorAtEndOnly: settings.cursorAtEndOnly,
    context: settings.context,
    keymap: {
      ...DEFAULT_GHOST_AUTOCOMPLETE_CONFIG.keymap,
      acceptWord: settings.acceptWordOnArrowRight ? "ArrowRight" : "off",
    },
    ...(settings.modelOverride ? { modelSelection: settings.modelOverride } : {}),
  };
}
