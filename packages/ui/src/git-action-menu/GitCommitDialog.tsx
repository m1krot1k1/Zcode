import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Command, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command.js";
import { Dialog, DialogContent } from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { getGitBranchCommitTotals } from "@/git-branch-switcher/display.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { hasGitCommitIdentity } from "@/git-branch-switcher/switchAssist.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatCommandShortcutLabel, matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import {
  AlertCircleIcon,
  CheckIcon,
  CloudUploadIcon,
  GitCommitIcon,
  LoaderIcon,
  SparklesIcon,
} from "lucide-react";
import {
  GIT_COMMIT_MESSAGE_TEXTAREA_ID,
  TID_GIT_COMMIT_ACTION_COMMAND,
  TID_GIT_COMMIT_DIALOG,
  TID_GIT_COMMIT_GENERATE_BUTTON,
  TID_GIT_COMMIT_INCLUDE_UNSTAGED,
  TID_GIT_COMMIT_MESSAGE_INPUT,
  getCommitDialogFiles,
  getCommitDialogStagePaths,
  gitCommitActionItemTestId,
  isCommitDialogActionId,
  isCommitMessageTextAreaTarget,
  type CommitDialogActionId,
  type GitCommitDialogProps,
} from "./types.js";

function CommitCommandActionItem({
  id,
  icon,
  label,
  shortcutLabel,
  disabled,
  loading,
  onSelect,
}: {
  id: CommitDialogActionId;
  icon: ReactNode;
  label: string;
  shortcutLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      data-testid={gitCommitActionItemTestId(id)}
      value={id}
      disabled={disabled}
      onSelect={() => {
        if (!disabled) {
          onSelect();
        }
      }}
      className={cn(
        "h-9 px-2.5 py-1.5 font-medium",
        disabled ? "cursor-default text-foreground-subtlest" : "text-foreground",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {loading ? <LoaderIcon className="size-4 animate-spin" /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
    </CommandItem>
  );
}

export function GitCommitDialog({
  open,
  loading,
  state,
  workspacePath,
  message,
  error,
  mutationPending,
  generationPending,
  includeUnstaged,
  pushEnabled,
  onRefreshGit,
  onOpenChange,
  onMessageChange,
  onIncludeUnstagedChange,
  onGenerateMessage,
  onSubmit,
  onSubmitAndPush,
  onPushOnly,
}: GitCommitDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const [selectedActionId, setSelectedActionId] = useState<CommitDialogActionId>("commit");
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageInputFocusedOnOpenRef = useRef(false);
  const numberFormatter = new Intl.NumberFormat(locale);
  const hasIdentity = hasGitCommitIdentity(state?.identity ?? null);
  const messageReady = message.trim().length > 0;
  const actionPending = mutationPending || generationPending;
  const selectedFiles = state ? getCommitDialogFiles(state, includeUnstaged) : [];
  const stagePaths = state ? getCommitDialogStagePaths(state, includeUnstaged) : [];
  const dirtyFileCount = state ? getCommitDialogStagePaths(state, true).length : 0;
  const { fileCount, totalAdded, totalRemoved } = getGitBranchCommitTotals(selectedFiles);
  const displayChangeSummary = state?.activeTaskChangeSummary ?? null;
  const displayAdded = displayChangeSummary?.added ?? totalAdded;
  const displayRemoved = displayChangeSummary?.removed ?? totalRemoved;
  const hasSelectedChanges = stagePaths.length > 0;
  const hasUnstagedChanges = Boolean(state?.unstagedFiles.length);
  const commitActionDisabled =
    actionPending || !hasSelectedChanges || (!hasIdentity && state?.identity !== null);
  const pushOnlyDisabled = actionPending || !pushEnabled;
  const commitShortcutLabel = formatCommandShortcutLabel("⏎");
  const commitActions = useMemo(
    () => [
      {
        id: "commit" as const,
        icon: <GitCommitIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.commitDialog.action.commit",
        }),
        disabled: commitActionDisabled,
        loading: mutationPending,
        onSelect: onSubmit,
      },
      {
        id: "commitAndPush" as const,
        icon: <CloudUploadIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.commitDialog.action.commitAndPush",
        }),
        disabled: commitActionDisabled,
        loading: mutationPending,
        onSelect: onSubmitAndPush,
      },
      {
        id: "push" as const,
        icon: <CloudUploadIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.push",
        }),
        disabled: pushOnlyDisabled,
        loading: false,
        onSelect: onPushOnly,
      },
    ],
    [
      commitActionDisabled,
      intl,
      mutationPending,
      onPushOnly,
      onSubmit,
      onSubmitAndPush,
      pushOnlyDisabled,
    ],
  );

  useEffect(() => {
    if (open) {
      setSelectedActionId("commit");
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      messageInputFocusedOnOpenRef.current = false;
      return;
    }
    if (loading || !state || actionPending || messageInputFocusedOnOpenRef.current) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      // 打开弹窗后的默认焦点要落在提交信息里，方便立即编辑或生成后微调。
      messageTextareaRef.current?.focus();
      messageInputFocusedOnOpenRef.current = true;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [actionPending, loading, open, state]);

  useEffect(() => {
    // 弹窗加载 Git 状态前提交动作会短暂不可用，不能在 loading 阶段把默认选择跳到推送。
    if (!open || loading || !state || actionPending) {
      return;
    }

    const selectedAction = commitActions.find((action) => action.id === selectedActionId);
    if (selectedAction && !selectedAction.disabled) {
      return;
    }

    const firstEnabledAction = commitActions.find((action) => !action.disabled);
    if (firstEnabledAction && firstEnabledAction.id !== selectedActionId) {
      setSelectedActionId(firstEnabledAction.id);
    }
  }, [actionPending, commitActions, loading, open, selectedActionId, state]);

  const triggerSelectedAction = useCallback(() => {
    const selectedAction = commitActions.find((action) => action.id === selectedActionId);
    if (!selectedAction || selectedAction.disabled) {
      return;
    }
    selectedAction.onSelect();
  }, [commitActions, selectedActionId]);

  const selectAdjacentAction = useCallback(
    (direction: 1 | -1) => {
      setSelectedActionId((currentActionId) => {
        const enabledActions = commitActions.filter((action) => !action.disabled);
        if (enabledActions.length === 0) {
          return currentActionId;
        }

        const currentIndex = enabledActions.findIndex((action) => action.id === currentActionId);
        if (currentIndex === -1) {
          return enabledActions[0]?.id ?? currentActionId;
        }

        const nextIndex =
          (currentIndex + direction + enabledActions.length) % enabledActions.length;
        return enabledActions[nextIndex]?.id ?? currentActionId;
      });
    },
    [commitActions],
  );

  const handleActionCommandKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      selectAdjacentAction(event.key === "ArrowDown" ? 1 : -1);
    },
    [selectAdjacentAction],
  );

  const handleDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLFormElement>) => {
      if (
        isCommitMessageTextAreaTarget(event.target) &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        // 输入框保持焦点时也允许切换下方 Command 操作，避免键盘流断掉。
        event.preventDefault();
        event.stopPropagation();
        selectAdjacentAction(event.key === "ArrowDown" ? 1 : -1);
        return;
      }

      if (!matchesPrimaryShortcut(event, "Enter")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      triggerSelectedAction();
    },
    [selectAdjacentAction, triggerSelectedAction],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID_GIT_COMMIT_DIALOG}
        showCloseButton={false}
        className="max-w-md gap-0 overflow-hidden border-popover-border bg-popover p-0 shadow-lg"
        onOpenAutoFocus={(event) => {
          if (!loading && state && !actionPending) {
            event.preventDefault();
          }
        }}
      >
        {loading ? (
          <div className="flex h-56 items-center justify-center px-5 py-5 text-foreground-subtle">
            <LoaderIcon className="size-5 animate-spin" />
          </div>
        ) : state ? (
          <form
            className="space-y-0"
            onKeyDownCapture={handleDialogKeyDown}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              triggerSelectedAction();
            }}
          >
            <div className="flex min-w-0 items-center justify-between gap-3 px-4 py-3">
              <GitBranchSwitcher
                workspacePath={workspacePath}
                gitSummary={state.summary}
                dirtyFileCount={dirtyFileCount}
                onRefreshGit={onRefreshGit}
                className="min-w-0 px-0 pt-0"
                triggerClassName="h-7 max-w-64 justify-start rounded-lg px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground [&>span]:max-w-48"
                popoverSide="bottom"
                popoverClassName="w-80"
                branchListClassName="max-h-56"
                showFooterActions={false}
              />
              <div className="flex shrink-0 items-center gap-1.5 font-mono text-ui-base">
                <span className="text-diff-added">+{numberFormatter.format(displayAdded)}</span>
                <span className="text-diff-removed">-{numberFormatter.format(displayRemoved)}</span>
              </div>
            </div>

            <div className="min-h-36 px-4 pb-2">
              <label htmlFor={GIT_COMMIT_MESSAGE_TEXTAREA_ID} className="sr-only">
                {intl.formatMessage({
                  id: "git.actionMenu.commitDialog.messageLabel",
                })}
              </label>
              <div className="relative">
                <Textarea
                  ref={messageTextareaRef}
                  data-testid={TID_GIT_COMMIT_MESSAGE_INPUT}
                  id={GIT_COMMIT_MESSAGE_TEXTAREA_ID}
                  value={message}
                  disabled={actionPending}
                  placeholder={intl.formatMessage({
                    id: "git.actionMenu.commitDialog.messagePlaceholder",
                  })}
                  className="field-sizing-fixed min-h-28 rounded-none border-0 bg-transparent px-0 py-2 pr-8 text-ui-base font-medium text-foreground shadow-none placeholder:text-foreground-subtle focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0 md:text-ui-base"
                  onChange={(event) => {
                    onMessageChange(event.target.value);
                  }}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      data-testid={TID_GIT_COMMIT_GENERATE_BUTTON}
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={onGenerateMessage}
                      disabled={
                        actionPending ||
                        !hasSelectedChanges ||
                        (!hasIdentity && state.identity !== null)
                      }
                      aria-label={intl.formatMessage({
                        id: messageReady
                          ? "git.actionMenu.commitDialog.regenerate"
                          : "git.actionMenu.commitDialog.generate",
                      })}
                      className="absolute right-0 top-1.5 text-foreground-subtle hover:text-foreground"
                    >
                      {generationPending ? (
                        <LoaderIcon className="size-4 animate-spin" />
                      ) : (
                        <SparklesIcon className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="end" sideOffset={6}>
                    {intl.formatMessage({
                      id: messageReady
                        ? "git.actionMenu.commitDialog.regenerate"
                        : "git.actionMenu.commitDialog.generate",
                    })}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="px-2.5 pb-2">
              <button
                type="button"
                role="checkbox"
                data-testid={TID_GIT_COMMIT_INCLUDE_UNSTAGED}
                aria-checked={includeUnstaged}
                disabled={actionPending || !hasUnstagedChanges}
                onClick={() => onIncludeUnstagedChange(!includeUnstaged)}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-ui-base font-medium transition-colors",
                  actionPending || !hasUnstagedChanges
                    ? "cursor-default text-foreground-subtle"
                    : "cursor-pointer text-foreground hover:bg-menu-hover",
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-sm border",
                      includeUnstaged
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-transparent",
                    )}
                  >
                    <CheckIcon className="size-3.5" />
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {intl.formatMessage({
                    id: "git.actionMenu.commitDialog.includeUnstaged",
                  })}
                </span>
                <span className="shrink-0 text-ui-base font-normal text-foreground-subtle">
                  {intl.formatMessage(
                    {
                      id: "git.actionMenu.commitDialog.changesValue",
                    },
                    {
                      count: numberFormatter.format(fileCount),
                    },
                  )}
                </span>
              </button>
            </div>

            <div className="border-t border-border/50 px-2.5 py-2">
              {!hasIdentity ? (
                <div className="mb-1.5 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-base text-warning">
                  <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                  <p>
                    {intl.formatMessage({
                      id: "git.actionMenu.commitDialog.identityMissing",
                    })}
                  </p>
                </div>
              ) : null}

              {error ? <p className="px-3 py-1.5 text-ui-base text-destructive">{error}</p> : null}

              <Command
                data-testid={TID_GIT_COMMIT_ACTION_COMMAND}
                shouldFilter={false}
                loop
                tabIndex={0}
                value={selectedActionId}
                onValueChange={(nextValue) => {
                  if (isCommitDialogActionId(nextValue)) {
                    setSelectedActionId(nextValue);
                  }
                }}
                onKeyDown={handleActionCommandKeyDown}
                aria-label={intl.formatMessage({
                  id: "git.actionMenu.trigger.ariaLabel",
                })}
                className="rounded-none bg-transparent p-0 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              >
                <CommandList className="max-h-none scroll-py-1">
                  {commitActions.map((action) => (
                    <CommitCommandActionItem
                      key={action.id}
                      id={action.id}
                      icon={action.icon}
                      label={action.label}
                      shortcutLabel={
                        selectedActionId === action.id ? commitShortcutLabel : undefined
                      }
                      disabled={action.disabled}
                      loading={action.loading}
                      onSelect={action.onSelect}
                    />
                  ))}
                </CommandList>
              </Command>
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
