import { GitActionMenuTrigger } from "@/git-action-menu/GitActionMenuTrigger.js";
import { GitCommitDialog } from "@/git-action-menu/GitCommitDialog.js";
import { GitPushDialog } from "@/git-action-menu/GitPushDialog.js";
import { useGitActionMenuController } from "@/git-action-menu/useGitActionMenuController.js";
import type { GitActionMenuProps } from "@/git-action-menu/types.js";

export function GitActionMenu(props: GitActionMenuProps) {
  const { trigger, commitDialog, pushDialog } = useGitActionMenuController(props);

  return (
    <>
      <GitActionMenuTrigger {...trigger} />
      <GitCommitDialog {...commitDialog} />
      <GitPushDialog {...pushDialog} />
    </>
  );
}
