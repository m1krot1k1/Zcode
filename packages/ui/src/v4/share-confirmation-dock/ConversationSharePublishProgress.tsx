import { Circle, CircleCheck, CircleX, LoaderCircle, ShieldCheck } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  ConversationShareDisplayError,
  ConversationShareProgressPhase,
} from "@/store/conversationShareSelectionStore.js";
import {
  SHARE_PHASE_LABEL_IDS,
  SHARE_PROGRESS_PHASES,
  resolveShareFailedProgressMessageId,
  resolveShareProgressPercent,
  resolveShareProgressPhaseIndex,
} from "./shareConfirmationDockModel.js";

export interface ConversationSharePublishProgressProps {
  compactProgress: boolean;
  title: string;
  progressLabel?: string;
  progressPhase: ConversationShareProgressPhase;
  completedArtifacts: number;
  totalArtifacts: number;
  error: ConversationShareDisplayError | null;
}

/** 三段发布进度：收集、上传、校验；失败时只标红当前阶段。 */
export function ConversationSharePublishProgress({
  compactProgress,
  title,
  progressLabel,
  progressPhase,
  completedArtifacts,
  totalArtifacts,
  error,
}: ConversationSharePublishProgressProps) {
  const { intl } = useZCodeIntl();
  const progressPercent = resolveShareProgressPercent(progressPhase);
  const failedProgressMessageId = resolveShareFailedProgressMessageId(progressPhase);
  const progressPhaseIndex = resolveShareProgressPhaseIndex(progressPhase);

  return (
    <div
      data-testid="conversation-share-publish-progress"
      className={cn("grid gap-3", compactProgress ? "px-3 pb-3" : "p-3 pb-4")}
    >
      {compactProgress ? (
        <p className="line-clamp-2 break-words text-ui-base" title={title}>
          {title}
        </p>
      ) : null}
      <div className="grid gap-2">
        <p role="status" className={compactProgress ? "sr-only" : "text-ui-base font-medium"}>
          {error ? intl.formatMessage({ id: failedProgressMessageId }) : progressLabel}
        </p>
        <div
          className={cn(
            "overflow-hidden rounded-full bg-background-subtle",
            compactProgress ? "h-1" : "h-1.5",
          )}
          role="progressbar"
          aria-label={intl.formatMessage({
            id: "conversationShare.generatingLink",
          })}
          aria-valuenow={progressPercent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            data-testid="conversation-share-progress-fill"
            className={cn(
              "h-full rounded-full transition-[width]",
              error ? "bg-destructive" : "bg-primary",
            )}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
      <div
        className={cn(
          "grid gap-3 text-ui-sm",
          !compactProgress && "@min-[640px]/share:grid-cols-3",
        )}
      >
        {SHARE_PROGRESS_PHASES.map((phase, index) => {
          const completed = index < progressPhaseIndex;
          const failed = error !== null && phase === progressPhase;
          const active = !error && phase === progressPhase;
          const phaseState = completed
            ? "complete"
            : failed
              ? "failed"
              : active
                ? "active"
                : "pending";
          const PhaseIcon = completed
            ? CircleCheck
            : failed
              ? CircleX
              : active
                ? LoaderCircle
                : phase === "checking"
                  ? ShieldCheck
                  : Circle;
          const phaseDescription = failed
            ? intl.formatMessage({ id: "conversationShare.phase.failed" })
            : completed
              ? intl.formatMessage({
                  id:
                    phase === "collecting"
                      ? "conversationShare.phase.collectingComplete"
                      : "conversationShare.phase.uploadingComplete",
                })
              : active && phase === "uploading" && totalArtifacts > 0
                ? intl.formatMessage(
                    { id: "conversationShare.phase.uploadingActive" },
                    {
                      completed: completedArtifacts,
                      total: totalArtifacts,
                    },
                  )
                : active
                  ? progressLabel
                  : intl.formatMessage({
                      id:
                        phase === "collecting"
                          ? "conversationShare.phase.collectingPending"
                          : phase === "uploading"
                            ? "conversationShare.phase.uploadingPending"
                            : "conversationShare.phase.checkingPending",
                    });
          return (
            <div
              key={phase}
              data-testid={`conversation-share-publish-phase-${phase}`}
              data-phase-state={phaseState}
              className={cn(
                "flex min-w-0 items-start gap-2",
                failed
                  ? "text-destructive"
                  : completed || active
                    ? "text-foreground"
                    : "text-foreground-subtlest",
              )}
              aria-current={active || failed ? "step" : undefined}
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                <PhaseIcon
                  className={cn(
                    "size-4",
                    compactProgress && active && "animate-spin motion-reduce:animate-none",
                    completed
                      ? "text-success"
                      : failed
                        ? "text-destructive"
                        : active
                          ? "text-foreground"
                          : "text-foreground-subtle",
                  )}
                  aria-hidden="true"
                />
              </span>
              <span className="grid min-w-0 gap-1">
                <strong
                  className={cn(
                    "text-ui-base",
                    !compactProgress || active ? "font-medium" : "font-normal",
                  )}
                >
                  {intl.formatMessage({
                    id: SHARE_PHASE_LABEL_IDS[phase],
                  })}
                </strong>
                {!compactProgress || active ? (
                  <span className={cn("text-foreground-subtle", compactProgress && "text-ui-base")}>
                    {phaseDescription}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
