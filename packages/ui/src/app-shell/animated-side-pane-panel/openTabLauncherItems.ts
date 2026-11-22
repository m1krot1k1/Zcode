import {
  BugIcon,
  FileDiffIcon,
  FolderOpenIcon,
  GlobeIcon,
  MessageSquareTextIcon,
  SquareTerminalIcon,
  Workflow as WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
import {
  resolveOpenTabLauncherItemIds,
  type OpenTabLauncherItemId,
} from "@/app-shell/animatedSidePanePanelModel.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];

export type OpenTabLauncherItem = {
  id: OpenTabLauncherItemId;
  label: string;
  description: string;
  icon: LucideIcon;
  onOpen: () => void;
};

/** 内置应用的分组顺序与可用性由 model 决定，这里只负责把 id 映射成可渲染的条目。 */
export function buildOpenTabLauncherItems({
  intl,
  canOpenSelectionSideConversation,
  developerToolsEnabled,
  hasReviewTab,
  isOfficeMode,
  supportsEmbeddedBrowser,
  onOpenSelectionSideConversation,
  onOpenFileManager,
  onOpenReviewTab,
  onOpenTerminalTab,
  onOpenBrowserTab,
  onOpenDeveloperTools,
  onOpenAgentWorkbench,
}: {
  intl: IntlShape;
  canOpenSelectionSideConversation: boolean;
  developerToolsEnabled: boolean;
  hasReviewTab: boolean;
  isOfficeMode: boolean;
  supportsEmbeddedBrowser: boolean;
  onOpenSelectionSideConversation: () => void;
  onOpenFileManager: () => void;
  onOpenReviewTab: () => void;
  onOpenTerminalTab: () => void;
  onOpenBrowserTab: () => void;
  onOpenDeveloperTools: () => void;
  onOpenAgentWorkbench: () => void;
}): OpenTabLauncherItem[] {
  const openTabLauncherItemById: Record<OpenTabLauncherItemId, OpenTabLauncherItem> = {
    "selection-side-conversation": {
      id: "selection-side-conversation",
      label: intl.formatMessage({ id: "sidePane.selectionChat" }),
      description: intl.formatMessage({ id: "sidePane.launcher.selection-side-conversation" }),
      icon: MessageSquareTextIcon,
      onOpen: onOpenSelectionSideConversation,
    },
    files: {
      id: "files",
      label: intl.formatMessage({ id: "fileManager.title" }),
      description: intl.formatMessage({ id: "fileManager.empty" }),
      icon: FolderOpenIcon,
      onOpen: onOpenFileManager,
    },
    review: {
      id: "review",
      label: intl.formatMessage({ id: "sidePane.review" }),
      description: intl.formatMessage({ id: "sidePane.launcher.review" }),
      icon: FileDiffIcon,
      onOpen: onOpenReviewTab,
    },
    terminal: {
      id: "terminal",
      label: intl.formatMessage({ id: "terminal.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.terminal" }),
      icon: SquareTerminalIcon,
      onOpen: onOpenTerminalTab,
    },
    browser: {
      id: "browser",
      label: intl.formatMessage({ id: "browser.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.browser" }),
      icon: GlobeIcon,
      onOpen: onOpenBrowserTab,
    },
    "developer-tools": {
      id: "developer-tools",
      label: intl.formatMessage({ id: "developerTools.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.developer-tools" }),
      icon: BugIcon,
      onOpen: onOpenDeveloperTools,
    },
    "agent-workbench": {
      id: "agent-workbench",
      label: intl.formatMessage({ id: "agentWorkbench.title" }),
      description: intl.formatMessage({ id: "sidePane.launcher.agent-workbench" }),
      icon: WorkflowIcon,
      onOpen: onOpenAgentWorkbench,
    },
  };

  return resolveOpenTabLauncherItemIds({
    canOpenSelectionSideConversation,
    developerToolsEnabled,
    hasReviewTab,
    supportsEmbeddedBrowser,
  })
    .filter((itemId) => !isOfficeMode || (itemId !== "terminal" && itemId !== "review"))
    .map((itemId) => openTabLauncherItemById[itemId]);
}
