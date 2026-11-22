import type { IPlatformService } from "@zcode/shared";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

/** 请求 Browser View 面板导航到指定 URL；由 App 壳层转发给具体 tab。 */
export interface BrowserNavigationRequest {
  id: string;
  targetTabId: string;
  url: string;
}

/** 最近关闭的 side pane tab，用于“重新打开关闭的标签”菜单。 */
export interface RecentClosedSidePaneTab {
  tab: WorkspaceSidePaneTab;
  closedAt: number;
}

export const RECENT_CLOSED_SIDE_PANE_TAB_LIMIT = 8;

/** useAppPanels 需要的平台能力子集；桌面提供完整实现，Web/mobile 可缺省。 */
export type AppPanelsPlatform = Pick<
  IPlatformService,
  | "onOpenBrowserUrl"
  | "onBrowserViewReady"
  | "onBrowserViewOperation"
  | "onBrowserViewVisibility"
  | "onBrowserViewCloseTab"
  | "onBrowserViewSuspend"
  | "onBrowserViewRestore"
  | "browserViewCloseTab"
  | "browserViewEnsureResident"
>;

export interface AppPanelsOptions {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string | null;
  activeTaskId: string | null;
  /** 草稿态与正式任务共用稳定 id，作为侧栏对话隔离边界。 */
  sidePaneOwnerId: string | null;
  isDesktop?: boolean;
  /**
   * 展示语义：视图当前是否呈现给用户（设置页覆盖时为 false）。
   * 本 hook 刻意不消费它——Browser View 事件是 main 侧权威转发，订阅不能受可见性影响，
   * 详见 useAppPanelsOpeners 中订阅 effect 的时序约束注释。
   * 入参保留的唯一理由是回归护栏：useAppPanelsBrowserViewLifecycle 的四条用例靠传 false 表达
   * “设置页覆盖中”，一旦有人把可见性重新写回订阅条件，这些用例会立即失败。删掉入参，
   * 那层保护也就跟着消失了。
   */
  isWorkspaceVisible?: boolean;
  supportsEmbeddedBrowser?: boolean;
  defaultWhiteboardNamePrefix: string;
  platform?: AppPanelsPlatform;
}
