/**
 * `services-proactive-suggestion` манифест (architecture-governance managed module).
 * Слой adapters: модель и транспорт приходят портами из registration.
 */
export const proactiveSuggestionModule = {
  id: "services-proactive-suggestion",
  requires: ["services", "shared"],
  provides: ["services-proactive-suggestion"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
