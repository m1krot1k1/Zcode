import { SidePaneTabOverview } from "@/app-shell/SidePaneTabOverview.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

/** tab 总览（下拉搜索 / 最近关闭）的文案装配层，保持面板实现只关心布局与状态。 */
export function SidePaneTabsOverviewPane({
  tabs,
  activeTabId,
  recentClosedTabs,
  intl,
  onActivateTab,
  onCloseTab,
  onReopenClosedTab,
}: {
  tabs: WorkspaceSidePaneTab[];
  activeTabId: string;
  recentClosedTabs: RecentClosedSidePaneTab[];
  intl: IntlShape;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReopenClosedTab: (tabId: string) => void;
}) {
  return (
    <SidePaneTabOverview
      tabs={tabs}
      activeTabId={activeTabId}
      recentClosedTabs={recentClosedTabs}
      labels={{
        title: intl.formatMessage({ id: "sidePane.tabOverview" }),
        searchPlaceholder: intl.formatMessage({
          id: "sidePane.searchTabs",
        }),
        openTabs: intl.formatMessage({ id: "sidePane.openTabs" }),
        recentlyClosedTabs: intl.formatMessage({
          id: "sidePane.recentlyClosedTabs",
        }),
        noResults: intl.formatMessage({ id: "sidePane.noTabsFound" }),
        closeTab: (title) => intl.formatMessage({ id: "sidePane.closeTab" }, { title }),
        relativeTime: (timestamp) => formatTaskRelativeTime(timestamp, intl),
        browserTitle: intl.formatMessage({ id: "browser.title" }),
        reviewTitle: intl.formatMessage({ id: "sidePane.review" }),
        fileManagerTitle: intl.formatMessage({ id: "fileManager.title" }),
        codeViewerTitle: intl.formatMessage({ id: "codeViewer.title" }),
        treemappingTitle: intl.formatMessage({ id: "treemapping.title" }),
        whiteboardTitle: intl.formatMessage({ id: "whiteboard.title" }),
        modelTrajectoryTitle: intl.formatMessage({
          id: "modelTrajectory.title",
        }),
        newTabTitle: intl.formatMessage({ id: "sidePane.newTab" }),
        pluginMarketTitle: intl.formatMessage({ id: "workspace.openPluginsSettings" }),
        developerToolsTitle: intl.formatMessage({
          id: "developerTools.title",
        }),
        agentWorkbenchTitle: intl.formatMessage({ id: "agentWorkbench.title" }),
        browserPermissionsTitle: intl.formatMessage({
          id: "browser.permission.settings",
        }),
        terminalTitle: intl.formatMessage({ id: "terminal.title" }),
        subagentTypeLabel: intl.formatMessage({ id: "sidePane.subagent" }),
        subagentDirectoryTitle: intl.formatMessage({
          id: "sidePane.subagentDirectory",
        }),
        selectionChatTitle: intl.formatMessage({
          id: "sidePane.selectionChat",
        }),
        planTitle: intl.formatMessage({ id: "planTool.panel.planTab" }),
        workflowRunTitle: intl.formatMessage({ id: "sidePane.workflowRun" }),
        workflowDirectoryTitle: intl.formatMessage({ id: "sidePane.workflowDirectory" }),
        workflowActorTitle: intl.formatMessage({ id: "sidePane.workflowActor" }),
        workflowScriptTitle: intl.formatMessage({ id: "sidePane.workflowScript" }),
        workflowArtifactTitle: intl.formatMessage({ id: "sidePane.workflowArtifact" }),
      }}
      onActivateTab={onActivateTab}
      onCloseTab={onCloseTab}
      onReopenClosedTab={onReopenClosedTab}
    />
  );
}
