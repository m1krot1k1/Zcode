// 确认、发布进度和结构化失败详情共享同一 dock 状态与操作上下文。
// 展示片段与纯模型拆到 ./share-confirmation-dock/，本文件保留状态所有者与组装顺序。
import { memo, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DEFAULT_CONVERSATION_SHARE_ACCESS_MODE } from "@/store/conversationShareSelectionStore.js";
import { ConversationShareDockActions } from "@/v4/share-confirmation-dock/ConversationShareDockActions.js";
import { ConversationShareDockHeader } from "@/v4/share-confirmation-dock/ConversationShareDockHeader.js";
import { ConversationShareDisclosureSection } from "@/v4/share-confirmation-dock/ConversationShareDisclosureSection.js";
import { ConversationShareEditSection } from "@/v4/share-confirmation-dock/ConversationShareEditSection.js";
import { ConversationShareErrorDetails } from "@/v4/share-confirmation-dock/ConversationShareErrorDetails.js";
import { ConversationSharePublishProgress } from "@/v4/share-confirmation-dock/ConversationSharePublishProgress.js";
import { ConversationShareWarningDetails } from "@/v4/share-confirmation-dock/ConversationShareWarningDetails.js";
import {
  NOOP,
  resolveShareAccessSummaryMessageId,
  resolveShareFooterMetaMessageId,
} from "@/v4/share-confirmation-dock/shareConfirmationDockModel.js";
import type { ConversationShareConfirmationDockProps } from "@/v4/share-confirmation-dock/types.js";

