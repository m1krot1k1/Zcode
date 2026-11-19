/**
 * `shared-proactive-suggestion` манифест (architecture-governance managed module).
 * Чистый контракт: Zod-схемы, лимиты и типы без IO.
 */
export const sharedProactiveSuggestionModule = {
  id: "shared-proactive-suggestion",
  requires: [],
  provides: ["shared-proactive-suggestion"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
