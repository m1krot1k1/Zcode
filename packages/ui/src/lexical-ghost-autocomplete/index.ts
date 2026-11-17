export {
  DEFAULT_GHOST_AUTOCOMPLETE_CONFIG,
  resolveGhostAutocompleteSkip,
  type GhostAutocompleteConfig,
  type GhostAutocompleteKeymap,
  type GhostAutocompletePromptState,
  type GhostAutocompleteSkipReason,
} from "./contract.js";
export {
  $acceptGhostText,
  $createGhostTextNode,
  $isGhostTextNode,
  $removeGhostText,
  GhostTextNode,
} from "./GhostTextNode.js";
export {
  GhostTextAutocompletePlugin,
  type GhostTextAutocompletePluginProps,
} from "./GhostTextAutocompletePlugin.js";
export {
  useChatAutocomplete,
  type ChatAutocompleteState,
  type UseChatAutocompleteOptions,
  type UseChatAutocompleteResult,
} from "./useChatAutocomplete.js";
