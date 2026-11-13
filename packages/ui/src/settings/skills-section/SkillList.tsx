/** 技能分组列表容器：统一 key 与分隔线，行内容由调用方提供。 */
import { SettingsResourceList } from "@/settings/SettingsResourceGroup.js";
import type { SkillListProps } from "@/settings/skills-section/types.js";

export function SkillList({ skills, renderRow }: SkillListProps) {
  return (
    <SettingsResourceList
      items={skills}
      getKey={(skill) => skill.id}
      renderItem={renderRow}
    />
  );
}
