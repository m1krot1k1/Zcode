/**
 * `ui-lexical-ghost-autocomplete` манифест (architecture-governance managed module).
 * Слой ui: только представление ghost-текста; сеть и политика — в services.
 */
export const uiLexicalGhostAutocompleteModule = {
  id: "ui-lexical-ghost-autocomplete",
  requires: ["services", "shared", "ui"],
  provides: ["ui-lexical-ghost-autocomplete"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
