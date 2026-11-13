import type { RefObject } from "react";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ConversationShareDisclosureSectionProps {
  disclosureRef: RefObject<HTMLElement | null>;
  checkboxRef: RefObject<HTMLButtonElement | null>;
  reviewRowRef: RefObject<HTMLLabelElement | null>;
  disclosureAccepted: boolean;
  invalidDisclosure: boolean;
  onAcceptedChange: (accepted: boolean) => void;
}

/**
 * 敏感信息确认区。
 * 设计原因：确认需要保留警示语义，但把详细检查范围收进锚定浮层，
 * 避免确认 dock 被长文案撑高。refs 由宿主持有，用于滚动到确认行与抖动提示。
 */
export function ConversationShareDisclosureSection({
  disclosureRef,
  checkboxRef,
  reviewRowRef,
  disclosureAccepted,
  invalidDisclosure,
  onAcceptedChange,
}: ConversationShareDisclosureSectionProps) {
  const { intl } = useZCodeIntl();

  return (
    <section
      ref={disclosureRef}
      data-testid="conversation-share-disclosure"
      role="note"
      className={cn("mx-3 mt-3 text-ui-sm text-foreground", "py-1")}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div
            data-testid="conversation-share-disclosure-content-row"
            className={cn("flex min-w-0 gap-y-1", "flex-col items-start")}
          >
            <label
              ref={reviewRowRef}
              className={cn(
                "flex min-w-0 items-start gap-2 text-ui-base",
                invalidDisclosure && "text-warning",
              )}
            >
              <Checkbox
                ref={checkboxRef}
                data-testid="conversation-share-disclosure-checkbox"
                aria-invalid={invalidDisclosure}
                checked={disclosureAccepted}
                onCheckedChange={(checked) => {
                  onAcceptedChange(checked === true);
                }}
                className="mt-0.5"
              />
              <span className={"leading-5"}>
                {intl.formatMessage({
                  id: "conversationShare.disclosure.checkbox",
                })}
              </span>
            </label>
            <div
              data-testid="conversation-share-disclosure-supporting-row"
              className={cn(
                "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm leading-5",
                "pl-6",
              )}
            >
              <span
                data-testid="conversation-share-disclosure-description"
                className="min-w-0 text-ui-sm leading-5 text-foreground-subtle"
              >
                {intl.formatMessage({
                  id: "conversationShare.disclosure.description",
                })}
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-testid="conversation-share-disclosure-scope-trigger"
                    className="inline-flex shrink-0 items-center text-ui-sm leading-5 text-foreground-subtle underline underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {intl.formatMessage({
                      id: "conversationShare.disclosure.scope.trigger",
                    })}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="end"
                  data-testid="conversation-share-disclosure-scope-content"
                  className="w-[22.5rem] max-w-[calc(100vw-1rem)] max-h-(--radix-popover-content-available-height) gap-3 overflow-y-auto border-popover-border p-3"
                >
                  <PopoverTitle className="text-ui-base font-medium">
                    {intl.formatMessage({ id: "conversationShare.disclosure.scope.title" })}
                  </PopoverTitle>
                  <div className="grid gap-1">
                    <p className="text-ui-sm font-medium text-foreground-subtle">
                      {intl.formatMessage({
                        id: "conversationShare.disclosure.scope.reviewLabel",
                      })}
                    </p>
                    <ul className="grid gap-1 text-ui-base">
                      {(["conversation", "tools", "generated"] as const).map((scope) => (
                        <li key={scope}>
                          {intl.formatMessage({
                            id: `conversationShare.disclosure.scope.${scope}`,
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="grid gap-1">
                    <p className="text-ui-sm font-medium text-foreground-subtle">
                      {intl.formatMessage({
                        id: "conversationShare.disclosure.scope.sensitiveLabel",
                      })}
                    </p>
                    <p className="text-ui-base">
                      {intl.formatMessage({
                        id: "conversationShare.disclosure.scope.sensitive",
                      })}
                    </p>
                  </div>
                  <p className="text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "conversationShare.disclosure.scope.note" })}
                  </p>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
