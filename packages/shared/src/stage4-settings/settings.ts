import { z } from "zod";
import {
  chatAutocompleteSettingsSchema,
  promptEnhancerSettingsSchema,
} from "../chat-autocomplete/contract.js";

/**
 * Единая схема настроек подсистем Этапов 4.1–4.6.
 *
 * Владелец — `settingService` (`~/.zcode/v2/setting.json`). Здесь только строгая
 * схема и дефолты; runtime-маппинг (Host → CLI, `config/hotReload`) живёт в
 * `packages/services/src/setting/cliConfigSyncBridge.ts`, чтобы не было второй копии истины.
 */

/** Агентное ядро: глубина рассуждений, рабочий контекст и авторемонт. */
export const agentCoreAdvancedSettingsSchema = z
  .object({
    workingContextCeilingTokens: z.number().int().min(48_000).max(500_000).default(120_000),
    enableAutoRepairLoop: z.boolean().default(false),
    autoRepairLoopMaxIterations: z.number().int().min(1).max(12).default(4),
    autoRepairLoopMaxElapsedMs: z.number().int().min(10_000).max(900_000).default(180_000),
  })
  .strict();
export type AgentCoreAdvancedSettings = z.infer<typeof agentCoreAdvancedSettingsSchema>;

/** Параллельные и фоновые задачи. */
export const parallelJobsSettingsSchema = z
  .object({
    /** 0 — автоподбор по доступным ядрам; иначе жёсткий предел. */
    maxParallelSubagents: z.number().int().min(0).max(32).default(0),
    pathConflictPolicy: z.enum(["block", "wave", "worktree"]).default("wave"),
    backgroundFileTasks: z.boolean().default(true),
  })
  .strict();
export type ParallelJobsSettings = z.infer<typeof parallelJobsSettingsSchema>;

/** Кодовая индексация (4.3) — часть настроек, читаемых Host'ом. */
export const codeIndexSettingsSchema = z
  .object({
    autoStartOnWorkspaceOpen: z.boolean().default(true),
    enableVectorChannel: z.boolean().default(true),
    searchResultTokenBudget: z.number().int().min(1_000).max(12_000).default(4_000),
    excludedDirectories: z.array(z.string().trim().min(1).max(512)).max(64).default([]),
  })
  .strict();
export type CodeIndexSettings = z.infer<typeof codeIndexSettingsSchema>;

/** Песочница и Computer Use (4.5a/4.5b). */
export const sandboxSettingsSchema = z
  .object({
    mode: z.enum(["auto", "bwrap", "seatbelt", "off"]).default("auto"),
    /** Сетевой доступ для bash внутри песочницы. */
    allowBashNetwork: z.boolean().default(true),
    commandTimeoutMs: z.number().int().min(1_000).max(1_800_000).default(180_000),
    cuaPermissions: z
      .object({
        screenshot: z.boolean().default(true),
        pointer: z.boolean().default(false),
        keyboard: z.boolean().default(false),
        clipboard: z.boolean().default(false),
      })
      .strict()
      .default({ screenshot: true, pointer: false, keyboard: false, clipboard: false }),
  })
  .strict();
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

/** Встроенный браузер: телеметрия и бюджеты снимков. */
export const browserAssistantSettingsSchema = z
  .object({
    telemetryEnabled: z.boolean().default(false),
    screenshotBudgetBytes: z.number().int().min(64 * 1024).max(8 * 1024 * 1024).default(1_048_576),
    ariaSnapshotMaxNodes: z.number().int().min(200).max(20_000).default(4_000),
    autoCloseDialogs: z.boolean().default(true),
  })
  .strict();
export type BrowserAssistantSettings = z.infer<typeof browserAssistantSettingsSchema>;

export const stage4SettingsObjectSchema = z.object({
  agentCoreAdvanced: agentCoreAdvancedSettingsSchema.default({
    workingContextCeilingTokens: 120_000,
    enableAutoRepairLoop: false,
    autoRepairLoopMaxIterations: 4,
    autoRepairLoopMaxElapsedMs: 180_000,
  }),
  promptEnhancerSettings: promptEnhancerSettingsSchema.default({
    enabled: true,
    style: "structured_engineering",
    maxContextSources: 4,
    modelOverride: null,
    includeCodeIndexContext: true,
    includeConversationHistory: true,
  }),
  chatAutocompleteSettings: chatAutocompleteSettingsSchema.default({
    enabled: false,
    debounceMs: 250,
    acceptWordOnArrowRight: true,
    minPrefixChars: 6,
    cursorAtEndOnly: true,
    modelOverride: null,
    context: {
      history: true,
      openFiles: true,
      diffs: true,
      codeIndex: true,
      userLexicon: true,
    },
  }),
  parallelJobsSettings: parallelJobsSettingsSchema.default({
    maxParallelSubagents: 0,
    pathConflictPolicy: "wave",
    backgroundFileTasks: true,
  }),
  codeIndexSettings: codeIndexSettingsSchema.default({
    autoStartOnWorkspaceOpen: true,
    enableVectorChannel: true,
    searchResultTokenBudget: 4_000,
    excludedDirectories: [],
  }),
  sandboxSettings: sandboxSettingsSchema.default({
    mode: "auto",
    allowBashNetwork: true,
    commandTimeoutMs: 180_000,
    cuaPermissions: { screenshot: true, pointer: false, keyboard: false, clipboard: false },
  }),
  browserAssistantSettings: browserAssistantSettingsSchema.default({
    telemetryEnabled: false,
    screenshotBudgetBytes: 1_048_576,
    ariaSnapshotMaxNodes: 4_000,
    autoCloseDialogs: true,
  }),
});

/**
 * Единая точка нормализации: `AppSettings` может не содержать новых секций
 * (старый `setting.json`, remote Host без обновления), поэтому значения
 * прогоняются через object-схему с дефолтами. Второй копии дефолтов нет.
 */
export function resolveStage4Settings(
  source: Partial<Stage4Settings> | null | undefined,
): Stage4Settings {
  return stage4SettingsObjectSchema.parse(source ?? {});
}

export const stage4SettingsPatchSchema = z.object({
  agentCoreAdvanced: agentCoreAdvancedSettingsSchema.optional(),
  promptEnhancerSettings: promptEnhancerSettingsSchema.optional(),
  chatAutocompleteSettings: chatAutocompleteSettingsSchema.optional(),
  parallelJobsSettings: parallelJobsSettingsSchema.optional(),
  codeIndexSettings: codeIndexSettingsSchema.optional(),
  sandboxSettings: sandboxSettingsSchema.optional(),
  browserAssistantSettings: browserAssistantSettingsSchema.optional(),
});

export type Stage4Settings = z.infer<typeof stage4SettingsObjectSchema>;
