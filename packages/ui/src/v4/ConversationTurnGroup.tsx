import { BotTopicPreparation } from "@/v4/BotTopicPreparation.js";
import { ConnectedBotGroupDeliveryAction } from "@/v4/BotGroupDeliveryAction.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { memo, useMemo, useState, useSyncExternalStore } from "react";
import { cn } from "@/components/lib/utils.js";
import { MessageActions } from "@/components/ai-elements/message.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { HighspeedShareDialog } from "@/highspeed/HighspeedShareNoticeCard.js";
import { isHighspeedShareEligible } from "@/highspeed/highspeedShare.js";
import {
  aggregateHighspeedCardMetrics,
  getHighspeedTurnByCommandId,
  getHighspeedTurnVersion,
  subscribeHighspeedTurns,
  type HighspeedShareMetrics,
} from "@/highspeed/highspeedTurnStore.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
} from "@/lib/assistantCodeComment.js";
import {
  ConversationBackgroundResultWork,
  resolveBackgroundResultTitle,
  resolveWorkflowNotification,
} from "@/v4/conversation-turn-group/ConversationBackgroundResultWork.js";
import { ConversationAssistantWorkItems } from "@/v4/conversation-turn-group/ConversationAssistantWorkItems.js";
import { ConversationTurnFlow } from "@/v4/conversation-turn-group/ConversationTurnFlow.js";
import { HighspeedOutputFooter } from "@/v4/conversation-turn-group/HighspeedOutputFooter.js";
import {
  CronAutomationTurnCards,
  OffPeakTurnCards,
  resolveCronAutomationTurnCards,
  resolveOffPeakTurnCards,
} from "@/v4/conversation-turn-group/turnResultCards.js";
import type { ConversationTurnGroupProps } from "@/v4/conversation-turn-group/types.js";
import { ConversationFileSummaryPanel } from "@/v4/ConversationFileSummaryPanel.js";
import { ConversationWorkflowDigests } from "@/v4/ConversationWorkflowDigests.js";
import { ConversationWorkflowCompletion } from "@/v4/ConversationWorkflowCompletion.js";
import { resolveWorkflowTurnDigests } from "@/v4/workflowTurnDigests.js";
import { resolveWorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";
import {
  ConversationAssistantTextActions,
  readAssistantFeedback,
  type EditWorkspaceRewindAvailability,
} from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { ConversationTurnRow, resolveAssistantCopyText } from "@/v4/ConversationTurnRow.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";

function ConversationTurnGroupImpl({
  unit,
  nowMs = Date.now(),
  apiRetry = null,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
}: ConversationTurnGroupProps) {
  const isOfficeMode = useIsOfficeMode();
  const { intl } = useZCodeIntl();
  const visibleUserRows = useMemo(() => unit.visibleUserInputs, [unit.visibleUserInputs]);
  useSyncExternalStore(subscribeHighspeedTurns, getHighspeedTurnVersion, getHighspeedTurnVersion);
  const sourceCommandId = unit.header?.sourceCommandId ?? visibleUserRows[0]?.sourceCommandId;
  const highspeedTurn = getHighspeedTurnByCommandId(sourceCommandId);
  // Bug 根因：历史标识过去只依赖 Renderer 内存；卡过期或冷恢复后记录不可用，
  // 即使 transcript 已持久化 highspeed metadata，也会把 accelerated output 渲染成普通工时。
  const isHighspeed = highspeedTurn !== null || visibleUserRows.some((row) => row.highspeed);
  const highspeedExpiresAt = Math.max(
    highspeedTurn?.card.expiresAt ?? Number.NEGATIVE_INFINITY,
    ...visibleUserRows.flatMap((row) => (row.highspeed ? [row.highspeed.expiresAt] : [])),
  );
  // Bug 根因：紫色流光过去只看“本轮曾使用 Highspeed”，卡过期后 metadata 仍会保留，
  // 导致 fallback 阶段仍在执行的 Tool 被永久染成紫色。运行态样式必须同时服从卡片有效期。
  const showHighspeedAnimatedGradient = isHighspeed && unit.isRunning && highspeedExpiresAt > nowMs;
  // 完成态统计即使因 replayable 事件先到，也必须等整轮停止生成后才能进入 UI。
  const highspeedMeta = unit.isRunning
    ? undefined
    : visibleUserRows.find((row) => row.highspeed)?.highspeed;
  const highspeedShareTarget = useMemo(() => {
    let target: { cardId: string; metrics: HighspeedShareMetrics } | null = null;
    if (
      highspeedTurn?.metrics &&
      highspeedTurn.metricsPersistedAt !== undefined &&
      highspeedTurn.metrics.regularTps > 0 &&
      highspeedTurn.metrics.highspeedTps !== undefined &&
      highspeedTurn.metrics.highspeedTps > 0
    ) {
      target = {
        cardId: highspeedTurn.card.cardId,
        metrics: aggregateHighspeedCardMetrics(highspeedTurn.card.cardId),
      };
    } else if (unit.highspeedOutputFooterTarget) {
      target = unit.highspeedOutputFooterTarget;
    } else if (
      highspeedMeta?.outputTokens !== undefined &&
      highspeedMeta.outputTokens > 0 &&
      highspeedMeta.highspeedTps !== undefined &&
      highspeedMeta.highspeedTps > 0 &&
      highspeedMeta.regularTps !== undefined &&
      highspeedMeta.regularTps > 0
    ) {
      // Bug 原因：冷恢复后 Renderer 内存记录为空，但 transcript 已持久化完整分享统计；
      // 只依赖 highspeedTurn 会让可见的历史分享按钮永久 disabled。
      target = {
        cardId: highspeedMeta.cardId,
        metrics: {
          outputTokens: highspeedMeta.outputTokens,
          // 分享接口不要求 durationMs；缺失时仅让本地耗时降级为 0，不阻塞分享。
          durationMs: highspeedMeta.durationMs ?? 0,
          regularTps: highspeedMeta.regularTps,
          highspeedTps: highspeedMeta.highspeedTps,
          ...(highspeedMeta.savedDurationMs !== undefined
            ? { savedDurationMs: highspeedMeta.savedDurationMs }
            : {}),
        },
      };
    }
    // 卡片和历史标识继续保留，但不超过 1.2x 或缺少完整耗时数据时不提供分享入口。
    return target && isHighspeedShareEligible(target.metrics) ? target : null;
  }, [highspeedMeta, highspeedTurn, unit.highspeedOutputFooterTarget]);
  const [highspeedShareDialogOpen, setHighspeedShareDialogOpen] = useState(false);
  const firstReasoningRowId = useMemo(
    () => unit.assistantWorkRows.find((row) => row.kind === "reasoning")?.rowId,
    [unit.assistantWorkRows],
  );
  const assistantRowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      ...context,
      ...(firstReasoningRowId !== undefined
        ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
        : {}),
    }),
    [context, firstReasoningRowId],
  );
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewPptxAutoOpenTarget = context.assistantPreviewPptxAutoOpenTarget;
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const assistantCodeCommentProjectionEnabled =
    codeCommentCardsEnabled &&
    (unit.isRunning ||
      latestAssistantTextRow?.state === "complete" ||
      latestAssistantTextRow?.state === "interrupted");
  const assistantRawCopyText = useMemo(
    () => resolveAssistantCopyText(unit),
    [unit.assistantTextRows, unit.assistantWorkRows, unit.latestAssistantTextRow],
  );
  const assistantFileSummaryText = useMemo(
    () => unit.assistantTextRows.map((row) => row.text).join("\n\n"),
    [unit.assistantTextRows],
  );
  const assistantCopyText = useMemo(
    () =>
      assistantCodeCommentProjectionEnabled && assistantRawCopyText !== undefined
        ? projectAssistantCodeComments(assistantRawCopyText, {
            streaming: unit.isRunning,
          }).visibleText
        : assistantRawCopyText,
    [assistantRawCopyText, assistantCodeCommentProjectionEnabled, unit.isRunning],
  );
  const assistantCodeCommentCards = useMemo(
    () =>
      codeCommentCardsEnabled &&
      assistantRawCopyText !== undefined &&
      // 卡片与 zcode-file-citation 的预览卡片保持一致：流式期间只投影正文，
      // 只有终态 row 才生成卡片，避免运行中卡片先出现又因模型续写而回滚。
      (latestAssistantTextRow?.state === "complete" ||
        latestAssistantTextRow?.state === "interrupted")
        ? buildAssistantCodeCommentCards(assistantRawCopyText, context.workspacePath, 50, {
            homePath: context.workspaceHomePath,
          })
        : [],
    [
      assistantRawCopyText,
      codeCommentCardsEnabled,
      context.workspaceHomePath,
      context.workspacePath,
      latestAssistantTextRow?.state,
    ],
  );
  const cronAutomationTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveCronAutomationTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  // 上方已是工具摘要；下方运行卡在联接到 run 后立即显示，不能再等主代理回复结束。
  // 依赖联接表保持实时更新，并由解析器按 runId 去重。直接启动轮
  // 的 run 卡也从这里出：那一轮没有用户气泡、没有助手内容，run 卡就是它的全部呈现。
  const workflowRunByToolCallId = context.workflowRunByToolCallId;
  const workflowRunByRunId = context.workflowRunByRunId;
  const workflowGraphByToolCallId = context.workflowGraphByToolCallId;
  const workflowFillGraphByRunId = context.workflowFillGraphByRunId;
  const workflowTurnDigests = useMemo(
    () =>
      resolveWorkflowTurnDigests(unit, {
        byToolCallId: workflowRunByToolCallId,
        byRunId: workflowRunByRunId,
        graphByToolCallId: workflowGraphByToolCallId,
        fillGraphByRunId: workflowFillGraphByRunId,
      }),
    [
      unit,
      workflowFillGraphByRunId,
      workflowGraphByToolCallId,
      workflowRunByRunId,
      workflowRunByToolCallId,
    ],
  );
  // 完成卡：主代理消化 completed 通知的那一轮，轮尾落卡。
  // 同一条门（轮结束）；联接只认 byRunId——通知轮里没有 CreateWorkflow 行可按 toolCallId 联。
  const workflowTurnCompletion = useMemo(
    () =>
      unit.isRunning
        ? undefined
        : resolveWorkflowTurnCompletion(unit.header, { byRunId: workflowRunByRunId }),
    [unit.header, unit.isRunning, workflowRunByRunId],
  );
  const offPeakTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveOffPeakTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  const canRenderAssistantActions =
    !unit.timelineOnly &&
    latestAssistantTextRow?.state === "complete" &&
    assistantCopyText !== undefined;
  // runtime turnId 与产品轮次 ID 不同；用 CLI 行上的命令归因关联投递，包含被裁剪输入的 header。
  const deliverySourceCommandIds = [
    ...(unit.header?.sourceCommandId ? [unit.header.sourceCommandId] : []),
    ...unit.visibleUserInputs.flatMap((row) => (row.sourceCommandId ? [row.sourceCommandId] : [])),
  ];
  const hasHookActions =
    // Hook action 与 copy/feedback/fork 共用 turn eligibility；
    // timelineOnly 维护 turn（compact/modelChange marker 轮）即使带历史遗留的
    // didExecute=true Hook row 也不得露出图标，否则 /compact 轮会凭 SessionStart
    // Hook 误挂出一个不可解释的操作栏。
    !unit.timelineOnly &&
    !unit.isRunning &&
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute));
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;
  const backgroundResultTitle = resolveBackgroundResultTitle(unit);
  const showHighspeedOutputFooter =
    unit.showHighspeedOutputFooter === true && isHighspeed && !unit.timelineOnly && !unit.isRunning;
  const hasAssistantWorkContent = unit.timelineOnly
    ? unit.assistantWorkRows.length > 0
    : unit.assistantWorkRows.length > 0 ||
      unit.workSegments?.some((segment) => segment.workStatus?.state === "running") === true ||
      unit.workStatus?.state === "running";
  const hasAssistantTurnContent =
    hasAssistantWorkContent ||
    Boolean(unit.header?.fileChanges) ||
    canRenderAssistantActions ||
    hasHookActions ||
    showHighspeedOutputFooter ||
    workflowTurnDigests.length > 0;
  const editWorkspaceRewindAvailability = useMemo<EditWorkspaceRewindAvailability>(() => {
    const fileChanges = unit.header?.fileChanges;
    if (!fileChanges || fileChanges.files <= 0) return { enabled: false, reason: "noFiles" };
    if (fileChanges.state === "reverted") return { enabled: false, reason: "reverted" };
    if (unit.isRunning) return { enabled: false, reason: "running" };
    if (unit.header?.actions?.canRewindFiles !== true) {
      return { enabled: false, reason: "unavailable" };
    }
    return { enabled: true, reason: "available" };
  }, [unit.header?.actions?.canRewindFiles, unit.header?.fileChanges, unit.isRunning]);

  // workflow 通知卡开头的轮去掉轮顶 padding：卡片只贴上一轮 pb-5 的常规流内间距。
  const startsWithWorkflowNotificationCard =
    backgroundResultTitle !== undefined && resolveWorkflowNotification(unit) !== undefined;
  // 同一条规则的另外两个来源：中枢直接启动轮与「配置」的设置轮（docs/dynamic-workflow/presentation.md
  // 「The run card」）。它们的用户行是写给模型的规范句，conversationTurnRenderUnits 会裁掉，
  // 卡 / 「已调整设置」那一行于是成了轮内第一个节点。
  //
  // Bug 根因：`pt-14` 是给用户气泡留的呼吸，判据却一直是「有没有轮」而不是「有没有气泡」；
  // 没有气泡时这 56px 叠上一轮的 pb-5，在行上方堆出约 76px 空白（设置轮总落在对话中段，最显眼）。
  const startsWithoutUserBubble =
    startsWithWorkflowNotificationCard || unit.workflowLaunch !== undefined;

  return (
    <section
      data-turn-id={unit.turnId}
      data-turn-key={unit.key}
      data-highspeed-gradient={showHighspeedAnimatedGradient ? "true" : undefined}
      className={cn(
        "relative mx-auto flex w-full flex-col gap-5 px-4 @md/conversation:px-6 pb-5",
        startsWithoutUserBubble ? "pt-0" : "pt-14",
        showHighspeedAnimatedGradient && "highspeed-animated-gradient-text",
      )}
    >
      {unit.leadingBoundaryRows.map((row) => (
        <ConversationTurnRow
          key={`${row.rowId}:${row.entityId ?? ""}`}
          row={row}
          context={context}
        />
      ))}
      {hasAssistantTurnContent ? (
        // deferAssistantActions 后工具栏被移到文件 summary 之后，
        // 之前 hover group 只包住工具栏自己，导致必须悬停到不可见按钮位置才出现。
        // 这里把 assistant work、summary 和工具栏放进同一轮 hover 容器，对齐旧版。
        <div className="group/assistant-turn flex w-full flex-col gap-5">
          {backgroundResultTitle ? (
            <>
              {visibleUserRows.map((row) => (
                <ConversationTurnRow
                  key={`${row.rowId}:${row.entityId ?? ""}`}
                  row={row}
                  context={context}
                  onEdit={row.actions?.canEdit === true ? onEdit : undefined}
                  editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
                />
              ))}
              <ConversationBackgroundResultWork
                unit={unit}
                apiRetry={apiRetry}
                context={assistantRowContext}
                onFork={canForkLatestAssistant ? onFork : undefined}
                onRetry={onRetry}
                title={backgroundResultTitle}
                assistantCopyText={assistantCopyText}
                assistantCodeCommentCards={assistantCodeCommentCards}
                assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
                assistantPreviewCardsAutoOpenKey={
                  assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                    ? assistantPreviewPptxAutoOpenTarget.key
                    : undefined
                }
              />
            </>
          ) : (
            <ConversationTurnFlow
              unit={unit}
              apiRetry={apiRetry}
              context={assistantRowContext}
              onFork={canForkLatestAssistant ? onFork : undefined}
              onRetry={onRetry}
              onEdit={onEdit}
              editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
              assistantCopyText={assistantCopyText}
              assistantCodeCommentCards={assistantCodeCommentCards}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              highspeed={isHighspeed}
              highspeedMeta={highspeedMeta}
              assistantPreviewCardsAutoOpenKey={
                assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                  ? assistantPreviewPptxAutoOpenTarget.key
                  : undefined
              }
            />
          )}
          {/* 完成卡：这一轮消化的那条 run 做了什么、花了多少，紧跟最后一段正文。 */}
          {workflowTurnCompletion === undefined ? null : (
            <ConversationWorkflowCompletion
              completion={workflowTurnCompletion}
              context={context}
              turnKey={unit.key}
            />
          )}
          {/* 轮尾摘要：这一轮留下在跑的 run，排在完成卡之后、其余轮尾块之前。 */}
          <ConversationWorkflowDigests
            context={context}
            digests={workflowTurnDigests}
            turnKey={unit.key}
          />
          {/* 修复原因：CronCreate/CronUpdate 工具本身仍按普通工具行展示；成功卡片属于整轮
              完成后的结果摘要，必须等回复结束再跟随最终 assistant 正文收尾。 */}
          <CronAutomationTurnCards cards={cronAutomationTurnCards} context={context} />
          <OffPeakTurnCards cards={offPeakTurnCards} context={context} />
          {!isOfficeMode && unit.header?.fileChanges ? (
            <ConversationFileSummaryPanel
              header={unit.header}
              context={context}
              assistantText={assistantFileSummaryText}
            />
          ) : null}
          {unit.browserTurnEndRows.length > 0 ? (
            // 自动截图表达轮次结束时页面最终状态；放在 assistant work 内会
            // 穿插到 Website 预览和 file diff 摘要之间。它应是操作栏之前的最后一个内容块。
            <ConversationAssistantWorkItems
              rows={unit.browserTurnEndRows}
              context={assistantRowContext}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          ) : null}
          {canRenderAssistantActions && latestAssistantTextRow ? (
            // 文件 summary 是整轮完成后的聚合结果；轮尾工具栏如果跟着
            // assistant text 内联渲染，会插到 summary 前面，读起来像 summary 不是本轮收尾。
            <ConversationAssistantTextActions
              rowId={latestAssistantTextRow.rowId}
              entityId={latestAssistantTextRow.entityId}
              text={assistantCopyText}
              createdAt={latestAssistantTextRow.createdAt}
              compactForRemoteControl={context.compactForRemoteControl}
              feedback={readAssistantFeedback(latestAssistantTextRow)}
              sessionId={context.sessionId}
              onFork={canForkLatestAssistant ? onFork : undefined}
              onRetry={canRetryLatestAssistant ? onRetry : undefined}
              onFeedbackChange={onFeedbackChange}
              hookInvocations={unit.hookInvocations}
              turnId={unit.turnId}
              sourceCommandIds={deliverySourceCommandIds}
              className={cn(
                "flex items-center gap-1",
                context.compactForRemoteControl
                  ? "opacity-100"
                  : "opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100 has-[[data-bot-group-delivery]]:opacity-100",
              )}
            />
          ) : (hasHookActions || !unit.isRunning) && !canRenderAssistantActions ? (
            // 冲突合并曾把此兜底接到 Highspeed 页脚的 else，导致普通回复重复入口，
            // Highspeed 无正文轮又丢失入口；它只与普通操作栏互斥，页脚独立渲染。
            <MessageActions
              className={cn(
                context.compactForRemoteControl
                  ? "opacity-100"
                  : "opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100 has-[[data-bot-group-delivery]]:opacity-100",
              )}
            >
              {hasHookActions ? (
                <ConversationHookDetailsAction rows={unit.hookInvocations} turnId={unit.turnId} />
              ) : null}
              <ConnectedBotGroupDeliveryAction
                turnId={unit.turnId}
                sourceCommandIds={deliverySourceCommandIds}
              />
            </MessageActions>
          ) : null}
          {showHighspeedOutputFooter ? (
            <HighspeedOutputFooter
              generatedLabel={intl.formatMessage({ id: "chat.highspeed.generatedBy" })}
              shareLabel={intl.formatMessage({ id: "chat.highspeed.viewAction" })}
              shareAriaLabel={intl.formatMessage({ id: "chat.highspeed.share" })}
              shareEnabled={highspeedShareTarget !== null}
              sharePending={false}
              onShare={() => setHighspeedShareDialogOpen(true)}
            />
          ) : null}
          {highspeedShareTarget ? (
            <HighspeedShareDialog
              metrics={highspeedShareTarget.metrics}
              open={highspeedShareDialogOpen}
              onOpenChange={setHighspeedShareDialogOpen}
            />
          ) : null}
          {unit.assistantTailRows.length > 0 ? (
            // turnTailBoundary 之前虽然从工作历史中拆出，却仍在 flow 内渲染，
            // 使 CronCreate、文件 summary 与操作栏看起来落在 fork 分割线之后。boundary
            // 必须统一收在全部 turn-local 附属 UI 之后，才是真正的 logical turn 结尾。
            <ConversationAssistantWorkItems
              rows={unit.assistantTailRows}
              context={assistantRowContext}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          ) : null}
        </div>
      ) : (
        <ConversationTurnFlow
          unit={unit}
          apiRetry={apiRetry}
          context={assistantRowContext}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          assistantCopyText={assistantCopyText}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          highspeed={isHighspeed}
          highspeedMeta={highspeedMeta}
        />
      )}
      {unit.topicPreparations?.length ? (
        <BotTopicPreparation items={unit.topicPreparations} />
      ) : null}
    </section>
  );
}

export const ConversationTurnGroup = memo(ConversationTurnGroupImpl);
