import { LoaderIcon, Pin } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { TaskLeadingIndicator } from "@/task-list-item/viewModel.js";
import type { TaskListItemIntl } from "@/task-list-item/types.js";

/**
 * 左侧 leading 槽：error > unread > spinner 状态、手机远控占位与置顶操作共用同一 16px 槽。
 * 手机激活态让手机图标优先，hover/focus 时再显示 Pin，避免两个图标重叠。
 */
export function TaskListItemLeadingSlot({
  leadingIndicator,
  isMobileActive,
  isPinned,
  intl,
  onTogglePin,
  shouldRenderPinAction,
  variant,
  hasWorkflowRunLines,
  workspaceActionsDisabled,
  workspaceActionsDisabledReason,
}: {
  leadingIndicator: TaskLeadingIndicator;
  isMobileActive: boolean;
  isPinned: boolean;
  intl: TaskListItemIntl;
  onTogglePin: (event: React.MouseEvent) => void;
  shouldRenderPinAction: boolean;
  variant: "default" | "timeline";
  hasWorkflowRunLines: boolean;
  workspaceActionsDisabled: boolean;
  workspaceActionsDisabledReason?: string;
}) {
  const pinActionButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={workspaceActionsDisabled}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onTogglePin}
      className="inline-flex size-4 min-w-0 rounded-sm p-0 text-foreground-subtle !bg-transparent hover:text-foreground"
      aria-label={intl.formatMessage({
        id: isPinned ? "taskList.unpin" : "taskList.pin",
      })}
    >
      <Pin className="size-4" />
    </Button>
  );

  return (
    <div
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center",
        // 行体是纵向列（标题行 + 运行行）时前置槽对齐首行而不是整行：默认 24px 首行居中 = 上留 4px。
        variant === "timeline" ? "mt-0.5" : hasWorkflowRunLines ? "mt-1" : undefined,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 items-center justify-center transition-opacity",
          // SVG 自身旋转会逐帧重算样式；让现有 HTML 槽位合成旋转，保留图标与状态语义。
          leadingIndicator === "loading" && "animate-spin",
          shouldRenderPinAction && "hidden",
          isMobileActive && "invisible",
        )}
      >
        {/* 无状态只保留对齐槽，不显示代表空闲的占位圆点。 */}
        {leadingIndicator === "error" ? (
          <span data-error-indicator="true" className="h-1.5 w-1.5 rounded-full bg-destructive" />
        ) : leadingIndicator === "unread" ? (
          <span data-unread-indicator="true" className="size-[7px] rounded-full bg-icon-blue" />
        ) : leadingIndicator === "loading" ? (
          <LoaderIcon className="size-4 text-foreground-subtle" />
        ) : null}
      </span>
      {shouldRenderPinAction ? (
        <ControlHintTooltip
          title={
            workspaceActionsDisabledReason ??
            intl.formatMessage({
              id: isPinned ? "taskList.unpin" : "taskList.pin",
            })
          }
          side="top"
          align="center"
        >
          {pinActionButton}
        </ControlHintTooltip>
      ) : null}
    </div>
  );
}
