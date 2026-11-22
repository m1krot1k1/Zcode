export {
  createChatAutocompleteService,
  pickCheapestReasoningLevel,
  resolveAdaptiveDebounceMs,
  resolveAutocompleteWorkspaceKey,
  type ChatAutocompleteContextPorts,
  type ChatAutocompleteModelResolver,
  type ChatAutocompleteServiceOptions,
  type ChatAutocompleteTextGenerator,
} from "./service.js";
export { IChatAutocompleteService, type ChatAutocompleteService } from "./contract.js";
export { createChatAutocompleteContextPorts, createChatAutocompletePaths } from "./ports.js";
export {
  PrefixRingCache,
  type PrefixCacheHit,
  type PrefixCacheEntry,
} from "./prefix-ring-cache.js";
export {
  UserLexiconStore,
  applyObservation,
  extractImperativePattern,
  extractLexiconPhrases,
  userLexiconPath,
  type LexiconFileBackend,
  type UserLexiconStoreOptions,
} from "./user-lexicon-store.js";
