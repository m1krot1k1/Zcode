import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import {
  buildGitBranchCommitPreviewFiles,
  resolveGitBranchTriggerLabel,
} from "@/git-branch-switcher/display.js";
import { hasGitCommitIdentity } from "@/git-branch-switcher/switchAssist.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import {
  canPushGitBranch,
  canUseGitActionMenu,
  resolveGitActionMenuPrimaryAction,
} from "./display.js";
import {
  filterCommitPreviewFilesByCurrentSession,
  getCurrentSessionFilePaths,
} from "./currentSessionFileScope.js";
import {
  getCommitDialogFiles,
  getCommitDialogStagePaths,
  type GitActionMenuProps,
  type GitCommitDialogState,
} from "./types.js";

/**
 * GitActionMenu 的唯一状态所有者：commit / push 弹窗的 open、加载态、错误、
 * pending 标记，以及提交/推送/主入口动作。
 *
 * 只做状态与副作用编排，渲染由 GitActionMenuTrigger、GitCommitDialog、
 * GitPushDialog 承担；hook 顺序与 memo/useCallback 依赖保持拆分前一致。
 */
export function useGitActionMenuController({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  activeTaskChangeSummary = null,
  commitMessageConversationContext = null,
  onRefreshGit,
  className,
  triggerIconOnly = false,
  triggerLayout = "header",
}: GitActionMenuProps) {
  const { gitService } = useServices();
  const { intl, locale } = useZCodeIntl();
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitDialogLoading, setCommitDialogLoading] = useState(false);
  const [commitDialogState, setCommitDialogState] = useState<GitCommitDialogState | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitIncludeUnstaged, setCommitIncludeUnstaged] = useState(true);
  const [commitMessageGenerationPending, setCommitMessageGenerationPending] = useState(false);
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);

  const actionAvailable = canUseGitActionMenu(gitSummary);
  const currentBranchLabel = useMemo(
    () =>
      resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: gitSummary.branchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      }),
    [gitSummary.branchName, gitSummary.headRefType, intl],
  );
  const commitEnabled = gitSummary.isDirty;
  const pushEnabled = canPushGitBranch(gitSummary);
  const triggerPending = mutationPending || commitMessageGenerationPending || commitDialogLoading;
  const primaryActionId = useMemo(
    () =>
      resolveGitActionMenuPrimaryAction({
        actionAvailable,
        commitEnabled,
        pushEnabled,
      }),
    [actionAvailable, commitEnabled, pushEnabled],
  );
  const primaryActionDisabled = !actionAvailable || triggerPending || primaryActionId === null;
  const isStatusRowTrigger = triggerLayout === "status-row";

  useEffect(() => {
    // 顶部 commit 入口改成“始终展示、异常时置灰”后，
    // 这里记录低频可用性日志，方便继续区分是仓库探测失败，
    // 还是 UI 交互本身出现了禁用/启用状态不一致。
    logger.info("[GitActionMenu] 顶部 Git 操作入口可用性变化", {
      workspacePath,
      available: actionAvailable,
      primaryActionDisabled,
      primaryActionId,
      isGitAvailable: gitSummary.isGitAvailable,
      isRepository: gitSummary.isRepository,
      headRefType: gitSummary.headRefType,
      branchName: gitSummary.branchName,
      trackingBranchName: gitSummary.trackingBranchName,
      isDirty: gitSummary.isDirty,
    });
  }, [
    gitSummary.branchName,
    gitSummary.headRefType,
    gitSummary.isDirty,
    gitSummary.isGitAvailable,
    gitSummary.isRepository,
    gitSummary.trackingBranchName,
    actionAvailable,
    primaryActionId,
    primaryActionDisabled,
    workspacePath,
  ]);

  const closeCommitDialog = useCallback(() => {
    setCommitDialogOpen(false);
    setCommitDialogLoading(false);
    setCommitDialogState(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitIncludeUnstaged(true);
    setCommitMessageGenerationPending(false);
  }, []);

  const closePushDialog = useCallback(() => {
    setPushDialogOpen(false);
    setPushError(null);
  }, []);

  const openPushDialog = useCallback(() => {
    setPushError(null);
    setPushDialogOpen(true);
  }, []);

  const loadCommitDialogState = useCallback(
    async (options?: { resetMessage?: boolean }) => {
      setCommitDialogLoading(true);
      setCommitError(null);
      if (options?.resetMessage) {
        setCommitMessage("");
      }

      try {
        const refreshResult = await gitService.refresh({
          workspacePath,
          includeIdentity: true,
        });
        const rawUnstagedFiles = buildGitBranchCommitPreviewFiles(refreshResult.unstagedChanges);
        const rawStagedFiles = buildGitBranchCommitPreviewFiles(refreshResult.stagedChanges);
        const unstagedFiles = filterCommitPreviewFilesByCurrentSession({
          files: rawUnstagedFiles,
          summary: activeTaskChangeSummary,
          gitSummary: refreshResult.summary,
          workspacePath,
        });
        const stagedFiles = filterCommitPreviewFilesByCurrentSession({
          files: rawStagedFiles,
          summary: activeTaskChangeSummary,
          gitSummary: refreshResult.summary,
          workspacePath,
        });
        setCommitDialogState({
          summary: refreshResult.summary,
          activeTaskChangeSummary,
          identity: refreshResult.identity,
          stagedFiles,
          unstagedFiles,
        });
        setCommitIncludeUnstaged(unstagedFiles.length > 0);
        setCommitDialogLoading(false);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitActionMenu] 读取提交弹窗状态失败", {
          workspacePath,
          error: message,
        });
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.commitDialog.error.requestFailed" },
            { error: message },
          ),
        );
        closeCommitDialog();
      }
    },
    [activeTaskChangeSummary, closeCommitDialog, gitService, intl, workspacePath],
  );

  const openCommitDialog = useCallback(async () => {
    setCommitDialogOpen(true);
    setCommitDialogState(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitIncludeUnstaged(true);
    await loadCommitDialogState({ resetMessage: true });
  }, [loadCommitDialogState]);

  const refreshCommitDialogAfterBranchChange = useCallback(() => {
    onRefreshGit();
    void loadCommitDialogState({ resetMessage: true });
  }, [loadCommitDialogState, onRefreshGit]);

  const generateCommitMessage = useCallback(
    async (state: GitCommitDialogState, includeUnstaged: boolean): Promise<string> => {
      const files = getCommitDialogFiles(state, includeUnstaged);
      const currentSessionFilePaths = getCurrentSessionFilePaths(state.activeTaskChangeSummary);
      logger.info("[GitActionMenu] 开始生成提交消息", {
        workspacePath,
        branchName: gitSummary.branchName,
        selectedFileCount: files.length,
        currentSessionFileCount: currentSessionFilePaths?.length ?? 0,
        includeUnstaged,
        conversationMessageCount: commitMessageConversationContext?.messages.length ?? 0,
      });

      const result = await gitService.generateCommitMessage({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        locale,
        includeUnstaged,
        ...(currentSessionFilePaths ? { currentSessionFilePaths } : {}),
        ...(commitMessageConversationContext
          ? { conversationContext: commitMessageConversationContext }
          : {}),
      });

      logger.info("[GitActionMenu] 提交消息生成成功", {
        workspacePath,
        branchName: gitSummary.branchName,
        providerId: result.providerId,
        model: result.model,
      });
      return result.message;
    },
    [
      commitMessageConversationContext,
      gitService,
      gitSummary.branchName,
      locale,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleGenerateCommitMessage = useCallback(async () => {
    if (!commitDialogState) {
      return;
    }

    const stagePaths = getCommitDialogStagePaths(commitDialogState, commitIncludeUnstaged);
    if (stagePaths.length === 0) {
      setCommitError(
        intl.formatMessage({
          id: "git.actionMenu.commitDialog.error.noChanges",
        }),
      );
      return;
    }

    setCommitError(null);
    setCommitMessageGenerationPending(true);

    try {
      const nextCommitMessage = await generateCommitMessage(
        commitDialogState,
        commitIncludeUnstaged,
      );
      setCommitMessage(nextCommitMessage);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitActionMenu] 生成提交消息失败", {
        workspacePath,
        branchName: gitSummary.branchName,
        error: message,
      });
      setCommitError(
        intl.formatMessage({
          id: "git.actionMenu.commitDialog.error.generateFailed",
        }),
      );
    } finally {
      setCommitMessageGenerationPending(false);
    }
  }, [
    commitIncludeUnstaged,
    commitDialogState,
    generateCommitMessage,
    gitSummary.branchName,
    intl,
    workspacePath,
  ]);

  const pushCurrentBranch = useCallback(
    async (options?: { showToast?: boolean }) => {
      const result = await gitService.push({ workspacePath });
      logger.info("[GitActionMenu] 推送更改成功", {
        workspacePath,
        branchName: result.branchName,
        trackingBranchName: result.trackingBranchName,
        remoteName: result.remoteName,
        setUpstream: result.setUpstream,
      });
      if (options?.showToast !== false) {
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.pushDialog.toast.success" },
            {
              target:
                result.trackingBranchName?.trim() ||
                result.branchName?.trim() ||
                currentBranchLabel,
            },
          ),
        );
      }
      return result;
    },
    [currentBranchLabel, gitService, intl, workspacePath],
  );

  const handleCommitAction = useCallback(
    async (options?: { pushAfterCommit?: boolean }) => {
      if (!commitDialogState) {
        return;
      }

      if (!hasGitCommitIdentity(commitDialogState.identity)) {
        setCommitError(
          intl.formatMessage({
            id: "git.actionMenu.commitDialog.identityMissing",
          }),
        );
        return;
      }

      const includeUnstaged = commitIncludeUnstaged;
      const stagePaths = getCommitDialogStagePaths(commitDialogState, includeUnstaged);
      const pathsToStage = includeUnstaged ? stagePaths : [];
      if (stagePaths.length === 0) {
        setCommitError(
          intl.formatMessage({
            id: "git.actionMenu.commitDialog.error.noChanges",
          }),
        );
        return;
      }

      let nextCommitMessage = commitMessage.trim();
      if (!nextCommitMessage) {
        setCommitError(null);
        setCommitMessageGenerationPending(true);
        try {
          nextCommitMessage = await generateCommitMessage(commitDialogState, includeUnstaged);
          setCommitMessage(nextCommitMessage);
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          logger.warn("[GitActionMenu] 生成提交消息失败", {
            workspacePath,
            branchName: gitSummary.branchName,
            error: message,
          });
          setCommitError(
            intl.formatMessage({
              id: "git.actionMenu.commitDialog.error.generateFailed",
            }),
          );
          return;
        } finally {
          setCommitMessageGenerationPending(false);
        }
      }

      setCommitError(null);
      setMutationPending(true);
      let committed = false;

      try {
        logger.info("[GitActionMenu] 开始提交当前更改", {
          workspacePath,
          branchName: gitSummary.branchName,
          selectedPathCount: stagePaths.length,
          stagedPathCount: pathsToStage.length,
          includeUnstaged,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        if (pathsToStage.length > 0) {
          await gitService.stagePaths({
            workspacePath,
            paths: pathsToStage,
          });
        }
        await gitService.commit({
          workspacePath,
          message: nextCommitMessage,
          paths: stagePaths,
          stagedOnly: !includeUnstaged,
        });
        committed = true;

        if (options?.pushAfterCommit) {
          await pushCurrentBranch({ showToast: false });
        }

        logger.info("[GitActionMenu] 提交当前更改成功", {
          workspacePath,
          branchName: gitSummary.branchName,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        toast(
          intl.formatMessage({
            id: options?.pushAfterCommit
              ? "git.actionMenu.commitDialog.toast.commitAndPushSuccess"
              : "git.actionMenu.commitDialog.toast.success",
          }),
        );
        closeCommitDialog();
        onRefreshGit();
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitActionMenu] 提交当前更改失败", {
          workspacePath,
          error: message,
          committed,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        setCommitError(
          intl.formatMessage(
            {
              id:
                committed && options?.pushAfterCommit
                  ? "git.actionMenu.commitDialog.error.pushAfterCommitFailed"
                  : "git.actionMenu.commitDialog.error.requestFailed",
            },
            { error: message },
          ),
        );
        if (committed) {
          onRefreshGit();
        }
      } finally {
        setMutationPending(false);
      }
    },
    [
      closeCommitDialog,
      commitIncludeUnstaged,
      commitDialogState,
      commitMessage,
      generateCommitMessage,
      gitService,
      gitSummary.branchName,
      intl,
      onRefreshGit,
      pushCurrentBranch,
      workspacePath,
    ],
  );

  const handleCommitSubmit = useCallback(async () => {
    await handleCommitAction();
  }, [handleCommitAction]);

  const handleCommitAndPushSubmit = useCallback(async () => {
    await handleCommitAction({ pushAfterCommit: true });
  }, [handleCommitAction]);

  const handlePushSubmit = useCallback(async () => {
    if (!pushEnabled) {
      return;
    }

    setMutationPending(true);
    setPushError(null);

    try {
      await pushCurrentBranch();
      closePushDialog();
      onRefreshGit();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitActionMenu] 推送更改失败", {
        workspacePath,
        error: message,
      });
      setPushError(
        intl.formatMessage(
          { id: "git.actionMenu.pushDialog.error.requestFailed" },
          { error: message },
        ),
      );
    } finally {
      setMutationPending(false);
    }
  }, [closePushDialog, intl, onRefreshGit, pushCurrentBranch, pushEnabled, workspacePath]);

  const handlePrimaryAction = useCallback(() => {
    if (primaryActionDisabled) {
      return;
    }

    runUserAction({
      input: { featureId: "workbench.git", action: "open", trigger: "button" },
      operation: () => {
        if (primaryActionId === "push") {
          openPushDialog();
          return;
        }
        void openCommitDialog();
      },
      completed: { resultSource: "local_commit" },
      failureStage: "git_action_open",
    });
  }, [openCommitDialog, openPushDialog, primaryActionId, primaryActionDisabled]);

  return {
    trigger: {
      className,
      triggerIconOnly,
      isStatusRowTrigger,
      triggerPending,
      primaryActionId,
      primaryActionDisabled,
      onPrimaryAction: handlePrimaryAction,
    },
    commitDialog: {
      open: commitDialogOpen,
      loading: commitDialogLoading,
      state: commitDialogState,
      workspacePath,
      message: commitMessage,
      error: commitError,
      mutationPending,
      generationPending: commitMessageGenerationPending,
      includeUnstaged: commitIncludeUnstaged,
      pushEnabled,
      onRefreshGit: refreshCommitDialogAfterBranchChange,
      onOpenChange: (nextOpen: boolean) => {
        if (!nextOpen) {
          closeCommitDialog();
        }
      },
      onMessageChange: setCommitMessage,
      onIncludeUnstagedChange: setCommitIncludeUnstaged,
      onGenerateMessage: () => {
        void handleGenerateCommitMessage();
      },
      onSubmit: () => {
        void handleCommitSubmit();
      },
      onSubmitAndPush: () => {
        void handleCommitAndPushSubmit();
      },
      onPushOnly: () => {
        closeCommitDialog();
        openPushDialog();
      },
    },
    pushDialog: {
      open: pushDialogOpen,
      gitSummary,
      currentBranchLabel,
      pushEnabled,
      error: pushError,
      mutationPending,
      onOpenChange: (nextOpen: boolean) => {
        if (!nextOpen) {
          closePushDialog();
        }
      },
      onSubmit: () => {
        void handlePushSubmit();
      },
    },
  };
}
