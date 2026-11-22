/**
 * `ui-prompt-enhancer` манифест (architecture-governance managed module).
 * Слой ui: кнопка композера и действие улучшения системных инструкций.
 */
export const uiPromptEnhancerModule = {
  id: "ui-prompt-enhancer",
  requires: ["services", "shared", "ui"],
  provides: ["ui-prompt-enhancer"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
