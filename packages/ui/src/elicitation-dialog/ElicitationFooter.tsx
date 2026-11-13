import { Info } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ElicitationFooterProps {
  primaryActionMessageId: string;
  onDismiss: () => void;
  onPrimaryAction: () => void;
}

export function ElicitationFooter({
  primaryActionMessageId,
  onDismiss,
  onPrimaryAction,
}: ElicitationFooterProps) {
  const { intl } = useZCodeIntl();

  return (
    <div
      data-elicitation-dialog-footer="true"
      className="flex shrink-0 items-center justify-between gap-2 px-1 max-sm:flex-wrap"
    >
      <p className="flex min-w-0 flex-1 items-center gap-2 text-ui-base text-foreground-subtle max-sm:basis-full">
        <Info className="size-4 shrink-0 text-foreground" />
        <span className="min-w-0">
          {intl.formatMessage({ id: "chat.elicitation.keyboardHint" })}
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="lg" variant="outline" onClick={onDismiss}>
          {intl.formatMessage({ id: "chat.elicitation.dismiss" })}
        </Button>
        <Button
          type="button"
          size="lg"
          onClick={onPrimaryAction}
          className="bg-brand text-foreground-inverse hover:bg-brand/80"
        >
          {intl.formatMessage({ id: primaryActionMessageId })}
        </Button>
      </div>
    </div>
  );
}
