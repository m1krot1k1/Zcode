import { Info } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface PermissionDialogFooterProps {
  responseError?: string;
  confirmDisabled: boolean;
  onConfirm: () => void;
}

/** 错误行 + 键盘提示 + 确认按钮：确认按钮的禁用规则由宿主算好，这里只负责呈现。 */
export function PermissionDialogFooter({
  responseError,
  confirmDisabled,
  onConfirm,
}: PermissionDialogFooterProps) {
  const { intl } = useZCodeIntl();

  return (
    <>
      {responseError ? (
        <p role="alert" className="shrink-0 text-ui-base text-destructive">
          {responseError}
        </p>
      ) : null}
      <div className="flex shrink-0 items-center justify-between gap-2 px-1">
        <p className="flex gap-2 text-ui-base items-center text-foreground-subtle">
          <Info className="text-foreground size-4 shrink-0" />
          {intl.formatMessage({ id: "chat.permission.keyboardHint" })}
        </p>
        <Button
          type="button"
          aria-label={intl.formatMessage({ id: "common.confirm" })}
          size="lg"
          onClick={onConfirm}
          disabled={confirmDisabled}
          className="bg-brand text-foreground-inverse hover:bg-brand/80"
        >
          {intl.formatMessage({ id: "common.confirm" })}
        </Button>
      </div>
    </>
  );
}
