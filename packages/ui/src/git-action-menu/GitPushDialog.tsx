import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AlertCircleIcon, ArrowUpFromLine, GitBranchIcon, LoaderIcon } from "lucide-react";
import type { GitPushDialogProps } from "./types.js";

export function GitPushDialog({
  open,
  gitSummary,
  currentBranchLabel,
  pushEnabled,
  error,
  mutationPending,
  onOpenChange,
  onSubmit,
}: GitPushDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const [errorCopied, setErrorCopied] = useState(false);
  const descriptionId = gitSummary.trackingBranchName
    ? "git.actionMenu.pushDialog.description.tracked"
    : "git.actionMenu.pushDialog.description.untracked";

  const handleCopyError = useCallback(() => {
    if (!error) {
      return;
    }

    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage(
          { id: "git.actionMenu.pushDialog.error.copyFailed" },
          { error: "clipboard-unavailable" },
        ),
      );
      return;
    }

    void navigator.clipboard.writeText(error).then(
      () => {
        setErrorCopied(true);
        window.setTimeout(() => {
          setErrorCopied(false);
        }, 1500);
      },
      (copyError: unknown) => {
        const message = copyError instanceof Error ? copyError.message : String(copyError);
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.pushDialog.error.copyFailed" },
            { error: message },
          ),
        );
      },
    );
  }, [error, intl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="gap-2 px-6 py-5 pb-0">
          <DialogTitle className="text-lg font-medium text-foreground">
            {intl.formatMessage({ id: "git.actionMenu.pushDialog.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: descriptionId })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 py-6">
          {!error && (
            <div className="rounded-xl bg-background/30">
              <div className="flex items-start justify-between p-4">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.currentBranchLabel",
                  })}
                </div>
                <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                  <GitBranchIcon className="size-4 text-foreground-subtle" />
                  <span>{currentBranchLabel}</span>
                </div>
              </div>

              <div className="space-y-3 border-t border-border/50 p-4 text-ui-base">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.upstreamLabel",
                    })}
                  </div>
                  <div className="text-foreground-subtle">
                    {gitSummary.trackingBranchName
                      ? gitSummary.trackingBranchName
                      : intl.formatMessage({
                          id: "git.actionMenu.pushDialog.upstreamPending",
                        })}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.aheadBehindLabel",
                    })}
                  </div>
                  <div className="text-foreground-subtle">
                    {intl.formatMessage(
                      {
                        id: "git.actionMenu.pushDialog.aheadBehindValue",
                      },
                      {
                        ahead: numberFormatter.format(gitSummary.ahead),
                        behind: numberFormatter.format(gitSummary.behind),
                      },
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-border/50 pt-3">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.pushLabel",
                    })}
                  </div>
                  <div className="flex items-center gap-2 text-foreground-subtle">
                    <ArrowUpFromLine className="size-4" />
                    <span>
                      {intl.formatMessage({
                        id: "git.actionMenu.pushDialog.pushValue",
                      })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!pushEnabled ? (
            <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                {intl.formatMessage({
                  id: "git.actionMenu.pushDialog.upToDate",
                })}
              </span>
            </div>
          ) : null}

          {error ? (
            <>
              <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                <span>
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.error.summary",
                  })}
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.error.detailsLabel",
                    })}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-ui-base text-foreground-subtle hover:text-foreground"
                    onClick={handleCopyError}
                  >
                    {intl.formatMessage({
                      id: errorCopied
                        ? "git.actionMenu.pushDialog.error.copy.copied"
                        : "git.actionMenu.pushDialog.error.copy",
                    })}
                  </Button>
                </div>
                <Textarea
                  // Textarea 默认带 field-sizing-content，长错误文本会按内容扩张并把弹窗横向撑爆。
                  // 这里改成固定尺寸模式，并允许长内容换行，保证错误详情始终被限制在弹窗宽度内。
                  className="field-sizing-fixed w-full max-w-full min-h-56 rounded-lg border-input-border bg-background/50 px-3 py-3 text-ui-base text-foreground whitespace-pre-wrap break-words placeholder:text-foreground-subtlest focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
                  readOnly
                >
                  {error}
                </Textarea>
              </div>
            </>
          ) : null}

          <DialogFooter className="gap-2 pt-4">
            {error ? (
              <Button
                type="button"
                size="lg"
                onClick={() => onOpenChange(false)}
                disabled={mutationPending}
                className="h-10 min-w-0 px-5"
              >
                {intl.formatMessage({ id: "common.close" })}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  onClick={() => onOpenChange(false)}
                  disabled={mutationPending}
                  className="h-10 min-w-0 px-5"
                >
                  {intl.formatMessage({ id: "common.cancel" })}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  onClick={onSubmit}
                  disabled={mutationPending || !pushEnabled}
                  className="h-10 min-w-0 px-5"
                >
                  {mutationPending ? <LoaderIcon className="size-4 animate-spin" /> : null}
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.confirm",
                  })}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
