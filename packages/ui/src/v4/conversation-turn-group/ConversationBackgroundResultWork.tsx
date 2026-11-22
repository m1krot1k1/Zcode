import { TID_CHAT_BACKGROUND_RESULT_TITLE, testId } from "@zcode/shared/test-ids";
import type { ApiRetryState, ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";
import { ConversationAssistantWorkItems } from "@/v4/conversation-turn-group/ConversationAssistantWorkItems.js";
import { TurnChatLoadingSlot } from "@/v4/conversation-turn-group/TurnChatLoadingSlot.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTurnRow } from "@/v4/ConversationTurnRow.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import { useAssistantPreviewCardsForAssistantTextRow } from "@/v4/useAssistantPreviewCardsForRow.js";
import { shouldShowTurnChatLoading } from "@/v4/chatLoadingVisibility.js";
import {
  WorkflowNotificationToolRow,
  workflowRowNotification,
  type WorkflowRowNotification,
} from "@/v4/WorkflowNotificationToolRow.js";

/**
 * 能撑起「后台结果头」这套渲染的来源白名单。
 *
 * 这里刻意仍是白名单而不是直接信任 schema：`originMeta` 在 userInputRow 上是 optional，
 * 跨版本仍可能出现第四个取值，而没见过的来源拿不到合适的标题语义，退回普通 assistant
 * 分支比谎报一个标题好。
 *
 * workflow run 的 `backgroundSource` 是 `"workflow"`（CLI 侧
 * `background-tasks.ts` 在 CreateWorkflow 终态上报，title 由 `workflowTaskSubject` 铸造），
 * 原本落在白名单外，于是一条 run 跑完之后那一轮**既没有标题、也退化成按工时折叠的普通
 * assistant 段落**——后台结果分组整个消失。标题不需要本地化：它由 CLI 权威给出，
 * bash / subagent 同样直接透传。
 */
const BACKGROUND_RESULT_TITLE_SOURCES: ReadonlySet<string> = new Set([
  "bash",
  "subagent",
  "workflow",
]);

export function resolveBackgroundResultTitle(unit: ConversationTurnRenderUnit): string | undefined {
  if (unit.header?.origin !== "backgroundResult") return undefined;
  const originMeta = unit.header.originMeta;
  if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
  if (!BACKGROUND_RESULT_TITLE_SOURCES.has(originMeta.backgroundSource)) {
    return undefined;
  }
  return originMeta.title.trim();
}

/**
 * 该轮是否以 workflow 通知卡（ToolLayout 行）开头。
 *
 * 用于两处：`ConversationBackgroundResultWork` 决定渲染通知行还是裸标题行；轮容器决定是否
 * 去掉轮顶 `pt-14`。后台结果轮没有可见的 user 行，通知卡就是轮内第一个节点——若照常保留
 * 轮顶 padding，卡片上方会叠出 56px + 上一轮 pb-5 共约 76px 的空白，用户判为多余。
 */
export function resolveWorkflowNotification(
  unit: ConversationTurnRenderUnit,
): WorkflowRowNotification | undefined {
  if (unit.header?.origin !== "backgroundResult") return undefined;
  return workflowRowNotification(unit.header.originMeta);
}

/** 后台结果轮：标题/通知卡 + history + 最新正文 + following + 加载槽。 */
export function ConversationBackgroundResultWork({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  title,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
}: {
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  title: string;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
}) {
  const hasHistory = unit.assistantHistoryRows.length > 0;
  const hasFollowing = unit.assistantFollowingRows.length > 0;
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    compactForRemoteControl: context.compactForRemoteControl,
    fileChangesTarget: unit.header?.entityId
      ? { rowId: unit.header.rowId, entityId: unit.header.entityId }
      : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  // 后台结果已经由独立唤醒轮总结过；复用普通 assistant 的工时折叠
  // 会显示不准确的分段耗时，并让一段短总结产生没有意义的收起状态。
  //
  // workflow run 的 workflow 通知带结构化载荷时改渲染既有工具卡语法的通知行（替换裸标题行）；
  // 载荷缺席（批量轮、旧 transcript、bash/subagent）→ 原样退回标题行。
  const workflowNotification = resolveWorkflowNotification(unit);
  const workflowRunId = unit.header?.originMeta?.workId;
  // 打开 run 详情：宿主注入 onOpenWorkflowRun + 联查到 toolCallId 才可点；冷恢复查不到时
  // 展开体内不渲染链接。toolCallId 走投影/journal 联查表，与 CreateWorkflow 工具卡同一条打开路径。
  const workflowRunSummary =
    workflowNotification && workflowRunId
      ? context.workflowRunByRunId?.get(workflowRunId)
      : undefined;
  const openWorkflowRun =
    workflowNotification &&
    workflowRunId &&
    context.onOpenWorkflowRun &&
    context.sessionId &&
    workflowRunSummary?.toolCallId
      ? () =>
          context.onOpenWorkflowRun?.({
            parentSessionId: context.sessionId!,
            toolCallId: workflowRunSummary.toolCallId!,
            runId: workflowRunId,
            workflowName: title,
          })
      : undefined;
  const workflowPendingQids =
    workflowNotification && workflowRunId
      ? context.workflowRunPendingQuestionsByRunId?.get(workflowRunId)
      : undefined;
  // 产物 chip → 全尺寸查看 tab。门比 `openWorkflowRun` 松一格：产物 tab 只需要
  // (parentSessionId, runId, artifactId)，**不需要** toolCallId——它不画因果图，也就不必
  // 回到那条 CreateWorkflow 工具行。冷恢复后联查不到 toolCallId 的通知行因此仍能开产物。
  const openWorkflowArtifact =
    workflowNotification && workflowRunId && context.onOpenWorkflowArtifact && context.sessionId
      ? (artifactId: string) => {
          // 载荷里那一枚的 `contentType`（终态通知才有产物清单）：宿主据它决定 html 产物
          // 直接开浏览器 tab 还是开产物 tab，所以这里带得到就带上。载荷刻意不带 `sourcePath`
          // （状态帧体积），宿主缺席时自己查 journal 补。
          const contentType =
            workflowNotification.kind === "terminal"
              ? workflowNotification.artifacts?.find((candidate) => candidate.id === artifactId)
                  ?.contentType
              : undefined;
          context.onOpenWorkflowArtifact?.({
            parentSessionId: context.sessionId!,
            runId: workflowRunId,
            artifactId,
            ...(contentType === undefined ? {} : { contentType }),
          });
        }
      : undefined;

  return (
    <div className="flex flex-col gap-5">
      {workflowNotification ? (
        <WorkflowNotificationToolRow
          notification={workflowNotification}
          runName={title}
          testIdKey={unit.key}
          theme={context.theme}
          onOpenRun={openWorkflowRun}
          onOpenArtifact={openWorkflowArtifact}
          pendingQids={workflowPendingQids}
          // 留白行的三态（docs/dynamic-workflow/transcript-and-notifications.md「The hole row's live state」）：
          // run 在活投影里就递它的留白表（可能为空 = 已补全 / 没记录），不在场即 undefined → 中性词。
          holes={
            workflowRunSummary?.run === undefined ? undefined : (workflowRunSummary.run.holes ?? [])
          }
        />
      ) : (
        <div className="flex w-full border-b border-[var(--color-border)]/50 pb-2">
          <div
            data-testid={testId(TID_CHAT_BACKGROUND_RESULT_TITLE, unit.key)}
            className="min-w-0 whitespace-pre-wrap break-words text-left text-ui-base text-[var(--color-foreground-subtle)]"
          >
            {title}
          </div>
        </div>
      )}
      {hasHistory ? (
        <div className="flex flex-col gap-2">
          <ConversationAssistantWorkItems
            rows={unit.assistantHistoryRows}
            context={context}
            assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          />
        </div>
      ) : null}
      {latestAssistantTextRow ? (
        <ConversationTurnRow
          key={`${latestAssistantTextRow.rowId}:${latestAssistantTextRow.entityId ?? ""}`}
          row={latestAssistantTextRow}
          context={context}
          onFork={latestAssistantTextRow.actions?.canFork === true ? onFork : undefined}
          onRetry={latestAssistantTextRow.actions?.canRetry === true ? onRetry : undefined}
          deferAssistantActions
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      {hasFollowing ? (
        <ConversationAssistantWorkItems
          rows={unit.assistantFollowingRows}
          context={context}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
    </div>
  );
}
