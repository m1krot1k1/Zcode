import { CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { resolveInterruptedStatusMessageId } from "@/v4/conversationTurnWorkSegments.js";
import type { ConversationTurnWorkSegment } from "@/v4/conversationTurnWorkSegments.js";
import type { ReadonlyLabels } from "@/v4/share-readonly-timeline/types.js";
import type { Locale } from "@zcode/shared";
import { ChevronRightIcon } from "lucide-react";

export function ReadonlyHistoryStatus({
  segment,
  open,
  labels,
  locale,
}: {
  segment: ConversationTurnWorkSegment;
  open: boolean;
  labels: ReadonlyLabels;
  locale: Locale;
}) {
  const { intl } = useZCodeIntl();
  const duration = formatConversationWorkDuration(
    segment.workStatus?.durationMs,
    intl,
    locale,
  );
  const label =
    segment.workStatus?.state === "interrupted"
      ? intl.formatMessage({
          id: resolveInterruptedStatusMessageId(
            segment.workStatus.interruptReason,
            segment.workStatus.interruptDetail,
          ),
        })
      : segment.workStatus?.state === "failed"
        ? intl.formatMessage({ id: "chat.history.failed" })
        : segment.workStatus?.state === "running"
          ? intl.formatMessage(
              { id: "chat.history.workingFor" },
              { duration: duration ?? "" },
            )
          : duration
            ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration })
            : labels.history;
  return (
    <div className="flex w-full border-b border-border/50 pb-2">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-conversation-share-history-trigger="true"
          data-history-open={String(open)}
          className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          <span className="truncate">{label}</span>
          {!segment.assistantHistoryDefaultOpen ? (
            <ChevronRightIcon
              aria-hidden="true"
              className={`size-4 shrink-0 text-foreground-subtlest opacity-70 transition-transform ${open ? "rotate-90" : "rotate-0"}`}
            />
          ) : null}
        </button>
      </CollapsibleTrigger>
    </div>
  );
}
