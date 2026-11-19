/**
 * `ui-composer-proactive-suggestion` манифест (architecture-governance managed module).
 * Слой ui: контроллер, hook и презентационная подсказка; сервис приходит портом.
 */
export const composerProactiveSuggestionModule = {
  id: "ui-composer-proactive-suggestion",
  requires: ["shared", "ui"],
  provides: ["ui-composer-proactive-suggestion"],
  publicEntrypoints: ["index.ts"],
} as const;
