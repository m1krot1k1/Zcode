import { GenUiMessageResponse } from "@/gen-ui/index.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { memo, useMemo } from "react";
import type { AssistantTextRow, ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import { AssistantPreviewCards } from "@/AssistantPreviewCards.js";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import { cn } from "@/components/lib/utils.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import {
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { type ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { RowShell } from "@/v4/conversation-row-view/RowShell.js";
import { ConversationAssistantTextActions } from "@/v4/conversation-row-view/ConversationAssistantTextActions.js";
import { readAssistantFeedback } from "@/v4/conversation-row-view/readAssistantFeedback.js";
import type { AssistantFeedbackHandler } from "@/v4/conversation-row-view/types.js";

export const AssistantTextRowView = memo(function AssistantTextRowView({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  hideActions,
  deferActions,
  copyText,
  previewCards,
  previewCardsAutoOpenKey,
  codeCommentCards,
  codeCommentProjectionEnabled,
}: {
  row: AssistantTextRow;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  hideActions?: boolean;
  deferActions?: boolean;
  copyText?: string;
  previewCards?: AssistantPreviewCard[];
  previewCardsAutoOpenKey?: string;
  codeCommentCards?: AssistantCodeCommentCard[];
  codeCommentProjectionEnabled?: boolean;
}) {
  const streaming = row.state === "streaming";
  const isOfficeMode = useIsOfficeMode();
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const projectsCodeComments = codeCommentCardsEnabled && codeCommentProjectionEnabled === true;
  const visibleText = useMemo(
    () =>
      projectsCodeComments
        ? projectAssistantCodeComments(row.text, { streaming }).visibleText
        : row.text,
    [projectsCodeComments, row.text, streaming],
  );
  const visiblePreviewCards = previewCards && previewCards.length > 0 ? previewCards : null;
  return (
    <RowShell rowId={row.rowId} className="group/assistant-row">
      {/* M5④ 阶段2：assistant 文本走 streamdown（MessageResponse），
          markdown/代码块正式渲染；streaming 模式对未闭合 markdown 容错。 */}
      {/* Bugfix：MessageResponse 只消费自身声明的 props，不会把 data-* 透传到真实 DOM，
          导致 assistant 正文虽然在 JSX 上标了 selectable，框选逻辑却永远找不到该区域。
          selectable 语义必须放在稳定的 DOM 包装层上，完成态和 streaming 共用同一路径。 */}
      <div data-conversation-selectable="true" className="w-full text-ui-base">
        <GenUiMessageResponse
          completed={row.state === "complete"}
          messageKey={`${row.rowId}:${row.entityId ?? ""}`}
          renderZCodeFileCitations
          streaming={streaming}
          workspacePath={context.workspacePath}
          workspaceIdentity={context.workspaceIdentity}
          workspaceRemoteSessionId={context.workspaceRemoteSessionId}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          forceCodeWrap={isOfficeMode}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenExternalUrl={context.onOpenBrowserUrl}
          sessionId={context.sessionId ?? undefined}
          readAttachment={context.readAttachment}
        >
          {visibleText}
        </GenUiMessageResponse>
      </div>
      {codeCommentCardsEnabled && codeCommentCards && codeCommentCards.length > 0 ? (
        <div className="mt-3">
          <AssistantCodeCommentCards
            cards={codeCommentCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenCodeViewer={context.onOpenCodeViewer}
          />
        </div>
      ) : null}
      {visiblePreviewCards ? (
        <div className="mt-3">
          <AssistantPreviewCards
            cards={visiblePreviewCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            autoOpenPptxKey={previewCardsAutoOpenKey}
            onAutoOpenPptx={context.onAutoOpenAssistantPptx}
            compactForRemoteControl={context.compactForRemoteControl}
          />
        </div>
      ) : null}
      {/* 完成态动作行悬停显现（对齐旧 MessageActions）：复制 + fork（图标 ghost）。
          一轮对用户是一个回复：action 只在轮尾段（hideActions 由 TurnGroup 裁决），
          复制内容 = 整轮全部 text 段合并（copyText 覆盖）。 */}
      {row.state === "complete" && !hideActions && !deferActions ? (
        <ConversationAssistantTextActions
          rowId={row.rowId}
          entityId={row.entityId}
          text={copyText ?? row.text}
          createdAt={row.createdAt}
          compactForRemoteControl={context.compactForRemoteControl}
          feedback={readAssistantFeedback(row)}
          sessionId={context.sessionId}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          className={cn(
            "mt-1",
            context.compactForRemoteControl
              ? "opacity-100"
              : "opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100",
          )}
        />
      ) : null}
    </RowShell>
  );
});
