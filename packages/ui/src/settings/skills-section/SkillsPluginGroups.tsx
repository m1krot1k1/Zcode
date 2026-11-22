/** 插件来源的技能分组：按插件呈现独立列表。 */
import {
  resolvePluginDisplayName,
  resolveUniquePluginListingByName,
} from "@/settings/pluginStoreListing.js";
import { SettingsResourceGroupHeader } from "@/settings/SettingsResourceGroup.js";
import { SkillList } from "@/settings/skills-section/SkillList.js";
import type { SkillsPluginGroupsProps } from "@/settings/skills-section/types.js";

export function SkillsPluginGroups({
  groups,
  locale,
  pluginListingById,
  availablePlugins,
  renderRow,
}: SkillsPluginGroupsProps) {
  return (
    <>
      {groups
        .filter((group) => group.id.startsWith("plugin:"))
        .map((group) => (
          <section key={group.id} className="space-y-4">
            <SettingsResourceGroupHeader
              count={group.skills.length}
              title={resolvePluginDisplayName(
                {
                  name: group.label,
                  listing:
                    (group.pluginId
                      ? pluginListingById.get(group.pluginId)
                      : undefined) ??
                    resolveUniquePluginListingByName(
                      availablePlugins,
                      group.label,
                    ),
                },
                locale,
              )}
            />
            <SkillList skills={group.skills} renderRow={renderRow} />
          </section>
        ))}
    </>
  );
}