function ConversationShareConfirmationDockImpl({
  selectionEditing = false,
  publishDisabled = false,
  preflightChecking = false,
  preflightContent,
  selectedCount,
  totalCount,
  title = "Share",
  accessMode = DEFAULT_CONVERSATION_SHARE_ACCESS_MODE,
  progressLabel,
  progressPhase = "collecting",
  completedArtifacts = 0,
  totalArtifacts = 0,
  onCancel,
  onEditSelection,
  onConfirm,
  onTitleChange = NOOP,
  onAccessModeChange = NOOP,
  disclosureAccepted = false,
  onDisclosureAcceptedChange = NOOP,
  pending = false,
  error = null,
  warnings = null,
  onDeselectTurn,
  onDismissError,
  onDismissWarnings,
  onCopyRequestId,
}: ConversationShareConfirmationDockProps) {
  const { intl } = useZCodeIntl();
  const disclosureRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const checkboxRef = useRef<HTMLButtonElement>(null);
  const reviewRowRef = useRef<HTMLLabelElement>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const invalidDisclosure = reviewRequired && !disclosureAccepted;
  const reviewAnimationRef = useRef<Animation | null>(null);
  useEffect(() => () => reviewAnimationRef.current?.cancel(), []);
  const handleConfirm = () => {
    if (!error && !disclosureAccepted) {
      setReviewRequired(true);
      // 仅对确认行做 transform 提示并滚动正文，不改变布局或牵动外层页面。
      const body = bodyRef.current;
      const disclosure = disclosureRef.current;
      if (body && disclosure) {
        const bodyBounds = body.getBoundingClientRect();
        const bounds = disclosure.getBoundingClientRect();
        if (bounds.top < bodyBounds.top) body.scrollTop += bounds.top - bodyBounds.top;
        else if (bounds.bottom > bodyBounds.bottom)
          body.scrollTop += bounds.bottom - bodyBounds.bottom;
      }
      checkboxRef.current?.focus({ preventScroll: true });
      reviewAnimationRef.current?.cancel();
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        reviewAnimationRef.current =
          reviewRowRef.current?.animate(
            [
              { transform: "translateX(0)" },
              { transform: "translateX(-4px)" },
              { transform: "translateX(4px)" },
              { transform: "translateX(-2px)" },
              { transform: "translateX(2px)" },
              { transform: "translateX(0)" },
            ],
            { duration: 280, easing: "ease-out" },
          ) ?? null;
      }
      return;
    }
    onConfirm();
  };
  const handleDisclosureAcceptedChange = (accepted: boolean) => {
    setReviewRequired(false);
    reviewAnimationRef.current?.cancel();
    onDisclosureAcceptedChange(accepted);
  };
  const publishView = pending || error !== null;
  const compactProgress = pending && !error;
  const accessSummaryMessageId = resolveShareAccessSummaryMessageId(accessMode);
  const footerMetaMessageId = resolveShareFooterMetaMessageId(error !== null, pending);
  const footerMetaValues: Record<string, string | number> =
    pending && !error
      ? {
          selected: selectedCount,
          access: intl.formatMessage({ id: accessSummaryMessageId }),
        }
      : { selected: selectedCount, total: totalCount };

  return (
    // 分享 dock 曾在同一输入区额外叠加 popover ring、阴影和固定宽度，
    // 切换时会产生不必要的层级光晕；这里只继承普通 Composer 的基础输入 surface。
    <section
      data-conversation-share-keep-open="confirmation-dock"
      data-testid="conversation-share-confirmation-dock"
      className={cn(
        "@container/share flex max-h-[70dvh] w-full min-w-0 flex-col overflow-hidden text-foreground",
        "bg-popover",
      )}
    >
      {/* 窄面板下表单会增高；正文独立滚动，避免把发布操作挤出视口。 */}
      <div
        ref={bodyRef}
        data-testid="conversation-share-confirmation-body"
        className="min-h-0 overflow-y-auto overscroll-contain"
      >
        <ConversationShareDockHeader error={error} pending={pending} onCancel={onCancel} />
        {error ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onEditSelection}
            data-testid="conversation-share-adjust"
          >
            {intl.formatMessage({ id: "conversationShare.range.adjust" })}
          </Button>
        ) : null}
        {publishView ? (
          <ConversationSharePublishProgress
            compactProgress={compactProgress}
            title={title}
            progressLabel={progressLabel}
            progressPhase={progressPhase}
            completedArtifacts={completedArtifacts}
            totalArtifacts={totalArtifacts}
            error={error}
          />
        ) : (
          <>
            <ConversationShareEditSection
              title={title}
              onTitleChange={onTitleChange}
              selectionEditing={selectionEditing}
              preflightChecking={preflightChecking}
              preflightContent={preflightContent}
              onEditSelection={onEditSelection}
              selectedCount={selectedCount}
              totalCount={totalCount}
              accessMode={accessMode}
              onAccessModeChange={onAccessModeChange}
            />
            <ConversationShareDisclosureSection
              disclosureRef={disclosureRef}
              checkboxRef={checkboxRef}
              reviewRowRef={reviewRowRef}
              disclosureAccepted={disclosureAccepted}
              invalidDisclosure={invalidDisclosure}
              onAcceptedChange={handleDisclosureAcceptedChange}
            />
          </>
        )}
        {error ? (
          <ConversationShareErrorDetails
            error={error}
            onDeselectTurn={onDeselectTurn}
            onDismissError={onDismissError}
            onCopyRequestId={onCopyRequestId}
          />
        ) : null}
        {warnings && warnings.issues.length > 0 && !pending ? (
          <ConversationShareWarningDetails
            warnings={warnings}
            onDismissWarnings={onDismissWarnings}
          />
        ) : null}
      </div>
      <ConversationShareDockActions
        compactProgress={compactProgress}
        publishView={publishView}
        footerMetaMessageId={footerMetaMessageId}
        footerMetaValues={footerMetaValues}
        pending={pending}
        selectionEditing={selectionEditing}
        publishDisabled={publishDisabled}
        selectedCount={selectedCount}
        title={title}
        error={error}
        onConfirm={handleConfirm}
      />
    </section>
  );
}

export const ConversationShareConfirmationDock = memo(ConversationShareConfirmationDockImpl);
