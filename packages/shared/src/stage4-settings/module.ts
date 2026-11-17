/**
 * `shared-stage4-settings` манифест (architecture-governance managed module).
 * Слой contract: только Zod-схемы настроек подсистем Этапа 4.
 */
export const sharedStage4SettingsModule = {
  id: "shared-stage4-settings",
  // `shared` нужен для `../prompt-depth.js`: enum глубины рассуждений общий с рантаймом.
  requires: ["shared", "shared-chat-autocomplete"],
  provides: ["shared-stage4-settings"],
  publicEntrypoints: ["index.ts", "settings.ts"],
} as const;
