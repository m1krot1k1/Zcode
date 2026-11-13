import { useEffect, useRef, useState } from "react";
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { resolveSidePaneTabsOverflow } from "@/app-shell/sidePaneLayout.js";
import type { WorkspaceSidePaneTab } from "@/lib/workspaceSidePane.js";

export type TabsScrollMaskEdges = {
  left: boolean;
  right: boolean;
};

const EMPTY_TABS_SCROLL_MASK_EDGES: TabsScrollMaskEdges = {
  left: false,
  right: false,
};

/**
 * tab 条的可视状态：拖拽排序、溢出判定与遮罩、激活 tab 滚回可视区。
 *
 * 这些状态必须由同一个 hook 持有：溢出判定与遮罩共用一次 DOM 读取，
 * 拆开会让 ResizeObserver 在临界宽度反复触发（原实现已在注释里记录该反馈环）。
 */
export function useSidePaneTabStrip({
  visibleTabs,
  visibleActiveTabId,
  onReorderTab,
}: {
  visibleTabs: WorkspaceSidePaneTab[];
  visibleActiveTabId: string;
  onReorderTab: (activeTabId: string, overTabId: string) => void;
}) {
  const tabsScrollViewportRef = useRef<HTMLDivElement | null>(null);
  const tabsScrollContentRef = useRef<HTMLDivElement | null>(null);
  const [isTabsOverflowing, setIsTabsOverflowing] = useState(false);
  const [tabsScrollMaskEdges, setTabsScrollMaskEdges] = useState<TabsScrollMaskEdges>(
    EMPTY_TABS_SCROLL_MASK_EDGES,
  );
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const tabDragSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 4,
      },
    }),
  );

  const handleTabDragStart = (event: DragStartEvent) => {
    setDraggingTabId(String(event.active.id));
  };

  const handleTabDragEnd = (event: DragEndEvent) => {
    setDraggingTabId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    onReorderTab(String(active.id), String(over.id));
  };

  const handleTabDragCancel = () => {
    setDraggingTabId(null);
  };

  useEffect(() => {
    const viewport = tabsScrollViewportRef.current;
    const content = tabsScrollContentRef.current;

    if (!viewport || !content) {
      setIsTabsOverflowing(false);
      // sidePaneState 为空或内容尚未挂载时 refs 会持续为空。
      // 这里不能每次写入新的 mask 对象，否则 effect 会在空 tabs 阶段反复触发更新。
      setTabsScrollMaskEdges((current) =>
        current.left || current.right ? EMPTY_TABS_SCROLL_MASK_EDGES : current,
      );
      return;
    }

    const updateOverflowState = () => {
      const maxScrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
      const addButton = viewport.parentElement?.querySelector<HTMLElement>(
        "[data-side-pane-add-tab-trigger]",
      );
      const addButtonWidth = addButton?.getBoundingClientRect().width ?? 0;
      // 旧判定直接读取 content.scrollWidth，但 overflow 状态本身会把新增按钮
      // 移进/移出 content 并改变 viewport 宽度，临界区会形成 ResizeObserver 反馈环。
      // 这里统一还原“新增按钮位于 tabs 末尾”的假想布局，只用稳定的最小宽度预算判定。
      const isOverflowing = resolveSidePaneTabsOverflow({
        addButtonInside: Boolean(addButton && content.contains(addButton)),
        addButtonWidth,
        tabCount: visibleTabs.length,
        viewportWidth: viewport.clientWidth,
      });
      // 新增按钮在 tabs 尚可等宽收缩时跟随末尾，只有达到 60px 下限仍溢出后才固定到右侧。
      setIsTabsOverflowing(isOverflowing);
      // tabs 溢出时不能两侧一直显示渐变 mask：滚动到起点/终点也像还能继续滚。
      // 这里把 mask 和实际 scrollLeft 绑定，只提示仍可继续滚动的一侧。
      setTabsScrollMaskEdges((current) => {
        const next = {
          left: isOverflowing && viewport.scrollLeft > 1,
          right: isOverflowing && viewport.scrollLeft < maxScrollLeft - 1,
        };

        if (current.left === next.left && current.right === next.right) {
          return current;
        }

        return next;
      });
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateOverflowState;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateOverflowState();
    viewport.addEventListener("scroll", updateOverflowState, {
      passive: true,
    });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateOverflowState);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateOverflowState;
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("scroll", updateOverflowState);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [visibleTabs]);

  useEffect(() => {
    const viewport = tabsScrollViewportRef.current;
    const content = tabsScrollContentRef.current;

    if (!visibleActiveTabId || !viewport || !content) {
      return;
    }

    let frameId: number | null = requestAnimationFrame(() => {
      frameId = null;
      const activeTab = Array.from(
        content.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
      ).find((element) => element.dataset.sidePaneTabId === visibleActiveTabId);

      if (!activeTab) {
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const activeTabRect = activeTab.getBoundingClientRect();
      const leftOverflow = activeTabRect.left - viewportRect.left;
      const rightOverflow = activeTabRect.right - viewportRect.right;

      if (leftOverflow < 0) {
        // 从外部激活 tab（例如打开文件或切回旧 Browser）时，
        // active tab 可能已经被横向滚动区域遮住。这里按真实 DOM 宽度滚回可视区，
        // 避免使用固定宽度估算导致长标题 / favicon tab 对不齐。
        viewport.scrollBy({ left: leftOverflow, behavior: "smooth" });
        return;
      }

      if (rightOverflow > 0) {
        viewport.scrollBy({ left: rightOverflow, behavior: "smooth" });
      }
    });

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [visibleActiveTabId, visibleTabs]);

  const draggingTab = draggingTabId
    ? (visibleTabs.find((tab) => tab.id === draggingTabId) ?? null)
    : null;

  return {
    tabsScrollViewportRef,
    tabsScrollContentRef,
    isTabsOverflowing,
    tabsScrollMaskEdges,
    draggingTab,
    tabDragSensors,
    handleTabDragStart,
    handleTabDragEnd,
    handleTabDragCancel,
  };
}
