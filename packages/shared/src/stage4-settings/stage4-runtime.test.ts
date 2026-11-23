import { describe, expect, it } from "vitest";
import {
  agentCoreAdvancedSettingsSchema,
  resolveStage4Settings,
  stage4SettingsObjectSchema,
  stage4SettingsPatchSchema,
} from "./settings.js";
import { chatAutocompleteSettingsSchema } from "../chat-autocomplete/contract.js";
import {
  projectStage4SettingsToCliConfig,
  projectStage4SettingsToSessionPreferences,
} from "./host-runtime.js";
import { resolvePromptDepthProfile } from "../prompt-depth.js";

/**
 * Сквозное применение настроек: UI-патч → схема `AppSettings` → проекция в рантайм.
 *
 * Проверяем именно путь данных (единственный владелец `settingService`), а не
 * отрисовку: если проекция теряет поле, настройка в UI станет «пустышкой».
 */
describe("stage4 settings runtime projection", () => {
  it("подставляет дефолты для устаревшего setting.json без новых секций", () => {
    const resolved = resolveStage4Settings({});
    expect(resolved.agentCoreAdvanced.workingContextCeilingTokens).toBe(0);
    // Ghost-подсказка включена по умолчанию; выключение — явный выбор пользователя.
    expect(resolved.chatAutocompleteSettings.enabled).toBe(true);
    expect(resolved.proactiveSuggestionSettings.enabled).toBe(true);
    expect(resolved.proactiveSuggestionSettings.maxSuggestionsPerTurn).toBe(1);
    expect(resolved.sandboxSettings.mode).toBe("off");
    expect(resolved.browserAssistantSettings.ariaSnapshotMaxNodes).toBe(4_000);
    // Новый setting.json должен сразу сохранять off, а не только нормализоваться
    // в рантайме: иначе UI увидит legacy auto и снова покажет несуществующий режим.
    expect(stage4SettingsObjectSchema.parse({}).sandboxSettings.mode).toBe("off");
  });

  it("трактует сохранённый старый режим auto как off", () => {
    const legacy = {
      sandboxSettings: {
        ...resolveStage4Settings({}).sandboxSettings,
        mode: "auto" as const,
      },
    };
    expect(resolveStage4Settings(legacy).sandboxSettings.mode).toBe("off");
  });

  it("проводит изменённые значения до session preferences", () => {
    const settings = {
      ...resolveStage4Settings({}),
      agentCoreAdvanced: {
        workingContextCeilingTokens: 240_000,
        enableAutoRepairLoop: true,
        autoRepairLoopMaxIterations: 6,
        autoRepairLoopMaxElapsedMs: 300_000,
      },
      parallelJobsSettings: {
        maxParallelSubagents: 4,
        pathConflictPolicy: "worktree" as const,
        backgroundFileTasks: false,
      },
      sandboxSettings: {
        mode: "bwrap" as const,
        allowBashNetwork: false,
        commandTimeoutMs: 60_000,
        cuaPermissions: {
          screenshot: false,
          pointer: true,
          keyboard: false,
          clipboard: true,
        },
      },
    };
    const runtime = projectStage4SettingsToSessionPreferences(settings);
    expect(runtime.workingContextCeilingTokens).toBe(240_000);
    expect(runtime.enableAutoRepairLoop).toBe(true);
    expect(runtime.autoRepairLoopLimits).toEqual({
      maxIterations: 6,
      maxElapsedMs: 300_000,
    });
    expect(runtime.subagentMaxParallel).toBe(4);
    // Песочница вне `off` не ослабляет границу workspace.
    expect(runtime.workspaceBoundary).toBe("ask");

    const cli = projectStage4SettingsToCliConfig(settings);
    expect(cli.sandbox.mode).toBe("bwrap");
    expect(cli.sandbox.networkAccess).toBe("deny");
    expect(cli.subagents.pathConflictPolicy).toBe("worktree");
    expect(cli.codeIndex.enableVectorChannel).toBe(true);
  });

  it("принимает частичный патч AppSettings только по переданным секциям", () => {
    const patch = stage4SettingsPatchSchema.parse({
      chatAutocompleteSettings: { enabled: true, debounceMs: 400 },
    });
    expect(patch.chatAutocompleteSettings?.debounceMs).toBe(400);
    expect(patch.agentCoreAdvanced).toBeUndefined();
  });

  it("отклоняет значения вне диапазона вместо тихого сброса", () => {
    expect(
      agentCoreAdvancedSettingsSchema.safeParse({
        autoRepairLoopMaxIterations: 99,
      }).success,
    ).toBe(false);
    expect(chatAutocompleteSettingsSchema.safeParse({ debounceMs: 10 }).success).toBe(false);
  });

  it("дефолтная object-схема валидна целиком", () => {
    expect(stage4SettingsObjectSchema.safeParse({}).success).toBe(true);
  });

  it("нормализует неизвестную глубину рассуждений к standard", () => {
    expect(resolvePromptDepthProfile("deep")).toBe("deep");
    expect(resolvePromptDepthProfile("unknown-profile")).toBe("standard");
    expect(resolvePromptDepthProfile(undefined)).toBe("standard");
  });
});
