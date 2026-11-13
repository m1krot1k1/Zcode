/**
 * Модель отрисовки таймлайна: header slot, render units, live tail, часы и
 * агрегаты для навигатора. Хук сохраняет прежний порядок мемоизации и
 * эффектов из ConversationTimeline.tsx.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ConversationRow, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import {
  deriveLogicalUiInstances,
  getPluginUiDisclosureVersion,
  getPluginUiManualPin,
  setPluginUiInstanceDerivation,
  subscribePluginUiDisclosure,
  type PluginUiRowPinResolver,
} from "@/plugin-ui/index.js";
import { useBotTopicPreparations } from "@/v4/BotTopicPreparation.js";
import {
  isSameConversationLatestTurnSummary,
  resolveConversationLatestTurnSummary,
  splitConversationTimelineLiveTail,
  type ConversationLatestTurnSummary,
} from "@/v4/conversationTimelineLiveTail.js";
import {
  buildConversationTurnRenderUnits,
  resolveNextHighspeedExpiryMs,
} from "@/v4/conversationTurnRenderUnits.js";
import { withTopicPreparationMessages } from "@/v4/topicPreparationRenderUnits.js";

interface UseTimelineRenderDataOptions {
  rows: readonly ConversationRow[];
  sessionKey: string;
  sessionPhase?: SessionPhase;
  headerSlot?: ReactNode;
  onLatestTurnSummaryChange?: (summary: ConversationLatestTurnSummary) => void;
  centerEmptyStateWithDock?: boolean;
  compactEmptyStateWithDock?: boolean;
}

export function useTimelineRenderData({
  rows,
  sessionKey,
  sessionPhase,
  headerSlot,
  onLatestTurnSummaryChange,
  centerEmptyStateWithDock = false,
  compactEmptyStateWithDock = false,
}: UseTimelineRenderDataOptions) {
  const headerSlotRef = useRef<HTMLDivElement>(null);
  // headerSlot 高度参与虚拟窗口换算（scrollMargin），必须随内容与宽度变化实时跟进，
  // 否则只读块加载完成或窗口变宽换行后，虚拟行会整体错位。
  //
  // 依赖必须是「有没有 slot」而不是 headerSlot 本身：后者是 ReactNode，宿主传的是内联 JSX，
  // 每次渲染都是新对象，会让 ResizeObserver 在流式输出期间每帧重建。
  const hasHeaderSlot = Boolean(headerSlot);
  const [headerSlotHeight, setHeaderSlotHeight] = useState(0);
  useEffect(() => {
    const element = headerSlotRef.current;
    if (!element) {
      setHeaderSlotHeight(0);
      return;
    }
    const sync = () => {
      const next = element.getBoundingClientRect().height;
      setHeaderSlotHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasHeaderSlot]);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  // 插件卡片展示模型——同资源替代 + 最近三回合自动展开 + 手动固定；推导结果发布给卡片自己读。
  const pluginUiDerivation = useMemo(() => deriveLogicalUiInstances(rows), [rows]);
  useEffect(() => {
    setPluginUiInstanceDerivation(sessionKey, pluginUiDerivation);
  }, [pluginUiDerivation, sessionKey]);
  const pluginUiDisclosureVersion = useSyncExternalStore(
    subscribePluginUiDisclosure,
    getPluginUiDisclosureVersion,
    getPluginUiDisclosureVersion,
  );
  const pluginUiPinResolver = useMemo<PluginUiRowPinResolver>(() => {
    // 手动固定 / 收起变化（version 递增）时重建 resolver，折叠边界随之重算。
    void pluginUiDisclosureVersion;
    return (toolCallId) => ({
      disposition: pluginUiDerivation.byToolCallId[toolCallId],
      manualPinned: getPluginUiManualPin(sessionKey, toolCallId),
    });
  }, [pluginUiDerivation, sessionKey, pluginUiDisclosureVersion]);
  const topicPreparations = useBotTopicPreparations();
  const renderUnits = useMemo(
    () =>
      withTopicPreparationMessages(
        buildConversationTurnRenderUnits(rows, {
          nowMs: liveNowMs,
          sessionPhase,
          pluginUiPinResolver,
        }),
        rows,
        topicPreparations,
      ),
    [liveNowMs, pluginUiPinResolver, rows, sessionPhase, topicPreparations],
  );
  const { virtualizedUnits, liveUnit, liveUnitIndex } = useMemo(
    () => splitConversationTimelineLiveTail(renderUnits),
    [renderUnits],
  );
  const hasRunningUnit = useMemo(() => renderUnits.some((unit) => unit.isRunning), [renderUnits]);
  const latestTurnSummary = useMemo(
    () => resolveConversationLatestTurnSummary(renderUnits),
    [renderUnits],
  );
  // 回调随会话 owner 变化；换了回调必须重新上报，不能因值相同而跳过。
  const reportedLatestTurnSummaryRef = useRef<{
    callback: (summary: ConversationLatestTurnSummary) => void;
    summary: ConversationLatestTurnSummary;
  } | null>(null);
  useEffect(() => {
    if (!onLatestTurnSummaryChange) {
      reportedLatestTurnSummaryRef.current = null;
      return;
    }
    const reported = reportedLatestTurnSummaryRef.current;
    if (
      reported?.callback === onLatestTurnSummaryChange &&
      isSameConversationLatestTurnSummary(reported.summary, latestTurnSummary)
    ) {
      return;
    }
    reportedLatestTurnSummaryRef.current = {
      callback: onLatestTurnSummaryChange,
      summary: latestTurnSummary,
    };
    onLatestTurnSummaryChange(latestTurnSummary);
  }, [latestTurnSummary, onLatestTurnSummaryChange]);
  const nextHighspeedExpiryMs = useMemo(
    () => resolveNextHighspeedExpiryMs(rows, liveNowMs),
    [liveNowMs, rows],
  );
  const turnNavigatorQueryRowIds = useMemo(
    () =>
      new Set(
        renderUnits.flatMap((unit) =>
          unit.visibleUserInputs.filter((row) => row.origin === "realUser").map((row) => row.rowId),
        ),
      ),
    [renderUnits],
  );
  const turnNavigatorQueryRowIdsRef = useRef(turnNavigatorQueryRowIds);
  turnNavigatorQueryRowIdsRef.current = turnNavigatorQueryRowIds;
  const centeredEmptyLayout = centerEmptyStateWithDock && renderUnits.length === 0;
  const responsiveCenteredEmptyLayout = centeredEmptyLayout && !compactEmptyStateWithDock;
  // 高频值经 ref 供稳定回调读取（不进依赖数组）。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const unitsRef = useRef(renderUnits);
  unitsRef.current = renderUnits;
  const virtualizedUnitsRef = useRef(virtualizedUnits);
  virtualizedUnitsRef.current = virtualizedUnits;

  return {
    headerSlotRef,
    headerSlotHeight,
    liveNowMs,
    setLiveNowMs,
    hasRunningUnit,
    nextHighspeedExpiryMs,
    renderUnits,
    virtualizedUnits,
    liveUnit,
    liveUnitIndex,
    turnNavigatorQueryRowIds,
    turnNavigatorQueryRowIdsRef,
    centeredEmptyLayout,
    responsiveCenteredEmptyLayout,
    rowsRef,
    unitsRef,
    virtualizedUnitsRef,
  };
}
