import {
  projectStage4SettingsToCliConfig,
  projectStage4SettingsToSessionPreferences,
} from "./host-runtime.js";
import { stage4SettingsObjectSchema, type Stage4Settings } from "./settings.js";

/** Настройки, прочитанные из `setting.json`: та же схема, что и для записи. */
export function readStage4Settings(raw: unknown): Stage4Settings {
  return stage4SettingsObjectSchema.parse(raw);
}

/** Host превращает настройки в session preferences и проекцию CLI-конфига. */
export function projectForRuntime(settings: Stage4Settings): {
  session: ReturnType<typeof projectStage4SettingsToSessionPreferences>;
  cli: ReturnType<typeof projectStage4SettingsToCliConfig>;
} {
  return {
    session: projectStage4SettingsToSessionPreferences(settings),
    cli: projectStage4SettingsToCliConfig(settings),
  };
}
