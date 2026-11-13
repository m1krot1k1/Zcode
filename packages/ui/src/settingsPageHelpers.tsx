/**
 * 设置页 helper 的公开出口：设置页配置、代理展示、归档/运行上限/通用内容组件。
 *
 * 实现按职责拆分在 `settings-page-helpers/`（单文件均低于 800 有效行），
 * 本文件只做 re-export，保持 `@/settingsPageHelpers.js` 的导入路径与导出名不变。
 */
export {
  createSettingsPageConfig,
  isSettingsSectionAvailable,
  resolveSettingsSectionForPlatform,
} from "@/settings/settingsPageConfig.js";
export { sanitizeProxyRouteForDisplay } from "@/settings-page-helpers/sanitizeProxyRouteForDisplay.js";
export { TaskAutoArchiveSettings } from "@/settings-page-helpers/TaskAutoArchiveSettings.js";
export type { RunLimitSaveResult } from "@/settings-page-helpers/RunLimitSettingRow.js";
export { GeneralSectionContent } from "@/settings-page-helpers/GeneralSectionContent.js";
export { GeneralSectionHeader } from "@/settings-page-helpers/GeneralSectionHeader.js";
