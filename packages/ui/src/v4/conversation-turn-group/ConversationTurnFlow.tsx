import { type HighspeedMessageMeta } from "@zcode/shared";
import type { ApiRetryState, ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";
import type { EditWorkspaceRewindAvailability } from "@/v4/ConversationRowView.js";
import { useAssistantPreviewCardsForAssistantTextRow } from "@/v4/useAssistantPreviewCardsForRow.js";
import { shouldShowTurnChatLoading } from "@/v4/chatLoadingVisibility.js";
import { ConversationAssistantWorkItems } from "@/v4/conversation-turn-group/ConversationAssistantWorkItems.js";
import { TurnChatLoadingSlot } from "@/v4/conversation-turn-group/TurnChatLoadingSlot.js";
import { ConversationWorkSegmentFlow } from "@/v4/conversation-turn-group/ConversationWorkSegmentFlow.js";
import type { ConversationTurnGroupProps } from "@/v4/conversation-turn-group/types.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type {
  ConversationTurnRenderUnit,
  ConversationTurnWorkSegment,
} from "@/v4/conversationTurnRenderUnits.js";

/**
 * 普通 turn 的 flow 出口：timelineOnly 维护轮、单/多 work segment 与轮底加载槽。
 */
export function ConversationTurnFlow({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  onEdit,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
  highspeed,
  highspeedMeta,
}: {
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
}) {
  // 产品语义：可见正文或工具不代表主轮已经结束；ChatLoading 跟随最后一轮
  // running 生命周期，但等待用户回答/授权时由交互 UI 独占进度反馈。
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: unit.latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow: unit.latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    compactForRemoteControl: context.compactForRemoteControl,
    fileChangesTarget: unit.header?.entityId
      ? { rowId: unit.header.rowId, entityId: unit.header.entityId }
      : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  if (unit.timelineOnly) {
    return (
      <div className="flex flex-col gap-2">
        <ConversationAssistantWorkItems
          rows={unit.assistantWorkRows}
          context={context}
          stageTailIsRunning={unit.isRunning}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
        <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
      </div>
    );
  }

  const projectedWorkSegments = unit.workSegments ?? [];
  const workSegments: ConversationTurnWorkSegment[] =
    projectedWorkSegments.length > 0
      ? projectedWorkSegments.length === 1
        ? [
            {
              ...projectedWorkSegments[0]!,
              // 兼容仍直接构造/覆写旧 render unit 的调用方；真实 guide 多段不走这个分支。
              assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            },
          ]
        : projectedWorkSegments
      : [
          {
            key: unit.key,
            flowItems: unit.flowItems,
            assistantWorkRows: unit.assistantWorkRows,
            assistantHistoryRows: unit.assistantHistoryRows,
            assistantFollowingRows: unit.assistantFollowingRows,
            assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
          },
        ];
  if (
    workSegments.every(
      (segment) => segment.flowItems.length === 0 && segment.workStatus === undefined,
    ) &&
    !showLoading
  ) {
    return null;
  }

  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;

  // 即使恢复了 guide 的 row 全序，也不能让所有 history chunk 共享同一个
  // Collapsible。accepted guide 现在由 CLI workSegments 定界，每段组件自行维护折叠状态。
  return (
    <div className="flex flex-col gap-5">
      {workSegments.map((segment) => (
        <ConversationWorkSegmentFlow
          key={segment.key}
          segment={segment}
          sourceCommandIds={[
            ...segment.flowItems.flatMap((item) =>
              item.kind === "userInput" && item.row.sourceCommandId
                ? [item.row.sourceCommandId]
                : [],
            ),
            ...(segment === workSegments[0] && unit.header?.sourceCommandId
              ? [unit.header.sourceCommandId]
              : []),
          ]}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          canForkLatestAssistant={canForkLatestAssistant}
          canRetryLatestAssistant={canRetryLatestAssistant}
          highspeed={highspeed}
          highspeedMeta={highspeedMeta}
        />
      ))}
      <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
    </div>
  );
}
