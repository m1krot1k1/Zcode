// SettingsPage 拆分（max-lines）：由 createSettingsPageConfig 推导的分组/分区类型，避免重复声明。
import type { createSettingsPageConfig } from "@/settingsPageHelpers.js";

type SettingsPageConfigShape = ReturnType<typeof createSettingsPageConfig>;

export type SettingsSectionGroup = SettingsPageConfigShape["settingsSectionGroups"][number];
