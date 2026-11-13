import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ArrowUpFromLine, GitCommitIcon, LoaderIcon } from "lucide-react";
import { TID_GIT_ACTION_TRIGGER, type GitActionMenuTriggerProps } from "./types.js";

export function GitActionMenuTrigger({
  className,
  triggerIconOnly,
  isStatusRowTrigger,
  triggerPending,
  primaryActionId,
  primaryActionDisabled,
  onPrimaryAction,
}: GitActionMenuTriggerProps) {
  const { intl } = useZCodeIntl();

  return (
    <div
      onClick={isStatusRowTrigger && !triggerIconOnly ? onPrimaryAction : undefined}
      className={cn(
        // macOS/Windows 小窗口下，顶部 Git 主按钮的中文文案会和分支入口、窗口控制区挤在同一行。
        // 在 header 容器变窄时只隐藏主按钮文字，保留图标入口，避免丢失核心 Git 操作。
        // transition-all 会把 scrollbar-color 等非合成属性也启动动画，
        // 进而触发整页 UpdateLayoutTree；Git 入口只需要颜色反馈，不动画尺寸和滚动条属性。
        "flex h-7 items-center overflow-hidden rounded-lg border border-border bg-input transition-colors hover:border-border-hover @max-[560px]/workspace-header:w-7 @max-[560px]/workspace-header:justify-center",
        triggerIconOnly && "w-7 justify-center",
        isStatusRowTrigger &&
          "h-8 w-full justify-start rounded-lg border-0 bg-transparent hover:border-transparent hover:bg-hover @max-[560px]/workspace-header:w-full @max-[560px]/workspace-header:justify-start",
        className,
      )}
    >
      <Button
        data-testid={TID_GIT_ACTION_TRIGGER}
        type="button"
        variant="ghost"
        size="default"
        disabled={primaryActionDisabled}
        aria-label={intl.formatMessage({
          id: "git.actionMenu.trigger.ariaLabel",
        })}
        className={cn(
          "h-7 rounded-lg border-0 gap-1 px-1.5 @max-[560px]/workspace-header:w-7 @max-[560px]/workspace-header:px-0 @max-[560px]/workspace-header:[&>span]:hidden",
          triggerIconOnly && "w-7 px-0 [&>span]:hidden",
          isStatusRowTrigger &&
            "h-8 min-w-0 w-full justify-start gap-2 px-2 text-left text-ui-base hover:bg-transparent hover:text-foreground @max-[560px]/workspace-header:w-auto @max-[560px]/workspace-header:[&>span]:inline",
        )}
        onClick={isStatusRowTrigger && !triggerIconOnly ? undefined : onPrimaryAction}
      >
        {/* 主按钮进入 pending 时直接替换左侧动作图标，避免在紧凑头部里额外追加 loading 图标把按钮挤宽。*/}
        {triggerPending ? (
          <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
        ) : primaryActionId === "push" ? (
          <ArrowUpFromLine className="size-4 text-foreground" />
        ) : (
          <GitCommitIcon className="size-4 text-foreground" />
        )}
        <span className={cn(isStatusRowTrigger && "min-w-0 truncate")}>
          {intl.formatMessage({ id: "git.actionMenu.trigger" })}
        </span>
      </Button>
    </div>
  );
}
