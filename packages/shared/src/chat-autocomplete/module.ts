/**
 * `shared-chat-autocomplete` манифест (architecture-governance managed module).
 * Чистый контракт: Zod-схемы, лимиты и чистые функции пост-обработки без IO.
 */
export const sharedChatAutocompleteModule = {
  id: "shared-chat-autocomplete",
  requires: [],
  provides: ["shared-chat-autocomplete"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
