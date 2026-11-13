/** SkillsSection 的纯展示助手：workspace 名、发布时间与作用域标签。 */
import type { SkillSummary } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import type { SkillScopeLabelContext } from "@/settings/skills-section/types.js";

export function getWorkspaceBasename(workspacePath: string | null): string {
  if (!workspacePath) return "";
  return workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath;
}

export function formatSkillPublishedAt(
  timestamp: number | undefined,
): string | null {
  if (timestamp === undefined) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

export function resolveSkillScopeLabel(
  skill: SkillSummary,
  intl: IntlInstance,
  context: SkillScopeLabelContext,
): string {
  switch (skill.scope) {
    case "workspace":
      // workspace 作用域显示 workspace 名，没有 workspace 时退回到通用文案。
      return (
        context.workspaceLabel ||
        intl.formatMessage({
          id: "settings.skills.scope.workspaceFallback",
        })
      );
    case "plugin":
      return skill.pluginName?.trim()
        ? resolvePluginDisplayName(
            {
              name: skill.pluginName,
              listing:
                (skill.pluginId
                  ? context.pluginListingById.get(skill.pluginId)
                  : undefined) ??
                resolveUniquePluginListingByName(
                  context.availablePlugins,
                  skill.pluginName,
                ),
            },
            context.locale,
          )
        : intl.formatMessage({ id: "settings.skills.scope.plugin" });
    case "user":
    default:
      return intl.formatMessage({ id: "settings.skills.scope.personal" });
  }
}
