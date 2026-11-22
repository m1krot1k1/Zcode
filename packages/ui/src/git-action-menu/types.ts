/**
 * GitActionMenu 的共享类型、test id 与提交弹窗的文件投影工具。
 *
 * 对外 props、提交/推送弹窗 props、trigger props 都从这里取，避免子文件重复声明。
 */
import type {
  GitCommitMessageConversationContext,
  GitIdentity,
  GitRepositorySummary,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import type { GitBranchCommitPreviewFile } from "@/git-branch-switcher/display.js";

export interface GitActionMenuProps {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  commitMessageConversationContext?: GitCommitMessageConversationContext | null;
  onRefreshGit: () => void;
  className?: string;
  triggerIconOnly?: boolean;
  triggerLayout?: "header" | "status-row";
}

export type GitCommitPreviewFile = GitBranchCommitPreviewFile;

export const COMMIT_DIALOG_ACTION_IDS = ["commit", "commitAndPush", "push"] as const;
export const GIT_COMMIT_MESSAGE_TEXTAREA_ID = "git-action-menu-commit-message";
export const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
export const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
export const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
export const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
export const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
export const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
export const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";

export type CommitDialogActionId = (typeof COMMIT_DIALOG_ACTION_IDS)[number];
export type GitActionMenuPrimaryActionId = "commit" | "push";

export function gitCommitActionItemTestId(actionId: CommitDialogActionId): string {
  return `${TID_GIT_COMMIT_ACTION_ITEM}-${actionId}`;
}

export function isCommitDialogActionId(value: string): value is CommitDialogActionId {
  return COMMIT_DIALOG_ACTION_IDS.includes(value as CommitDialogActionId);
}

export function isCommitMessageTextAreaTarget(
  target: EventTarget | null,
): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement && target.id === GIT_COMMIT_MESSAGE_TEXTAREA_ID;
}

export interface GitCommitDialogState {
  summary: GitRepositorySummary;
  identity: GitIdentity | null;
  activeTaskChangeSummary: ZCodeTaskChangeSummary | null;
  stagedFiles: GitCommitPreviewFile[];
  unstagedFiles: GitCommitPreviewFile[];
}

export interface GitCommitDialogProps {
  open: boolean;
  loading: boolean;
  state: GitCommitDialogState | null;
  workspacePath: string;
  message: string;
  error: string | null;
  mutationPending: boolean;
  generationPending: boolean;
  includeUnstaged: boolean;
  pushEnabled: boolean;
  onRefreshGit: () => void;
  onOpenChange: (nextOpen: boolean) => void;
  onMessageChange: (nextValue: string) => void;
  onIncludeUnstagedChange: (nextValue: boolean) => void;
  onGenerateMessage: () => void;
  onSubmit: () => void;
  onSubmitAndPush: () => void;
  onPushOnly: () => void;
}

export interface GitPushDialogProps {
  open: boolean;
  gitSummary: GitRepositorySummary;
  currentBranchLabel: string;
  pushEnabled: boolean;
  error: string | null;
  mutationPending: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onSubmit: () => void;
}

export interface GitActionMenuTriggerProps {
  className?: string;
  triggerIconOnly: boolean;
  isStatusRowTrigger: boolean;
  triggerPending: boolean;
  primaryActionId: GitActionMenuPrimaryActionId | null;
  primaryActionDisabled: boolean;
  onPrimaryAction: () => void;
}

export function getCommitDialogFiles(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): GitCommitPreviewFile[] {
  return includeUnstaged ? [...state.unstagedFiles, ...state.stagedFiles] : state.stagedFiles;
}

export function getCommitDialogStagePaths(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): string[] {
  return Array.from(
    new Set(getCommitDialogFiles(state, includeUnstaged).map((file) => file.stagePath)),
  );
}
