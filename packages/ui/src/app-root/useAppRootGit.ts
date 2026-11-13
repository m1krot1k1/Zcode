import { useCallback, useMemo, useState } from "react";
import type { GitChangeSourceId } from "@zcode/shared";
import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";

/**
 * Git-производные App: состояние репозитория, общая сводка по источникам
 * и ручной refresh/review. Выбранный источник приходит из моста памяти side pane.
 */
export function useAppRootGit({
  workspaceAbsPath,
  workspaceIdentity,
  activeTaskId,
  remoteSessionId,
  remoteTarget,
  hasGitTab,
  isWorkspaceVisible,
  workspaceReadOnlyReason,
  handleOpenGit,
  gitSelectedSourceId,
  setGitSelectedSourceId,
}: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activeTaskId: string | null;
  remoteSessionId?: string;
  remoteTarget: unknown;
  hasGitTab: boolean;
  isWorkspaceVisible: boolean;
  workspaceReadOnlyReason?: string;
  handleOpenGit: () => void;
  gitSelectedSourceId: GitChangeSourceId;
  setGitSelectedSourceId: (value: GitChangeSourceId) => void;
}) {
  const [gitRefreshVersion, setGitRefreshVersion] = useState(0);
  const handleRefreshGit = useCallback(() => {
    setGitRefreshVersion((value) => value + 1);
  }, []);
  const gitState = useGitRepository({
    workspacePath: workspaceAbsPath,
    activeTaskId,
    includeExtendedData: hasGitTab,
    // 关键逻辑：真实 Git 只在 workspace 变化、Git pane 打开、或用户显式点刷新时重拉。
    // task 切换 / last-turn 摘要变化只更新本地衍生数据，不再顺带重跑 Git 命令。
    refreshToken: gitRefreshVersion,
    remoteSessionId: remoteSessionId ?? null,
    remoteTarget,
    workspaceIdentity,
  });
  useGitAutoRefresh({
    workspacePath: workspaceAbsPath,
    workspaceIdentity,
    remoteSessionId: remoteSessionId ?? null,
    gitSummary: gitState.summary,
    gitSummaryWorkspaceKey: gitState.workspaceKey,
    enabled: isWorkspaceVisible,
    onRefreshGit: handleRefreshGit,
  });
  const activeGitSourceId =
    gitState.sourceOptions.find((option) => option.id === gitSelectedSourceId)?.id ??
    gitState.sourceOptions[0]?.id ??
    "unstaged";
  const gitChangeSummaryBySourceId = useMemo(() => {
    // 关键业务逻辑：workspace header 和 Git pane 都依赖同一套来源统计，
    // 这里先把各来源的 +/- 汇总成稳定映射，避免不同位置各自重复计算后出现展示不一致。
    return Object.fromEntries(
      gitState.sourceOptions.map((option) => {
        const dataset = gitState.datasets[option.id] ?? gitState.datasets.unstaged;
        const summary = dataset.sections
          .flatMap((section) => section.changes)
          .reduce(
            (result, change) => {
              result.added += change.added;
              result.removed += change.removed;
              return result;
            },
            { added: 0, removed: 0 },
          );
        return [option.id, summary];
      }),
    ) as Record<GitChangeSourceId, { added: number; removed: number }>;
  }, [gitState.datasets, gitState.sourceOptions]);
  const gitWorktreeChangeSummary = useMemo(() => {
    const unstaged = gitChangeSummaryBySourceId.unstaged ?? {
      added: 0,
      removed: 0,
    };
    const staged = gitChangeSummaryBySourceId.staged ?? {
      added: 0,
      removed: 0,
    };
    return {
      added: unstaged.added + staged.added,
      removed: unstaged.removed + staged.removed,
    };
  }, [gitChangeSummaryBySourceId]);
  const gitWorktreeReviewSourceId = useMemo<GitChangeSourceId | null>(() => {
    const unstaged = gitChangeSummaryBySourceId.unstaged ?? {
      added: 0,
      removed: 0,
    };
    const staged = gitChangeSummaryBySourceId.staged ?? {
      added: 0,
      removed: 0,
    };
    if (unstaged.added + unstaged.removed > 0) {
      return "unstaged";
    }
    if (staged.added + staged.removed > 0) {
      return "staged";
    }
    return null;
  }, [gitChangeSummaryBySourceId]);
  const handleOpenGitReview = useCallback(
    (sourceId?: GitChangeSourceId) => {
      if (workspaceReadOnlyReason) {
        return;
      }
      if (sourceId) {
        setGitSelectedSourceId(sourceId);
      }
      handleOpenGit();
    },
    [handleOpenGit, workspaceReadOnlyReason],
  );

  return {
    gitState,
    activeGitSourceId,
    gitWorktreeChangeSummary,
    gitWorktreeReviewSourceId,
    handleRefreshGit,
    handleOpenGitReview,
  };
}
