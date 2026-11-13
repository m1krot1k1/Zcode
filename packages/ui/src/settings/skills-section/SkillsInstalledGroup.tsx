/** 已安装技能分组：标题操作、列表与空状态入口。 */
import { Import, Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginInstallEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { SettingsResourceGroupHeader } from "@/settings/SettingsResourceGroup.js";
import { SkillList } from "@/settings/skills-section/SkillList.js";
import type { SkillsInstalledGroupProps } from "@/settings/skills-section/types.js";

export function SkillsInstalledGroup({
  skills,
  hidden,
  showEmptyState,
  count,
  headerActions,
  canImport,
  renderRow,
  onCreateSkill,
  onImport,
  onOpenPluginStore,
}: SkillsInstalledGroupProps) {
  const { intl } = useZCodeIntl();
  return (
    <section className={hidden ? "hidden" : "space-y-4"}>
      <div data-skills-plugin-direct-actions="true">
        <SettingsResourceGroupHeader
          actions={headerActions}
          count={count}
          title={intl.formatMessage({
            id: "settings.plugin.skills.installed",
          })}
        />
      </div>
      {skills.length > 0 ? (
        <SkillList skills={skills} renderRow={renderRow} />
      ) : showEmptyState ? (
        <PluginInstallEmptyState
          title={intl.formatMessage({
            id: "settings.plugin.skills.emptyInstalledTitle",
          })}
          description={intl.formatMessage({
            id: "settings.plugin.skills.emptyInstalledDescription",
          })}
          actions={
            <>
              <Button
                type="button"
                variant="default"
                size="lg"
                onClick={onCreateSkill}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                {intl.formatMessage({
                  id: "settings.plugin.skills.newSkill",
                })}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={!canImport}
                onClick={onImport}
              >
                <Import data-icon="inline-start" aria-hidden="true" />
                {intl.formatMessage({
                  id: "settings.skills.import.action",
                })}
              </Button>
              {onOpenPluginStore ? (
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  onClick={onOpenPluginStore}
                  data-testid="skills-open-marketplace"
                >
                  {intl.formatMessage({ id: "settings.plugin.skills.browse" })}
                </Button>
              ) : null}
            </>
          }
        />
      ) : null}
    </section>
  );
}
