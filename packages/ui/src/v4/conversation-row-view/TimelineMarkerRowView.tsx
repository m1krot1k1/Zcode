import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { memo, useMemo } from "react";
import { ArchiveIcon, ArrowRightLeftIcon, GitBranchIcon, GoalIcon } from "lucide-react";
import { TID_V4_ROW, testId } from "@zcode/shared/test-ids";
import type { TimelineMarkerRow } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import { type ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";

/** 分隔线图标（对齐旧版 synthetic-timeline dividers：size-3.5 subtle）。 */
const MARKER_ARCHIVE_ICON = (
  <ArchiveIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_FORK_ICON = (
  <GitBranchIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_GOAL_ICON = (
  <GoalIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_MODEL_ICON = (
  <ArrowRightLeftIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);

/**
 * 系统标记分隔线壳：两侧细横线 + 居中「图标 + 文案」pill，视觉对齐旧版
 * ChatMessage synthetic-timeline dividers（fork / compaction / goal 同款）。
 * running（压缩/校验进行中）隐藏图标、文案走 animated-gradient-text 流光（同旧版）。
 */
function MarkerDividerRow({
  rowId,
  markerType,
  markerStatus,
  markerOrigin,
  markerSourceCommandId,
  icon,
  label,
  running = false,
  onClick,
}: {
  rowId: number;
  markerType: TimelineMarkerRow["marker"]["type"];
  markerStatus: string;
  markerOrigin?: string;
  markerSourceCommandId?: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  running?: boolean;
  /** 传入即整行可点（fork→跳父会话）；不传为静态分隔线。 */
  onClick?: () => void;
}) {
  const clickable = Boolean(onClick);
  const rowClassName =
    "flex w-full items-center gap-3 px-4 py-2 text-ui-base text-[var(--color-foreground-subtle)]";
  const inner = (
    <>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
      <span className="inline-flex min-w-0 shrink items-center justify-center gap-1.5 text-center leading-5">
        {running ? null : icon}
        <span
          className={`min-w-0 break-words${running ? " animated-gradient-text font-medium" : ""}${clickable ? " underline-offset-4 group-hover/marker:underline" : ""}`}
        >
          {label}
        </span>
      </span>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
    </>
  );
  if (onClick) {
    // 整行 <button>（对齐旧版 fork divider）：hover 变亮 + 文案下划线示意可点。
    return (
      <button
        type="button"
        data-row-id={rowId}
        data-row-kind="timelineMarker"
        data-marker-type={markerType}
        data-status={markerStatus}
        data-origin={markerOrigin}
        data-source-command-id={markerSourceCommandId}
        data-testid={testId(TID_V4_ROW, String(rowId))}
        onClick={onClick}
        className={`group/marker ${rowClassName} text-left transition-colors hover:text-[var(--color-foreground)]`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      data-row-id={rowId}
      data-row-kind="timelineMarker"
      data-marker-type={markerType}
      data-status={markerStatus}
      data-origin={markerOrigin}
      data-source-command-id={markerSourceCommandId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={rowClassName}
    >
      {inner}
    </div>
  );
}

/**
 * timelineMarker 行渲染：compact / forkNotice / goalVerify / modelChange 画成分隔线。
 * modelChange 可见化 = 裁决（切换后实际发送出去的轮才落分隔，含
 * model-only 续跑轮）；goalSet/forkCreated 已在投影层停产（隐形行清零），
 * retryNotice·checkpointRestored 无 UI，default 分支兜底不渲染。
 */
export const TimelineMarkerRowView = memo(function TimelineMarkerRowView({
  row,
  context,
}: {
  row: TimelineMarkerRow;
  context: ConversationRowRenderContext;
}) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const marker = row.marker;
  const modelSelectionView = context.modelSelectionView ?? null;
  const view = useMemo((): {
    icon: React.ReactNode;
    label: React.ReactNode;
    running: boolean;
  } | null => {
    switch (marker.type) {
      case "compact": {
        const running = marker.status === "running";
        const automaticOptimization = isOfficeMode && marker.origin === "auto";
        const scope = automaticOptimization ? "chat.contextOptimization" : "chat.contextCompaction";
        const statusMessage =
          marker.status === "running"
            ? "started"
            : marker.status === "noop"
              ? "skipped"
              : marker.status === "cancelled"
                ? "interrupted"
                : marker.status === "failed"
                  ? "failed"
                  : marker.origin === "auto" && !automaticOptimization
                    ? "completedAuto"
                    : "completed";
        return {
          icon: MARKER_ARCHIVE_ICON,
          label: intl.formatMessage({ id: `${scope}.${statusMessage}` }),
          running,
        };
      }
      case "forkNotice":
        return {
          icon: MARKER_FORK_ICON,
          label: intl.formatMessage({ id: "chat.message.fork.derivedFrom" }),
          running: false,
        };
      case "modelChange": {
        // marker 已携带完整 provider/model 元组，旧渲染却只读取 model，
        // 且没有订阅 provider snapshot，导致同名模型无差异、目录水合后名称不刷新。
        // 这里保留 provider ID fallback，并让现有 marker 随目录更新。
        const fromProvider = resolveProviderLabel(marker.fromProvider, modelSelectionView);
        const toProvider = resolveProviderLabel(marker.toProvider, modelSelectionView);
        const to = formatModelChangeLabel(marker.toProvider, toProvider, marker.toModel, intl);
        if (marker.fromProvider === undefined || marker.fromModel === undefined) {
          return {
            // source-less 表示首次使用的模型事实，不是模型切换，因此不显示切换箭头。
            icon: null,
            label: intl.formatMessage({ id: "chat.modelChange.using" }, { model: to }),
            running: false,
          };
        }
        return {
          icon: MARKER_MODEL_ICON,
          label: intl.formatMessage(
            { id: "chat.modelChange.switched" },
            {
              from: formatModelChangeLabel(
                marker.fromProvider,
                fromProvider,
                marker.fromModel,
                intl,
              ),
              to,
            },
          ),
          running: false,
        };
      }
      case "goalVerify": {
        const running = marker.outcome === "running";
        // pass→完成；notSatisfied/failed→未完成（沿用旧版 failed_closed 归「未完成」的处理）。
        const statusId =
          marker.outcome === "running"
            ? "chat.goalVerification.checking"
            : marker.outcome === "pass"
              ? "chat.goalVerification.complete"
              : "chat.goalVerification.incomplete";
        return {
          icon: MARKER_GOAL_ICON,
          running,
          // innerText 形如「第 1 次迭代 · 目标校验中」，对齐 goal-timeline 待命 e2e 断言。
          label: (
            <>
              <span>
                {intl.formatMessage(
                  { id: "chat.summaryPanel.goalIterationValue" },
                  { count: String(marker.iteration) },
                )}
              </span>
              <span aria-hidden="true"> · </span>
              {intl.formatMessage({ id: statusId })}
            </>
          ),
        };
      }
      default:
        return null;
    }
  }, [intl, isOfficeMode, marker, modelSelectionView]);

  // fork 跳父会话（Tier 1）：仅 forkNotice 且宿主提供 onNavigateToRow 时可点，
  // 切到 marker.parentSessionId（rowId 预留 Tier 2 精确滚动，当前恒 0 占位）。
  const onNavigate = context.onNavigateToRow;
  const handleClick = useMemo(() => {
    if (marker.type !== "forkNotice" || !onNavigate) {
      return undefined;
    }
    return () => onNavigate(marker.parentSessionId, marker.parentRowId);
  }, [marker, onNavigate]);

  if (!view) {
    return null;
  }
  return (
    <MarkerDividerRow
      rowId={row.rowId}
      markerType={marker.type}
      markerStatus={
        marker.type === "compact"
          ? marker.status
          : marker.type === "goalVerify"
            ? marker.outcome
            : marker.type === "forkNotice"
              ? "created"
              : "applied"
      }
      markerOrigin={marker.type === "compact" ? marker.origin : undefined}
      markerSourceCommandId={row.sourceCommandId}
      icon={view.icon}
      label={view.label}
      running={view.running}
      onClick={handleClick}
    />
  );
});
