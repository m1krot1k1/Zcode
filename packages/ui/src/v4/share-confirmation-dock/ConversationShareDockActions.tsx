import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationShareDisplayError } from "@/store/conversationShareSelectionStore.js";

export interface ConversationShareDockActionsProps {
  compactProgress: boolean;
  publishView: boolean;
  footerMetaMessageId: string;
  footerMetaValues: Record<string, string | number>;
  pending: boolean;
  selectionEditing: boolean;
  publishDisabled: boolean;
  selectedCount: number;
  title: string;
  error: ConversationShareDisplayError | null;
  onConfirm: () => void;
}

/** 底部状态文案与主操作；窄屏下主操作单独占一行，避免被外层裁切。 */
export function ConversationShareDockActions({
  compactProgress,
  publishView,
  footerMetaMessageId,
  footerMetaValues,
  pending,
  selectionEditing,
  publishDisabled,
  selectedCount,
  title,
  error,
  onConfirm,
}: ConversationShareDockActionsProps) {
  const { intl } = useZCodeIntl();

  return (
    <div
      data-testid="conversation-share-confirmation-actions"
      className={cn(
        "flex shrink-0 flex-wrap content-center items-center justify-between gap-2 p-3",
        compactProgress && "pt-0",
      )}
    >
      <p
        role="status"
        className={cn(
          "min-w-0 text-ui-sm leading-4 tabular-nums",
          compactProgress && "text-foreground-subtle",
          !publishView && "sr-only",
        )}
      >
        {intl.formatMessage({ id: footerMetaMessageId }, footerMetaValues)}
      </p>
      {!compactProgress ? (
        <div className="grid w-full min-w-0 grid-cols-2 gap-2 @min-[480px]/share:flex @min-[480px]/share:w-auto @min-[480px]/share:flex-1 @min-[480px]/share:flex-wrap @min-[480px]/share:justify-end">
          <Button
            type="button"
            size="lg"
            disabled={
              pending || selectionEditing || publishDisabled || selectedCount === 0 || !title.trim()
            }
            onClick={onConfirm}
            data-testid="conversation-share-confirm"
            className={cn(
              "col-span-2 whitespace-normal break-words px-3 @min-[480px]/share:order-last",
              "h-10",
            )}
          >
            {intl.formatMessage({
              id: error
                ? "conversationShare.publish.retry"
                : pending
                  ? "conversationShare.partial.publishing"
                  : "conversationShare.partial.confirm",
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
