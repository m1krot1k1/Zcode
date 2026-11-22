/**
 * `shared-prompt-enhancer` манифест (architecture-governance managed module).
 * Чистый контракт: Zod-схемы и лимиты без Node-зависимостей и без вызова модели.
 */
export const sharedPromptEnhancerModule = {
  id: "shared-prompt-enhancer",
  requires: [],
  provides: ["shared-prompt-enhancer"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
