import { CircleX, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationShareDisplayError } from "@/store/conversationShareSelectionStore.js";

export interface ConversationShareDockHeaderProps {
  error: ConversationShareDisplayError | null;
  pending: boolean;
  onCancel: () => void;
}

/** 标题、失败说明与关闭按钮；发布中禁止关闭，避免中途丢失进行中的请求。 */
export function ConversationShareDockHeader({
  error,
  pending,
  onCancel,
}: ConversationShareDockHeaderProps) {
  const { intl } = useZCodeIntl();

  return (
    <div
      data-testid="conversation-share-confirmation-header"
      className={cn("flex flex-wrap items-center justify-between gap-3 p-3")}
    >
      <div className="min-w-0">
        <p
          className={cn(
            "flex items-center gap-1.5 font-medium",
            "text-ui-lg",
            error && "text-destructive",
          )}
        >
          {error ? <CircleX className="size-4 shrink-0" aria-hidden="true" /> : null}
          {intl.formatMessage({
            id: error
              ? "conversationShare.publish.failedTitle"
              : pending
                ? "conversationShare.generatingLink"
                : "conversationShare.popover.title",
          })}
        </p>
        {error ? (
          <p className="mt-1 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id: "conversationShare.publish.failedDescription",
            })}
          </p>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={pending}
        onClick={onCancel}
        aria-label={intl.formatMessage({
          id: "conversationShare.result.dismiss",
        })}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
