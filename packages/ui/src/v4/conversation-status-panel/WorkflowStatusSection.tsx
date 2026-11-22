import { useEffect, useState } from "react";
import { CheckCircle2Icon, SquareIcon, Workflow } from "lucide-react";
import {
  TID_V4_BACKGROUND_WORK_CANCEL,
  TID_V4_BACKGROUND_WORK_ITEM,
  testId,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { WorkflowRunRail } from "@/components/workflow-run-line/WorkflowRunRail.js";
import { foldWorkflowRunRail } from "@/lib/workflowRunLine.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenWorkflowRunDirectorySideTabRequest } from "@/lib/workspaceSidePane.js";
import {
  workflowRunOpenTarget,
  workflowRunWords,
  type ConversationStatusPanelWorkflowRun,
  type ConversationStatusPanelWorkflowRunTarget,
} from "@/v4/conversationStatusPanelModel.js";
import { EndedDirectoryRow } from "@/v4/conversation-status-panel/EndedDirectoryRow.js";
import { StatusSection } from "@/v4/conversation-status-panel/StatusSection.js";
import { WorkflowRunLamp } from "@/v4/conversation-status-panel/WorkflowRunLamp.js";
import {
  formatWorkflowRunElapsed,
  formatWorkflowRunWords,
  workflowRunDisplayName,
} from "@/v4/conversation-status-panel/statusFormat.js";

/**
 * run 行的 Stop（docs/dynamic-workflow/presentation.md「Other places a run appears」）：沿用今天的
 * 幽灵按钮（方块 + 「停止」），但**叠在时长上**——悬停或键盘焦点落进这一行时出现、时长淡出；
 * 平时不占位，整列行因此只剩名字和时长。没有悬停的触屏（`hover: none`）上常驻，换成第三列的 32px
 * 图标按钮。隐藏时同时关掉指针事件：一个看不见却点得中的 Stop 会在用户点时长时停掉 run。
 * 背景用不透明的 menu-hover：它与悬停中的行同色，盖住时长下面可能被截断的名字尾巴。
 */
function WorkflowRunStopButton({
  workId,
  onCancel,
}: {
  workId: string;
  onCancel: (workId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testId(TID_V4_BACKGROUND_WORK_CANCEL, workId)}
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.cancel" })}
      onClick={(event) => {
        event.stopPropagation();
        onCancel(workId);
      }}
      className={cn(
        "pointer-events-none absolute right-1.5 top-1.5 z-[2] h-6 gap-1 bg-menu-hover px-1.5 text-ui-sm text-foreground opacity-0 transition-opacity",
        "hover:bg-[image:linear-gradient(var(--color-hover),var(--color-hover))]",
        "group-hover/wf-run:pointer-events-auto group-hover/wf-run:opacity-100 group-focus-within/wf-run:pointer-events-auto group-focus-within/wf-run:opacity-100",
        "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:static [@media(hover:none)]:size-8 [@media(hover:none)]:bg-transparent [@media(hover:none)]:p-0 [@media(hover:none)]:text-foreground-subtle [@media(hover:none)]:opacity-100",
      )}
    >
      <SquareIcon aria-hidden className="size-2.5 fill-current [@media(hover:none)]:size-3" />
      <span className="[@media(hover:none)]:sr-only">
        {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
      </span>
    </Button>
  );
}

/**
 * 一条 run 两行定高（56px）：第一行 名字 + 时长，第二行 侧栏同款轨道 + 「在做什么」的词。
 * 字段三簇逐簇独立缺席（见 `ConversationStatusPanelWorkflowRun`）：
 * - 无 `status`：偏斜降级行（旧 CLI），只剩第一行——不知道状态就不画灯、不说词；
 * - 无 `startedAt`：没有配对的后台任务，没有时长；pending 也不报时长；
 * - 无 `workId` / 不可取消：没有 Stop，时长常驻。
 * 可见的状态词没了（灯和 phase 已经说了），所以它进打开按钮的无障碍名：名字 · 状态 · 词。
 */
function WorkflowRunRow({
  now,
  onCancelBackgroundWork,
  onOpenWorkflowRun,
  run,
}: {
  now: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  run: ConversationStatusPanelWorkflowRun;
}) {
  const { intl } = useZCodeIntl();
  // 行 → 打开意图的换算与 composer 徽标直达共用（模型层 workflowRunOpenTarget）。
  const openTarget = onOpenWorkflowRun ? workflowRunOpenTarget(run) : null;
  const name = workflowRunDisplayName(run);
  const displayName = name ?? intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const words = workflowRunWords(run);
  const wordsText = words ? formatWorkflowRunWords(words, intl.formatMessage) : null;
  const elapsed =
    run.startedAt === undefined || run.status === "pending"
      ? null
      : formatWorkflowRunElapsed(now - run.startedAt, intl.formatMessage);
  const canStop = Boolean(run.workId && run.cancellable !== false && onCancelBackgroundWork);
  const statusWord = run.status
    ? intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${run.status}` })
    : null;
  const openLabel = [
    intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" }),
    displayName,
    statusWord,
    wordsText === statusWord ? null : wordsText,
  ]
    .filter(Boolean)
    .join(" · ");
  const phases = run.phases ?? [];

  return (
    <li
      data-testid={run.workId ? testId(TID_V4_BACKGROUND_WORK_ITEM, run.workId) : undefined}
      data-background-task-kind="workflow"
      data-workflow-run-id={run.runId}
      data-work-id={run.workId}
      data-work-status={run.status}
      className={cn(
        "group/wf-run relative grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-2 rounded-lg p-2 hover:bg-[var(--color-hover)]",
        canStop && "[@media(hover:none)]:grid-cols-[1rem_minmax(0,1fr)_2rem]",
        openTarget && "cursor-pointer",
      )}
    >
      {openTarget ? (
        // 行里还有 Stop 这个嵌套交互，整行 button 会套出嵌套按钮：透明同级按钮承接「打开详情页」，
        // Stop 保持独立交互层并阻止冒泡（与 Agent 行同款）。
        <button
          type="button"
          data-workflow-run-details-trigger="true"
          data-workflow-run-id={run.runId}
          aria-label={openLabel}
          title={displayName}
          onClick={() => onOpenWorkflowRun?.(openTarget)}
          className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
        />
      ) : null}
      <Workflow className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 self-start text-[var(--color-foreground-subtle)]" />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-col gap-0.5">
        <div
          data-workflow-island-line="name"
          className="flex h-5 min-w-0 items-baseline gap-2 leading-5"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-ui-base",
              name ? "text-[var(--color-foreground)]" : "text-[var(--color-foreground-subtle)]",
            )}
          >
            {displayName}
          </span>
          {elapsed ? (
            <span
              data-workflow-run-elapsed="true"
              className={cn(
                "shrink-0 text-ui-sm tabular-nums text-[var(--color-foreground-subtle)] transition-opacity",
                canStop &&
                  "group-hover/wf-run:opacity-0 [@media(hover:hover)]:group-focus-within/wf-run:opacity-0",
                // 触屏：Stop 占了第三列，时长挪到第二行末尾（没有第二行时留在这里）。
                canStop && wordsText && "[@media(hover:none)]:hidden",
              )}
            >
              {elapsed}
            </span>
          ) : null}
        </div>
        {words && wordsText ? (
          <div
            data-workflow-island-line="phase"
            className="flex h-4.5 min-w-0 items-center gap-1.5 text-ui-sm text-[var(--color-foreground-subtle)]"
          >
            {words.kind === "phases" ? (
              <WorkflowRunRail rail={foldWorkflowRunRail(phases)} intl={intl} />
            ) : (
              <WorkflowRunLamp status={run.status === "pending" ? "pending" : "running"} />
            )}
            <span className="min-w-0 flex-1 truncate">{wordsText}</span>
            {elapsed && canStop ? (
              <span
                aria-hidden="true"
                className="hidden shrink-0 tabular-nums [@media(hover:none)]:inline"
              >
                {elapsed}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {canStop && run.workId && onCancelBackgroundWork ? (
        <WorkflowRunStopButton workId={run.workId} onCancel={onCancelBackgroundWork} />
      ) : null}
    </li>
  );
}

/**
 * Workflows 分区：与 Terminals / Agents 并列的第三类实时活动，**外加**一条通往 run 目录的
 * 页脚行——已结束的 run 折进这条页脚行，不占活动列表的位置。
 *
 * 头部右侧开合一个样：一盏运行灯 + 「{n} 个运行中」。折叠时不再换成「所有 run 里最长的时长」
 * ——那不是任何一条 run 的时间。只有 run 列表滚动（三行半，露出的半行告诉人下面还有）；
 * 已结束入口放在滚动区之外，run 再多也滚不走它。
 *
 * **不排序**：顺序 = 投影 runs 序 = 启动序（模型层已经保证）。Terminals / Agents 按
 * startedAt 排是因为它们的投影无序；这里重排反而会让行在每次投影更新时跳位。
 */
export function WorkflowStatusSection({
  endedRunCount,
  onCancelBackgroundWork,
  onOpenChange,
  onOpenDirectory,
  onOpenWorkflowRun,
  open,
  parentSessionId,
  runs,
  separated,
  title,
}: {
  endedRunCount: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  onOpenDirectory?: (request: OpenWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  open?: boolean;
  parentSessionId?: string;
  runs: readonly ConversationStatusPanelWorkflowRun[];
  separated: boolean;
  title: string;
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  // 只有带 startedAt 的行需要秒级刷新；一行都没有时不必让面板每秒重渲染。
  const tickingRunCount = runs.filter((run) => run.startedAt !== undefined).length;
  useEffect(() => {
    if (tickingRunCount === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [tickingRunCount]);

  // 活动行与已结束计数**都**为零才收起整个分区：只按活动数开门的那一版，重启后一个 run
  // 都不在跑，于是入口连带目录页一起消失——而重启后回看被打断的 run 正是它的主要用途。
  if (runs.length === 0 && endedRunCount <= 0) return null;

  return (
    <StatusSection
      section="workflow"
      // 宿主不接管开合时同一条规则：有活 run 就默认打开（受控时由宿主按同一规则驱动）。
      defaultOpen={runs.length > 0}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={() =>
        runs.length > 0 ? (
          <>
            <WorkflowRunLamp status="running" />
            <span>
              {intl.formatMessage(
                { id: "chat.statusPanel.workflowsLive" },
                { count: String(runs.length) },
              )}
            </span>
          </>
        ) : null
      }
      // 已结束的 run 折进这条页脚行（与 Agents 分区共用同一个 affordance）：终态 run 不占
      // 活动列表的位置，但入口必须留着——被打断的那些正是最需要点进去的。
      footer={
        <EndedDirectoryRow
          count={endedRunCount}
          icon={
            <CheckCircle2Icon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
          }
          label={intl.formatMessage({ id: "chat.statusPanel.endedWorkflows" })}
          separated={runs.length > 0}
          testId="workflow-run-directory-trigger"
          onOpen={
            parentSessionId && onOpenDirectory
              ? () => onOpenDirectory({ parentSessionId })
              : undefined
          }
        />
      }
    >
      <ul className="space-y-0">
        {runs.map((run) => (
          <WorkflowRunRow
            key={run.runId}
            run={run}
            now={now}
            onCancelBackgroundWork={onCancelBackgroundWork}
            onOpenWorkflowRun={onOpenWorkflowRun}
          />
        ))}
      </ul>
    </StatusSection>
  );
}
