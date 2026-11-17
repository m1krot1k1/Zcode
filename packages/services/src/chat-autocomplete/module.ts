/**
 * `chat-autocomplete` манифест (architecture-governance managed module).
 * Слой adapters: сервис опирается на текстовый генератор Host'а и порты контекста,
 * но не импортирует runtime конкретных реализаций.
 */
export const chatAutocompleteModule = {
  id: "services-chat-autocomplete",
  requires: ["code-intelligence", "services", "shared"],
  provides: ["services-chat-autocomplete"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
