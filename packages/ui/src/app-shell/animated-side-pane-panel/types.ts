import type { CSSProperties, RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { IServiceAccessor } from "@zcode/services";
import type { BrowserViewScreenshotSurfacePreparePayload, GitChangeSourceId } from "@zcode/shared";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { BrowserNavigationRequest, RecentClosedSidePaneTab } from "@/hooks/useAppPanels.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type {
  BrowserSidePaneMetadata,
  FileManagerTarget,
  OpenBackgroundBashSideTabRequest,
  OpenScopedSubagentSideTabRequest,
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  WorkspaceSidePaneState,
} from "@/lib/workspaceSidePane.js";
import type { SidePaneFullViewSurface } from "@/side-pane-full-view/index.js";

/**
 * 面板公开 props。类型下沉到子模块，让 tab 栏 / 内容区分支按 `Pick` 复用同一份契约，
 * 同时避免子组件反向从面板实现导入类型（否则会形成模块环）。
 */
export type AnimatedSidePanePanelProps = {
  services: IServiceAccessor;
  frameClassName?: string;
  captionControlsStyle?: CSSProperties;
  showWindowControls?: boolean;
  onCloseSidePane?: () => void;
  toggleSidePaneShortcutLabel?: string;
  /** 桌面端「进入 / 退出完整视图」按钮；缺省不渲染（Web、手机远控）。 */
  fullViewToggle?: { active: boolean; onToggle: () => void; shortcutLabel?: string };
  /** 完整视图生效时的 tab 栏状态（spec：docs/ui/side-pane-full-view.md）。 */
  fullView?: {
    surface: SidePaneFullViewSurface;
    conversationTitle: string;
    /** 侧栏收起时为左上角浮层按钮组留出的左侧留白（与 WorkspaceHeader 同一规则）。 */
    leadingInsetClassName?: string | false;
    onSelectSurface: (surface: SidePaneFullViewSurface) => void;
  } | null;
  /** 面板内容区（tab 栏下方），完整视图的对话宿主按它定位。 */
  fullViewSlotRef?: (element: HTMLDivElement | null) => void;
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  isVisible: boolean;
  sidePaneState: WorkspaceSidePaneState | null;
  recentClosedSidePaneTabs: RecentClosedSidePaneTab[];
  isBrowserOpen: boolean;
  supportsEmbeddedBrowser?: boolean;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeTaskId: string | null;
  sidePaneOwnerId: string | null;
  gitState: ReturnType<typeof import("@/hooks/useGitRepository.js").useGitRepository>;
  activeGitSourceId: GitChangeSourceId;
  panelRef: RefObject<PanelImperativeHandle | null>;
  panelElementRef: RefObject<HTMLDivElement | null>;
  browserNavigationRequest: BrowserNavigationRequest | null;
  browserRestoreUrls: Record<string, string>;
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
  screenshotSurfaceTabId?: string | null;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  onCloseCodeViewer: () => void;
  onCloseGit: () => void;
  onActivateTab: (tabId: string) => void;
  onOpenNewTab: () => void;
  /** "插件"分组打开面板 tab；缺省不渲染分组（web / 无宿主）。 */
  onReorderTab: (activeTabId: string, overTabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  onReopenClosedTab: (tabId: string) => void;
  onOpenBrowserTab: () => void;
  onOpenBrowserPermissionSettings?: (origin: string) => void;
  onOpenWhiteboard: () => void;
  onOpenDeveloperTools: () => void;
  onOpenAgentWorkbench: () => void;
  onOpenFileManager: (target?: FileManagerTarget) => void;
  onNavigateFileManager: (tabId: string, source: CodeViewerSource) => void;
  onOpenPluginMarket?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenTerminalTab: () => void;
  onOpenReviewTab: () => void;
  onOpenSelectionSideConversation: () => void;
  onRevealGitFileInTree?: (path: string) => void;
  onOpenBrowserUrl: (url: string) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBackgroundBash?: (request: OpenBackgroundBashSideTabRequest) => void;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
  /** run 详情页里点 ask 节点 → 打开那个 actor 实例的 transcript tab。 */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** run 详情页里点脚本行 → 打开该 run 的脚本 transcript tab，落到那一站。 */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
  /** run 详情页里点一张产物卡 → 打开那个产物的全尺寸查看 tab。 */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** run 目录页里点一行 → 打开那个 run 的详情页 tab（目录 → 详情是这一页存在的理由）。 */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  onRefreshGit: () => void;
  onBrowserNavigationRequestHandled: (requestId: string) => void;
  onBrowserUrlChange: (tabId: string, url: string) => void;
  onBrowserPageMetadataChange: (tabId: string, metadata: BrowserSidePaneMetadata) => void;
  onSelectGitSource: (value: GitChangeSourceId) => void;
  mobileOverlay?: boolean;
  mobileStacked?: boolean;
};
