import { EyeIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";

interface HighspeedOutputFooterProps {
  generatedLabel: string;
  shareLabel: string;
  shareAriaLabel: string;
  shareEnabled: boolean;
  sharePending: boolean;
  onShare: () => void;
}

/** Highspeed 轮尾的「生成完毕」分隔线与分享入口。 */
export function HighspeedOutputFooter({
  generatedLabel,
  shareLabel,
  shareAriaLabel,
  shareEnabled,
  sharePending,
  onShare,
}: HighspeedOutputFooterProps) {
  return (
    <div
      data-highspeed-output-footer="true"
      className="relative flex w-full items-center justify-center py-[18px] opacity-80"
    >
      <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-border" />
      <div className="relative flex items-center gap-2 bg-background px-3">
        <span className="text-ui-base text-foreground-subtle">{generatedLabel}</span>
        {shareEnabled ? (
          <Button
            type="button"
            variant="ghost"
            size="default"
            className="h-7 gap-1 rounded-[8px] bg-black/5 px-2 py-1 text-ui-base font-medium leading-5 text-foreground hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
            data-highspeed-output-share="true"
            disabled={sharePending}
            aria-label={shareAriaLabel}
            onClick={onShare}
          >
            <EyeIcon
              className="size-4 text-foreground/85"
              strokeWidth={4 / 3}
              aria-hidden="true"
              data-highspeed-output-share-icon="true"
            />
            {shareLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
