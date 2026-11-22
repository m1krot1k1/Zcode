import type { CSSProperties, ReactNode, RefObject } from "react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  type useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { cn } from "@/components/lib/utils.js";
import { TabsList } from "@/components/ui/tabs.js";
import { SidePaneFullViewConversationTab } from "@/side-pane-full-view/index.js";
import {
  getSidePaneTabTitle,
  SidePaneTabDragOverlay,
  SortableSidePaneTabTrigger,
} from "@/app-shell/SidePaneTabTrigger.js";
import type { TabsScrollMaskEdges } from "@/app-shell/animated-side-pane-panel/useSidePaneTabStrip.js";
import type { AnimatedSidePanePanelProps } from "@/app-shell/animated-side-pane-panel/types.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

type IntlShape = ReturnType<typeof useZCodeIntl>["intl"];
type TabDragSensors = ReturnType<typeof useSensors>;
type FullView = NonNullable<AnimatedSidePanePanelProps["fullView"]>;

/**
 * 面板顶部 tab 条：总览、完整视图的对话 tab、可拖拽排序的 tab 列表与右侧操作区。
 * 拖拽状态由 useSidePaneTabStrip 持有，本组件只做渲染与事件转发。
 */
export function SidePaneTabsBar({
  tabs,
  contentActiveTabId,
  intl,
  overview,
  addTabButton,
  closeSidePaneButton,
  isTabsOverflowing,
  tabsScrollMaskEdges,
  tabsScrollViewportRef,
  tabsScrollContentRef,
  draggingTab,
  tabDragSensors,
  onTabDragStart,
  onTabDragEnd,
  onTabDragCancel,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  fullView,
  mobileOverlay,
  captionControlsStyle,
  isDesktop,
}: {
  tabs: WorkspaceSidePaneTab[];
  contentActiveTabId: string;
  intl: IntlShape;
  overview: ReactNode;
  addTabButton: ReactNode;
  closeSidePaneButton: ReactNode;
  isTabsOverflowing: boolean;
  tabsScrollMaskEdges: TabsScrollMaskEdges;
  tabsScrollViewportRef: RefObject<HTMLDivElement | null>;
  tabsScrollContentRef: RefObject<HTMLDivElement | null>;
  draggingTab: WorkspaceSidePaneTab | null;
  tabDragSensors: TabDragSensors;
  onTabDragStart: (event: DragStartEvent) => void;
  onTabDragEnd: (event: DragEndEvent) => void;
  onTabDragCancel: () => void;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseAllTabs: () => void;
  fullView: FullView | null | undefined;
  mobileOverlay: boolean;
  captionControlsStyle?: CSSProperties;
  isDesktop?: boolean;
}) {
  return (
    <TabsList
      style={mobileOverlay ? undefined : captionControlsStyle}
      className={cn(
        "flex justify-start w-full rounded-none p-0 border-0 border-b border-border/50 bg-transparent shadow-none !h-12 overflow-hidden",
        fullView?.leadingInsetClassName,
        // 独立面板将标签栏移至窗口顶部，需补充窗口拖拽区域；标签和按钮仍处理自身交互。
        isDesktop &&
          !mobileOverlay &&
          "[app-region:drag] [&_button]:[app-region:no-drag] [&_[data-side-pane-tab-id]]:[app-region:no-drag]",
      )}
    >
      <div className="flex items-center justify-start flex-1 min-w-0">
        {/* 与 WorkspaceHeader 的 p-2 对齐，避免切换面板后左右操作区跳动。 */}
        <div className="flex h-full shrink-0 items-center p-2">{overview}</div>
        {fullView ? (
          <div className="flex h-full shrink-0 items-center pr-1">
            <SidePaneFullViewConversationTab
              title={fullView.conversationTitle}
              isActive={fullView.surface === "conversation"}
            />
          </div>
        ) : null}
        <DndContext
          sensors={tabDragSensors}
          collisionDetection={closestCenter}
          onDragStart={onTabDragStart}
          onDragEnd={onTabDragEnd}
          onDragCancel={onTabDragCancel}
        >
          <div
            ref={tabsScrollViewportRef}
            data-side-pane-tabs-viewport=""
            className={cn(
              "min-w-0 flex-1 overflow-x-auto !scrollbar-hide h-12 items-center",
              tabsScrollMaskEdges.left &&
                tabsScrollMaskEdges.right &&
                "[mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_calc(100%-16px),transparent_100%)]",
              tabsScrollMaskEdges.left &&
                !tabsScrollMaskEdges.right &&
                "[mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0%,black_16px,black_100%)]",
              !tabsScrollMaskEdges.left &&
                tabsScrollMaskEdges.right &&
                "[mask-image:linear-gradient(to_right,black_0%,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0%,black_calc(100%-16px),transparent_100%)]",
            )}
          >
            {/* tab strip 固定占满滚动 viewport：每个 tab 先从 156px 等宽收缩到
                60px，只有最小宽度之和仍超出 viewport 时才产生横向滚动。 */}
            <div
              ref={tabsScrollContentRef}
              data-side-pane-tabs-content=""
              className="flex w-full gap-1 py-2.5"
            >
              <SortableContext
                items={tabs.map((tab) => tab.id)}
                strategy={horizontalListSortingStrategy}
              >
                {tabs.map((tab) => {
                  const title = getSidePaneTabTitle(tab, intl.formatMessage);
                  return (
                    <SortableSidePaneTabTrigger
                      key={tab.id}
                      tab={tab}
                      title={title}
                      closeTabLabel={intl.formatMessage({ id: "sidePane.closeTab" }, { title })}
                      closeTabMenuLabel={intl.formatMessage({
                        id: "sidePane.closeCurrentTab",
                      })}
                      closeOtherTabsLabel={intl.formatMessage({
                        id: "sidePane.closeOtherTabs",
                      })}
                      closeAllTabsLabel={intl.formatMessage({
                        id: "sidePane.closeAllTabs",
                      })}
                      diffBadgeLabel={intl.formatMessage({
                        id: "diff.title",
                      })}
                      isActive={tab.id === contentActiveTabId}
                      onActivateTab={onActivateTab}
                      onCloseTab={onCloseTab}
                      onCloseOtherTabs={onCloseOtherTabs}
                      onCloseAllTabs={onCloseAllTabs}
                      canCloseOtherTabs={tabs.length > 1}
                    />
                  );
                })}
              </SortableContext>
              {!isTabsOverflowing ? addTabButton : null}
            </div>
          </div>
          <DragOverlay dropAnimation={null}>
            {draggingTab ? (
              <SidePaneTabDragOverlay
                tab={draggingTab}
                title={getSidePaneTabTitle(draggingTab, intl.formatMessage)}
                diffBadgeLabel={intl.formatMessage({
                  id: "diff.title",
                })}
              />
            ) : null}
          </DragOverlay>
        </DndContext>

        <div className="ml-auto flex h-full shrink-0 items-center gap-1 px-2">
          {isTabsOverflowing ? addTabButton : null}
          {closeSidePaneButton}
        </div>
      </div>
    </TabsList>
  );
}
