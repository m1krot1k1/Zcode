import { memo } from "react";
import { isConversationReasoningRowVisible } from "@/v4/conversationRowContext.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { AssistantTextRowView } from "@/v4/conversation-row-view/AssistantTextRowView.js";
import { ConversationAssistantTextActions } from "@/v4/conversation-row-view/ConversationAssistantTextActions.js";
import type { ConversationRowViewProps } from "@/v4/conversation-row-view/types.js";
import {
  ArtifactRowView,
  ReasoningRowView,
  SubagentRowView,
  TurnHeaderRowView,
} from "@/v4/conversation-row-view/SimpleRowViews.js";
import {
  ExternalAgentRunRowView,
  SwarmRunRowView,
} from "@/v4/conversation-row-view/RunRowViews.js";
import { TimelineMarkerRowView } from "@/v4/conversation-row-view/TimelineMarkerRowView.js";
import { ToolCallRowView } from "@/v4/conversation-row-view/ToolCallRowView.js";
import { UserInputRowView } from "@/v4/conversation-row-view/UserInputRowView.js";

export { ConversationAssistantTextActions } from "@/v4/conversation-row-view/ConversationAssistantTextActions.js";
export { readAssistantFeedback } from "@/v4/conversation-row-view/readAssistantFeedback.js";
export type {
  AssistantFeedbackHandler,
  EditWorkspaceRewindAvailability,
} from "@/v4/conversation-row-view/types.js";

// ── 每种行拆成独立 memo 叶子：虚拟列表下父级重渲染时，只有 props 真变的行重渲染；
// 需要 hook 的行类型（assistantText/toolCall）hook 调用留在各自组件内，避免
// switch 分发组件里出现条件 hook。──

/**
 * v4 row 渲染分发。memo：虚拟列表逐行渲染，父投影变化时只有 props 真正变化的行才重渲染
 * （前提是 onFork/onRetry/onEdit 为稳定引用 + context 引用稳定，见 SessionPane 的
 * useCallback/useMemo）。
 */
function ConversationRowViewImpl({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  editWorkspaceRewindAvailability,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
}: ConversationRowViewProps) {
  switch (row.kind) {
    case "userInput":
      return (
        <UserInputRowView
          row={row}
          context={context}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          status={userInputStatus}
        />
      );
    case "assistantText":
      return (
        <AssistantTextRowView
          row={row}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          hideActions={hideAssistantActions}
          deferActions={deferAssistantActions}
          copyText={assistantCopyText}
          previewCards={assistantPreviewCards}
          previewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          codeCommentCards={assistantCodeCommentCards}
          codeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      );
    case "reasoning":
      // 关闭“显示思考过程”只隐藏每轮后续 reasoning；首条 reasoning
      // 是该轮最小必要思考提示，必须由 turn 全序派生的 rowId 保留下来。
      return isConversationReasoningRowVisible(row.rowId, context) ? (
        <ReasoningRowView row={row} contentVariant={reasoningContentVariant} />
      ) : null;
    case "turnHeader":
      return <TurnHeaderRowView row={row} />;
    case "timelineMarker":
      return <TimelineMarkerRowView row={row} context={context} />;
    case "toolCall":
      // 只在 ToolCallBlock 内返回 null 会留下空 RowShell 和多余间距；
      // 在行分发处按同一工具身份规则裁剪，设置关闭时不产生任何 Todo DOM。
      if (
        context.messageStreamShowTodos !== true &&
        resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName }).family === "todo"
      ) {
        return null;
      }
      return <ToolCallRowView row={row} context={context} />;
    case "subagent":
      return <SubagentRowView row={row} />;
    case "swarmRun":
      return <SwarmRunRowView row={row} context={context} />;
    case "externalAgentRun":
      return <ExternalAgentRunRowView row={row} context={context} />;
    case "artifact":
      return <ArtifactRowView row={row} />;
    default:
      return null;
  }
}

export const ConversationRowView = memo(ConversationRowViewImpl);
