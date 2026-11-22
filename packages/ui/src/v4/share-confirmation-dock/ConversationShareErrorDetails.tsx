import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveConversationShareIssueMessageId } from "@/lib/conversationShareError.js";
import type { ConversationShareDisplayError } from "@/store/conversationShareSelectionStore.js";
import { buildShareIssueValues } from "./shareIssueValues.js";

export interface ConversationShareErrorDetailsProps {
  error: ConversationShareDisplayError;
  onDeselectTurn?: (productTurnId: string) => void;
  onDismissError?: () => void;
  onCopyRequestId?: () => void;
}

/**
 * 失败明细。
 * 单行 Toast 无法同时承载文件、轮次和限制上限；详情固定留在分享面板，
 * 避免用户丢失修复路径。服务端 request ID 属于诊断信息，按需 Popover 展示。
 */
export function ConversationShareErrorDetails({
  error,
  onDeselectTurn,
  onDismissError,
  onCopyRequestId,
}: ConversationShareErrorDetailsProps) {
  const { intl, locale } = useZCodeIntl();
  const errorDetailsLabel = intl.formatMessage({
    id: "conversationShare.issue.details",
  });

  return (
    <section
      role="alert"
      data-testid="conversation-share-error-details"
      className={cn(
        "mx-4 max-h-40 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/5 text-ui-base text-foreground",
        error.messageId ? "mb-2 p-2" : "mb-3 p-2.5",
      )}
    >
      <div
        data-testid="conversation-share-error-row"
        className={cn(
          "flex justify-between gap-3",
          error.messageId ? "items-center" : "mb-1.5 items-start",
        )}
      >
        <p
          data-testid="conversation-share-error-message"
          className="flex min-w-0 flex-1 items-center gap-1.5 font-medium leading-6"
        >
          <span className="min-w-0 flex-1">
            {error.messageId
              ? intl.formatMessage({ id: error.messageId }, { status: error.status ?? "—" })
              : intl.formatMessage(
                  { id: "conversationShare.error.summary" },
                  { count: error.issueCount },
                )}
          </span>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="conversation-share-request-id-trigger"
                aria-label={errorDetailsLabel}
                title={errorDetailsLabel}
                className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-destructive/30"
              >
                <CircleAlert className="size-4" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="top"
              sideOffset={6}
              collisionPadding={16}
              data-testid="conversation-share-request-id-content"
              className="w-80 max-w-[calc(100vw-1rem)] gap-2 p-3"
            >
              <PopoverTitle className="text-ui-base font-medium">{errorDetailsLabel}</PopoverTitle>
              {(
                [
                  ["HTTP", error.status],
                  [
                    intl.formatMessage({
                      id: "conversationShare.issue.codeLabel",
                    }),
                    error.code,
                  ],
                  [
                    intl.formatMessage({
                      id: "conversationShare.issue.clientRequestIdLabel",
                    }),
                    error.clientRequestId,
                  ],
                  ["operationId", error.operationId],
                  [
                    intl.formatMessage({ id: "conversationShare.issue.ruleLabel" }),
                    error.rejection?.rule,
                  ],
                  [
                    intl.formatMessage({ id: "conversationShare.issue.pathLabel" }),
                    error.rejection?.path,
                  ],
                  [
                    intl.formatMessage({ id: "conversationShare.issue.fieldLabel" }),
                    error.rejection?.field,
                  ],
                  [
                    intl.formatMessage({ id: "conversationShare.issue.rowLabel" }),
                    error.rejection?.row_index === undefined
                      ? undefined
                      : error.rejection.row_index + 1,
                  ],
                  [
                    intl.formatMessage({ id: "conversationShare.issue.rowKindLabel" }),
                    error.rejection?.row_kind,
                  ],
                ] as const
              ).map(([label, value]) =>
                value === undefined ? null : (
                  <p
                    key={label}
                    className="break-all text-ui-sm text-foreground-subtle select-text"
                  >
                    {label}: {value}
                  </p>
                ),
              )}
              {error.requestId ? (
                <div className="grid gap-2">
                  <p className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({
                      id: "conversationShare.issue.requestIdLabel",
                    })}
                  </p>
                  <div className="flex min-w-0 items-start gap-2">
                    <code className="min-w-0 flex-1 break-all font-mono text-ui-base text-foreground select-text">
                      {error.requestId}
                    </code>
                    {onCopyRequestId ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={intl.formatMessage({
                          id: "conversationShare.issue.copyRequestId",
                        })}
                        onClick={onCopyRequestId}
                        className="shrink-0 px-2"
                      >
                        {intl.formatMessage({
                          id: "conversationShare.issue.copyRequestId",
                        })}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({
                    id: "conversationShare.issue.requestIdMissing",
                  })}
                </p>
              )}
            </PopoverContent>
          </Popover>
        </p>
        {onDismissError ? (
          <button
            type="button"
            data-testid="conversation-share-error-dismiss"
            className="shrink-0 text-ui-sm leading-6 text-foreground-subtle underline underline-offset-2"
            onClick={onDismissError}
          >
            {intl.formatMessage({ id: "common.close" })}
          </button>
        ) : null}
      </div>
      {error.messageId ? null : (
        <ul className="grid gap-1.5">
          {error.issues.map((issue, index) => {
            const messageId = resolveConversationShareIssueMessageId(issue);
            const values = buildShareIssueValues(issue, locale);
            return (
              <li key={`${issue.code}-${issue.rowId ?? "global"}-${index}`} className="grid gap-1">
                <p className="leading-5">{intl.formatMessage({ id: messageId }, values)}</p>
                {issue.productTurnId !== undefined && onDeselectTurn ? (
                  <button
                    type="button"
                    className="w-fit text-ui-sm font-medium text-foreground underline underline-offset-2"
                    onClick={() => onDeselectTurn?.(issue.productTurnId!)}
                  >
                    {intl.formatMessage({
                      id: "conversationShare.issue.deselectTurn",
                    })}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {error.omittedIssueCount ? (
        <p className="mt-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "conversationShare.issue.more" },
            { count: error.omittedIssueCount },
          )}
        </p>
      ) : null}
    </section>
  );
}
