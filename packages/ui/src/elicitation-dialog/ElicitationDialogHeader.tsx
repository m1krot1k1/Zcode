import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import type { ZCodeElicitationRequest } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { InteractionRequestOriginBadge } from "@/InteractionRequestOriginBadge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface ElicitationCountdownButtonProps {
  countdownSeconds: number | null;
  onStopCountdown: () => void;
}

function ElicitationCountdownButton({
  countdownSeconds,
  onStopCountdown,
}: ElicitationCountdownButtonProps) {
  const { intl } = useZCodeIntl();
  if (countdownSeconds === null) {
    return null;
  }
  const stopCountdownLabel = intl.formatMessage({ id: "taskList.stopCountdown" });
  return (
    <Button
      type="button"
      size="xs"
      variant="secondary"
      data-elicitation-countdown-seconds={countdownSeconds}
      aria-label={stopCountdownLabel}
      title={stopCountdownLabel}
      onClick={onStopCountdown}
      className="min-w-10 px-1.5 tabular-nums text-foreground-subtle"
    >
      {intl.formatMessage(
        { id: "chat.elicitation.countdownSeconds" },
        { seconds: String(countdownSeconds) },
      )}
    </Button>
  );
}

export interface ElicitationDialogHeaderProps {
  origin: ZCodeElicitationRequest["origin"];
  titleHeader?: string;
  titleQuestion: string;
  shouldOfferQuestionCollapse: boolean;
  isQuestionExpanded: boolean;
  onToggleQuestionExpanded: () => void;
  isDialogExpanded: boolean;
  onToggleDialogExpanded: () => void;
  countdownSeconds: number | null;
  onStopCountdown: () => void;
  canGoPreviousPage: boolean;
  canGoNextPage: boolean;
  questionProgress: string;
  onGoPreviousPage: () => void;
  onGoNextPage: () => void;
}

export function ElicitationDialogHeader({
  origin,
  titleHeader,
  titleQuestion,
  shouldOfferQuestionCollapse,
  isQuestionExpanded,
  onToggleQuestionExpanded,
  isDialogExpanded,
  onToggleDialogExpanded,
  countdownSeconds,
  onStopCountdown,
  canGoPreviousPage,
  canGoNextPage,
  questionProgress,
  onGoPreviousPage,
  onGoNextPage,
}: ElicitationDialogHeaderProps) {
  const { intl } = useZCodeIntl();
  const questionCollapseLabel = intl.formatMessage({
    id: isQuestionExpanded
      ? "chat.elicitation.collapseQuestion"
      : "chat.elicitation.expandQuestion",
  });
  const dialogCollapseLabel = intl.formatMessage({
    id: isDialogExpanded ? "chat.elicitation.collapseDialog" : "chat.elicitation.expandDialog",
  });

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1 text-ui-base font-medium leading-5">
        <InteractionRequestOriginBadge origin={origin} className="mr-2" />
        {titleHeader ? (
          <Badge variant="outline" className="mr-2 max-w-40 align-baseline text-ui-base truncate">
            {titleHeader}
          </Badge>
        ) : null}
        {/* Bugfix: 问题不能只放在会截断的标题行；移动端没有 hover，必须在 tag 后直接完整可读。 */}
        <span
          title={titleQuestion}
          className={cn(
            "whitespace-pre-wrap break-words leading-6 text-foreground",
            shouldOfferQuestionCollapse && !isQuestionExpanded ? "max-md:line-clamp-4" : undefined,
          )}
        >
          {titleQuestion}
        </span>
        {shouldOfferQuestionCollapse ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-expanded={isQuestionExpanded}
            aria-label={questionCollapseLabel}
            title={questionCollapseLabel}
            onClick={onToggleQuestionExpanded}
            className="mt-2 hidden max-md:inline-flex"
          >
            {isQuestionExpanded ? (
              <ChevronUp className="size-3" />
            ) : (
              <ChevronDown className="size-3" />
            )}
            <span>{questionCollapseLabel}</span>
          </Button>
        ) : null}
      </div>
      <div className="flex items-center gap-1 text-ui-base font-medium leading-tight text-foreground-subtlest">
        <ElicitationCountdownButton
          countdownSeconds={countdownSeconds}
          onStopCountdown={onStopCountdown}
        />
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-expanded={isDialogExpanded}
          aria-label={dialogCollapseLabel}
          title={dialogCollapseLabel}
          onClick={onToggleDialogExpanded}
          className="hidden max-md:inline-flex"
        >
          {isDialogExpanded ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={!canGoPreviousPage}
          title={intl.formatMessage({
            id: "chat.elicitation.previousQuestion",
          })}
          aria-label={intl.formatMessage({
            id: "chat.elicitation.previousQuestion",
          })}
          onClick={onGoPreviousPage}
        >
          <ChevronLeft className="size-3" />
        </Button>
        <span className="min-w-10 text-center">{questionProgress}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={!canGoNextPage}
          title={intl.formatMessage({
            id: "chat.elicitation.nextQuestion",
          })}
          aria-label={intl.formatMessage({
            id: "chat.elicitation.nextQuestion",
          })}
          onClick={onGoNextPage}
        >
          <ChevronRight className="size-3" />
        </Button>
      </div>
    </div>
  );
}

export interface ElicitationCollapsedHeaderProps {
  titleHeader?: string;
  titleQuestion: string;
  countdownSeconds: number | null;
  onStopCountdown: () => void;
  onExpandDialog: () => void;
  questionProgress: string;
}

export function ElicitationCollapsedHeader({
  titleHeader,
  titleQuestion,
  countdownSeconds,
  onStopCountdown,
  onExpandDialog,
  questionProgress,
}: ElicitationCollapsedHeaderProps) {
  const { intl } = useZCodeIntl();
  const dialogCollapseLabel = intl.formatMessage({ id: "chat.elicitation.expandDialog" });

  return (
    <div className="hidden min-w-0 items-center justify-between gap-2 max-md:flex">
      <button
        type="button"
        onClick={onExpandDialog}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left text-ui-base font-medium text-foreground hover:bg-hover"
      >
        {titleHeader ? (
          <Badge
            variant="outline"
            className="max-w-32 shrink-0 align-baseline text-ui-base truncate"
          >
            {titleHeader}
          </Badge>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{titleQuestion}</span>
      </button>
      <ElicitationCountdownButton
        countdownSeconds={countdownSeconds}
        onStopCountdown={onStopCountdown}
      />
      <span className="shrink-0 text-ui-base font-medium text-foreground-subtlest">
        {questionProgress}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-expanded={false}
        aria-label={dialogCollapseLabel}
        title={dialogCollapseLabel}
        onClick={onExpandDialog}
      >
        <ChevronUp className="size-3" />
      </Button>
    </div>
  );
}
