/**
 * PluginsSection 顶部工具条：Scope 选择、能力标签页与搜索框。
 *
 * 从原 PluginsSection 内联 JSX 提取；mode 决定显示可切换 tabs 还是单一能力标题。
 */
import { TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import {
  getPluginTabCountClass,
  type PluginTab,
  type PluginTabTarget,
  type PluginsSectionProps,
} from "@/settings/plugins-section/pluginsSectionTypes.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";

const CAPABILITY_TAB_LABELS: Record<PluginTabTarget, string> = {
  plugins: "settings.plugin.tab.plugins",
  mcps: "settings.plugin.tab.mcps",
  skills: "settings.plugin.tab.skills",
  commands: "settings.plugin.tab.commands",
};

const CAPABILITY_SEARCH_PLACEHOLDERS: Record<PluginTabTarget, string> = {
  plugins: "settings.plugin.plugins.searchPlaceholder",
  mcps: "settings.mcp.searchPlaceholder",
  skills: "settings.skills.searchPlaceholder",
  commands: "settings.commands.searchPlaceholder",
};

const FIXED_MODE_TAB: Record<
  Exclude<NonNullable<PluginsSectionProps["mode"]>, "plugin">,
  PluginTabTarget
> = {
  market: "plugins",
  mcp: "mcps",
  skill: "skills",
  command: "commands",
};

function PluginTabTrigger({
  value,
  count,
  selectedTab,
}: {
  value: PluginTab;
  count: number;
  selectedTab: PluginTabTarget;
}) {
  const { intl } = useZCodeIntl();
  return (
    <TabsTrigger
      value={value}
      className="h-7 flex-none rounded-full px-3 hover:bg-hover data-active:!bg-selected data-active:hover:!bg-hover after:hidden"
    >
      {intl.formatMessage({
        id: CAPABILITY_TAB_LABELS[value],
      })}
      <span className={getPluginTabCountClass(value, selectedTab)}>{count}</span>
    </TabsTrigger>
  );
}

export function PluginsSectionToolbar({
  mode,
  selectedTab,
  capabilityCounts,
  selectedScopeKey,
  workspaceTabs,
  userScopeTarget,
  settingsSourceServerId,
  activeSearchQuery,
  onScopeKeyChange,
  onSearchQueryChange,
  onSearchClear,
}: {
  mode: NonNullable<PluginsSectionProps["mode"]>;
  selectedTab: PluginTabTarget;
  capabilityCounts: Record<PluginTabTarget, number>;
  selectedScopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  userScopeTarget: ConfigWorkspaceTarget | null;
  settingsSourceServerId?: string | null;
  activeSearchQuery: string;
  onScopeKeyChange: (scopeKey: string) => void;
  onSearchQueryChange: (value: string) => void;
  onSearchClear: () => void;
}) {
  const { intl } = useZCodeIntl();
  const fixedModeTab = mode === "plugin" ? null : FIXED_MODE_TAB[mode];
  const fixedModeCapabilityTab = fixedModeTab ?? "plugins";

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <PluginScopeMenu
          userTarget={userScopeTarget}
          userSourceServerId={settingsSourceServerId}
          align="start"
          selectedScopeKey={selectedScopeKey}
          triggerTestId="plugin-settings-scope-trigger"
          userOptionTestId="plugin-settings-scope-user-option"
          workspaceOptionTestIdPrefix="plugin-settings-scope-option"
          workspaceTabs={workspaceTabs}
          onScopeKeyChange={onScopeKeyChange}
        />
        <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
        {mode === "plugin" ? (
          <TabsList variant="line" className="h-7 max-w-full gap-1 overflow-x-auto p-0">
            <PluginTabTrigger
              value="plugins"
              count={capabilityCounts.plugins}
              selectedTab={selectedTab}
            />
            <PluginTabTrigger
              value="mcps"
              count={capabilityCounts.mcps}
              selectedTab={selectedTab}
            />
            <PluginTabTrigger
              value="skills"
              count={capabilityCounts.skills}
              selectedTab={selectedTab}
            />
          </TabsList>
        ) : (
          <div
            data-independent-capability-count="true"
            className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
          >
            <span>
              {intl.formatMessage({
                id: CAPABILITY_TAB_LABELS[fixedModeCapabilityTab],
              })}
            </span>
            <span className="text-ui-sm text-foreground-subtle">
              {capabilityCounts[fixedModeCapabilityTab]}
            </span>
          </div>
        )}
      </div>
      <SettingsSearchInput
        data-testid="plugin-settings-search"
        containerClassName="w-full sm:ml-auto sm:w-64"
        clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
        value={activeSearchQuery}
        onClear={onSearchClear}
        onChange={(event) => onSearchQueryChange(event.target.value)}
        placeholder={intl.formatMessage({
          id: CAPABILITY_SEARCH_PLACEHOLDERS[selectedTab],
        })}
      />
    </div>
  );
}
