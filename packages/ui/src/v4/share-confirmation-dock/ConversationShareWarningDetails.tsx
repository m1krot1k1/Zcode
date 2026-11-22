import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveConversationShareWarningMessageId } from "@/lib/conversationShareError.js";
import type { ConversationShareDisplayWarnings } from "@/store/conversationShareSelectionStore.js";
import { buildShareIssueValues } from "./shareIssueValues.js";

export interface ConversationShareWarningDetailsProps {
  warnings: ConversationShareDisplayWarnings;
  onDismissWarnings?: () => void;
}

/** 发布已成功，只是部分正文引用的文件读不到被跳过；与失败区分开，也不提供「取消该轮」。 */
export function ConversationShareWarningDetails({
  warnings,
  onDismissWarnings,
}: ConversationShareWarningDetailsProps) {
  const { intl, locale } = useZCodeIntl();

  return (
    <section
      role="status"
      data-testid="conversation-share-warning-details"
      className="mx-4 mb-3 max-h-40 overflow-y-auto rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-ui-base text-foreground"
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <p className="font-medium">
          {intl.formatMessage(
            { id: "conversationShare.warning.summary" },
            { count: warnings.issueCount },
          )}
        </p>
        {onDismissWarnings ? (
          <button
            type="button"
            className="shrink-0 text-ui-sm text-foreground-subtle underline underline-offset-2"
            onClick={onDismissWarnings}
          >
            {intl.formatMessage({ id: "common.close" })}
          </button>
        ) : null}
      </div>
      <ul className="grid gap-1.5">
        {warnings.issues.map((issue, index) => (
          <li key={`${issue.code}-${issue.rowId ?? "global"}-${index}`} className="leading-5">
            {intl.formatMessage(
              { id: resolveConversationShareWarningMessageId(issue) },
              buildShareIssueValues(issue, locale),
            )}
          </li>
        ))}
      </ul>
      {warnings.omittedIssueCount ? (
        <p className="mt-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "conversationShare.issue.more" },
            { count: warnings.omittedIssueCount },
          )}
        </p>
      ) : null}
    </section>
  );
}
