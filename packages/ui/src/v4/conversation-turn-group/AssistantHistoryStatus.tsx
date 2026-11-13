import { ChevronRightIcon } from "lucide-react";
import { type HighspeedMessageMeta } from "@zcode/shared";
import { TID_CHAT_ASSISTANT_HISTORY_TRIGGER, testId } from "@zcode/shared/test-ids";
import { CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBotTopicInterruption } from "@/v4/botGroupDeliveryContext.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import type { ConversationTurnWorkSegment } from "@/v4/conversationTurnRenderUnits.js";
import { resolveInterruptedStatusMessageId } from "@/v4/conversationTurnWorkSegments.js";

/** history 段标题行：工时/状态文案、折叠箭头与 Highspeed 标记。 */
export function AssistantHistoryStatus({
  segment,
  open,
  highspeed,
  highspeedMeta,
  sourceCommandIds,
}: {
  segment: ConversationTurnWorkSegment;
  open: boolean;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
  sourceCommandIds: readonly string[];
}) {
  const { intl, locale } = useZCodeIntl();
  const topicInterrupted = useBotTopicInterruption(sourceCommandIds);
  const durationLabel = formatConversationWorkDuration(
    segment.workStatus?.durationMs,
    intl,
    locale,
  );
  const savedDurationLabel =
    segment.workStatus?.state === "completed" &&
    highspeedMeta?.savedDurationMs !== undefined &&
    highspeedMeta.savedDurationMs > 0
      ? formatConversationWorkDuration(highspeedMeta.savedDurationMs, intl, locale)
      : null;
  const label =
    segment.workStatus?.state === "interrupted"
      ? intl.formatMessage({
          id: topicInterrupted
            ? "chat.history.topicInterrupted"
            : resolveInterruptedStatusMessageId(
                segment.workStatus.interruptReason,
                segment.workStatus.interruptDetail,
              ),
        })
      : segment.workStatus?.state === "failed"
        ? intl.formatMessage({ id: "chat.history.failed" })
        : segment.workStatus?.state === "running"
          ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: durationLabel ?? "" })
          : durationLabel
            ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration: durationLabel })
            : intl.formatMessage({ id: "chat.history.worked" });

  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-center justify-between gap-2 border-b",
        highspeed ? "border-icon-purple/30 pb-3 pl-1" : "border-[var(--color-border)]/50 pb-2",
      )}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_TRIGGER, segment.key)}
          data-history-open={String(open)}
          className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        >
          <span
            className={cn("truncate", highspeed && "font-medium leading-5 text-icon-purple")}
            data-highspeed-duration={highspeed ? "true" : undefined}
          >
            {label}
          </span>
          {!segment.assistantHistoryDefaultOpen ? (
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-[var(--color-foreground-subtlest)] opacity-70 transition-transform",
                open ? "rotate-90" : "rotate-0",
              )}
            />
          ) : null}
        </button>
      </CollapsibleTrigger>
      {highspeed ? (
        <div className="ml-auto flex shrink-0 items-center gap-2 text-icon-purple">
          {savedDurationLabel ? (
            <span className="text-ui-sm font-medium leading-4" data-highspeed-saved-duration="true">
              {intl.formatMessage(
                { id: "chat.highspeed.savedDuration" },
                { duration: savedDurationLabel },
              )}
            </span>
          ) : null}
          <span
            className="rounded-full bg-hover px-2 py-0.5 text-ui-sm leading-4"
            data-highspeed-status-tag="true"
          >
            {intl.formatMessage({ id: "chat.highspeed.statusTag" })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
