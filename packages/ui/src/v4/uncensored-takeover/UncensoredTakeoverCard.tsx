import { useId } from "react";

import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  UncensoredTakeoverCardLabels,
  UncensoredTakeoverCardProps,
  UncensoredTakeoverStatus,
} from "./contract.js";

const STATUS_MESSAGE_IDS = {
  running: "chat.uncensoredTakeover.status.running",
  done: "chat.uncensoredTakeover.status.done",
  refused: "chat.uncensoredTakeover.status.refused",
  error: "chat.uncensoredTakeover.status.error",
  "no-enabled-models": "chat.uncensoredTakeover.status.no-enabled-models",
} as const satisfies Record<UncensoredTakeoverStatus, string>;

// 状态色只表达真实语义：进行中=progress，完成=success，拒绝/配置缺失=warning，
// 失败=destructive；文字状态始终可见，不靠颜色单独传达。
const STATUS_BADGE_CLASS_NAMES = {
  running: "border-transparent bg-progress-surface text-progress-surface-foreground",
  done: "border-transparent bg-success-surface text-success-surface-foreground",
  refused: "border-transparent bg-warning-surface text-warning-surface-foreground",
  error: "border-transparent bg-destructive-surface text-destructive-surface-foreground",
  "no-enabled-models": "border-transparent bg-warning-surface text-warning-surface-foreground",
} as const satisfies Record<UncensoredTakeoverStatus, string>;

function statusLiveRole(status: UncensoredTakeoverStatus): "status" | "alert" | undefined {
  if (status === "running") return "status";
  if (status === "refused" || status === "error") return "alert";
  return undefined;
}

/** 纯展示：只读 takeover 事实；无请求、无 store 写入、无第二份状态。 */
export function UncensoredTakeoverCard({
  takeover,
  labels,
  className,
}: UncensoredTakeoverCardProps) {
  const { intl } = useZCodeIntl();
  const titleId = useId();
  const outputHeadingId = useId();

  const resolvedLabels: UncensoredTakeoverCardLabels = {
    title: labels?.title ?? intl.formatMessage({ id: "chat.uncensoredTakeover.title" }),
    itemLine:
      labels?.itemLine ??
      intl.formatMessage(
        { id: "chat.uncensoredTakeover.item" },
        { index: takeover.itemIndex + 1, text: takeover.itemText },
      ),
    providerLine:
      labels?.providerLine ??
      intl.formatMessage(
        { id: "chat.uncensoredTakeover.provider" },
        { provider: takeover.providerName ?? "—" },
      ),
    modelLine:
      labels?.modelLine ??
      intl.formatMessage(
        { id: "chat.uncensoredTakeover.model" },
        { model: takeover.modelId ?? "—" },
      ),
    reasonLine:
      labels?.reasonLine ??
      (takeover.reason
        ? intl.formatMessage({ id: "chat.uncensoredTakeover.reason" }, { reason: takeover.reason })
        : ""),
    outputLabel:
      labels?.outputLabel ?? intl.formatMessage({ id: "chat.uncensoredTakeover.output" }),
    statusLabel:
      labels?.statusLabel ?? intl.formatMessage({ id: STATUS_MESSAGE_IDS[takeover.status] }),
    noEnabledModelsHint:
      labels?.noEnabledModelsHint ??
      intl.formatMessage({ id: "chat.uncensoredTakeover.noEnabledModels" }),
  };
  const liveRole = statusLiveRole(takeover.status);
  const showNoEnabledModelsHint = takeover.status === "no-enabled-models";
  const showOutput = takeover.output.length > 0;

  return (
    <section
      aria-labelledby={titleId}
      data-takeover-status={takeover.status}
      data-testid="uncensored-takeover-card"
      className={cn(
        "my-2 min-w-0 rounded-xl border border-border bg-card px-4 py-3 text-foreground shadow-none",
        className,
      )}
    >
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id={titleId} className="min-w-0 text-ui-base font-medium">
          {resolvedLabels.title}
        </h3>
        <Badge
          variant="outline"
          role={liveRole}
          data-testid="uncensored-takeover-status"
          className={cn("shrink-0", STATUS_BADGE_CLASS_NAMES[takeover.status])}
        >
          {resolvedLabels.statusLabel}
        </Badge>
      </header>

      <p
        className="mt-2 line-clamp-3 min-w-0 whitespace-pre-wrap break-words wrap-anywhere text-ui-base text-foreground"
        title={takeover.itemText}
        data-testid="uncensored-takeover-item"
      >
        {resolvedLabels.itemLine}
      </p>

      <p
        className="mt-1 min-w-0 break-words wrap-anywhere text-ui-sm text-foreground-subtle"
        data-testid="uncensored-takeover-provider"
      >
        {resolvedLabels.providerLine}
      </p>

      <p className="mt-1 min-w-0 break-words wrap-anywhere text-ui-sm text-foreground-subtle">
        {resolvedLabels.modelLine}
      </p>

      {resolvedLabels.reasonLine ? (
        <p className="mt-1 min-w-0 break-words wrap-anywhere text-ui-sm text-foreground-subtle">
          {resolvedLabels.reasonLine}
        </p>
      ) : null}

      {showNoEnabledModelsHint ? (
        <p className="mt-2 min-w-0 break-words text-ui-sm text-foreground-subtle">
          {resolvedLabels.noEnabledModelsHint}
        </p>
      ) : null}

      {showOutput ? (
        <div className="mt-3 min-w-0">
          <h4 id={outputHeadingId} className="text-ui-sm font-medium text-foreground-subtle">
            {resolvedLabels.outputLabel}
          </h4>
          <div
            role="region"
            aria-labelledby={`${titleId} ${outputHeadingId}`}
            tabIndex={0}
            data-testid="uncensored-takeover-output"
            className="mt-1 max-h-64 min-w-0 overflow-auto overscroll-contain rounded-lg border border-border bg-surface p-2 font-mono text-ui-sm whitespace-pre-wrap break-words wrap-anywhere text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary focus-visible:outline-none"
          >
            {takeover.output}
          </div>
        </div>
      ) : null}
    </section>
  );
}
