import { Clock, Moon, Smartphone } from "lucide-react";
import type { ZCodeTaskChangeSummary, ZCodeTaskMeta } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import type { TaskListItemIntl } from "@/task-list-item/types.js";

/**
 * 默认列表行与 timeline 行共用的行内节点。
 * 这些节点在两个布局里的语义完全一致，只有外层排版位置不同，因此集中在一处维护。
 */

export function TaskRowTitle({
  taskTitle,
  taskTitleWithChanges,
}: {
  taskTitle: string;
  taskTitleWithChanges: string;
}) {
  return (
    <TaskTitleOverflowText className="text-ui-base text-foreground" title={taskTitleWithChanges}>
      {/* Bugfix: task 标题之前使用 truncate，会在长标题末尾显示省略号；
              这里统一改为右侧渐隐，避免同一侧栏里出现两种截断语义。 */}
      {taskTitle}
    </TaskTitleOverflowText>
  );
}

/**
 * 手机远控标记固定绝对定位回原有 leading 槽，
 * 避免插入标题前 flex 流把当前行标题往右挤、造成上下 task 标题不对齐。
 */
export function TaskMobileActiveIndicator({
  intl,
  triggerClassName,
}: {
  intl: TaskListItemIntl;
  triggerClassName: string;
}) {
  return (
    <ControlHintTooltip
      title={intl.formatMessage({ id: "taskList.mobileActive" })}
      side="right"
      align="center"
      triggerClassName={triggerClassName}
    >
      <span
        data-mobile-active-task="true"
        className="inline-flex size-4 items-center justify-center rounded-sm text-success"
        aria-label={intl.formatMessage({
          id: "taskList.mobileActive",
        })}
      >
        {/* Bugfix: mobileViewState 已经能告诉桌面端手机正在看的 task，
            但列表未消费这个状态，用户会误以为只有桌面端在操作。上一版把图标作为标题前的 flex 子项，
            会把当前行标题往右挤，造成上下 task 标题不对齐；这里改成绝对定位到原有 leading 槽，
            标题文本仍然从原来的位置开始；同时 hover 时隐藏手机标记，把原来的置顶按钮还给用户。 */}
        <Smartphone className="size-3.5" />
      </span>
    </ControlHintTooltip>
  );
}

const ATTENTION_BADGE_CLASS_NAME = {
  base: "h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18",
  sm: "h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-sm font-medium text-success dark:bg-success/18",
} as const;

/**
 * 交互胶囊优先于 attention 计数：胶囊已占用右侧状态位，
 * 继续并排展示计数会和“等待确认”互相挤压。
 */
export function TaskAttentionTag({
  task,
  intl,
  taskAttentionDisplay,
  onSnoozeCountdown,
  size,
}: {
  task: ZCodeTaskMeta;
  intl: TaskListItemIntl;
  taskAttentionDisplay: string | null;
  onSnoozeCountdown?: (interactionId: string) => boolean | Promise<boolean>;
  size: "base" | "sm";
}) {
  if (task.pendingInteraction) {
    return (
      <TaskInteractionBadge
        interaction={task.pendingInteraction}
        formatMessage={(id) => intl.formatMessage({ id })}
        onSnoozeCountdown={onSnoozeCountdown}
      />
    );
  }
  if (!taskAttentionDisplay) {
    return null;
  }
  return <Badge className={ATTENTION_BADGE_CLASS_NAME[size]}>{taskAttentionDisplay}</Badge>;
}

/**
 * 定时任务 / off-peak 图标归属时间元信息，而不是左侧状态位；
 * 否则 unread/loading 会把图标顶掉。
 */
export function TaskScheduleIcons({
  isTaskCron,
  isTaskOffPeak,
  intl,
}: {
  isTaskCron: boolean;
  isTaskOffPeak: boolean;
  intl: TaskListItemIntl;
}) {
  if (isTaskCron) {
    return (
      <Clock
        data-cron-task-icon="true"
        aria-label={intl.formatMessage({
          id: "taskList.cronTaskLabel",
        })}
        className="size-3.5 shrink-0"
      />
    );
  }
  if (isTaskOffPeak) {
    return (
      <Moon
        data-off-peak-task-icon="true"
        aria-label={intl.formatMessage({
          id: "taskList.offPeakTaskLabel",
        })}
        className="size-3.5 shrink-0"
      />
    );
  }
  return null;
}

export function TaskChangeSummaryText({ summary }: { summary: ZCodeTaskChangeSummary }) {
  return (
    <span className="shrink-0 text-ui-base">
      {summary.added > 0 ? <span className="text-diff-added">+{summary.added}</span> : null}
      {summary.removed > 0 ? (
        <span className="ml-1 text-diff-removed">-{summary.removed}</span>
      ) : null}
    </span>
  );
}

/** 远程断连投影在两个布局里一致；工作流多行布局不改变连接状态语义。 */
export function TaskRemoteConnectionBadge({
  visible,
  intl,
}: {
  visible: boolean;
  intl: TaskListItemIntl;
}) {
  if (!visible) {
    return null;
  }
  return (
    <Badge
      data-remote-connection-overlay="true"
      className="h-5 shrink-0 border-transparent bg-warning-surface px-2 text-ui-xs font-medium text-warning-surface-foreground"
    >
      {intl.formatMessage({ id: "taskList.remoteConnectionUnknown" })}
    </Badge>
  );
}
