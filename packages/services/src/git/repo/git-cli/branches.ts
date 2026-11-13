import { isAbsolute, resolve } from "node:path";
import type {
  GitBranchMutationAction,
  GitBranchMutationIssue,
  GitBranchMutationResult,
  GitLocalBranch,
  GitLocalBranchListResult,
} from "@zcode/shared";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, DEFAULT_GIT_OUTPUT_BYTES } from "../../config.js";
import {
  ensureGitCommandSucceeded,
  ensureRepositoryAvailable,
  fileExists,
  parseGitBranchMutationIssues,
  toInvalidBranchNameIssue,
} from "../gitCliHelpers.js";
import type { GitCliRepo, GitResolvedRepository, GitStatusSnapshot } from "../gitCliTypes.js";
import type { GitCliContext } from "./context.js";

const GIT_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
] as const;

function toBranchMutationFailure(params: {
  action: GitBranchMutationAction;
  branchName: string | null;
  created?: boolean;
  summary: GitStatusSnapshot["summary"];
  issues: GitBranchMutationIssue[];
}): GitBranchMutationResult {
  return {
    ok: false,
    action: params.action,
    branchName: params.branchName,
    didChange: false,
    created: params.created ?? false,
    summary: params.summary,
    issues: params.issues,
  };
}

function toBranchMutationSuccess(params: {
  action: GitBranchMutationAction;
  branchName: string;
  didChange: boolean;
  created: boolean;
  summary: GitStatusSnapshot["summary"];
}): GitBranchMutationResult {
  return {
    ok: true,
    action: params.action,
    branchName: params.branchName,
    didChange: params.didChange,
    created: params.created,
    summary: params.summary,
    issues: [],
  };
}

function parseBranchRefRecords(stdout: string, currentBranchName: string | null): GitLocalBranch[] {
  return stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): GitLocalBranch | null => {
      const [name, upstreamName, commitHash, commitTimestamp] = line.split("\0");
      if (!name) {
        return null;
      }

      const timestampSeconds = commitTimestamp ? Number.parseInt(commitTimestamp, 10) : Number.NaN;
      return {
        name,
        isCurrent: name === currentBranchName,
        upstreamName: upstreamName || null,
        commitHash: commitHash || null,
        commitTimestampMs: Number.isNaN(timestampSeconds) ? null : timestampSeconds * 1000,
      };
    })
    .filter((branch): branch is GitLocalBranch => Boolean(branch))
    .sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) {
        return left.isCurrent ? -1 : 1;
      }

      const leftTimestamp = left.commitTimestampMs ?? Number.NEGATIVE_INFINITY;
      const rightTimestamp = right.commitTimestampMs ?? Number.NEGATIVE_INFINITY;
      if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp - leftTimestamp;
      }

      return left.name.localeCompare(right.name);
    });
}

export function createBranchesApi({
  commandProvider,
  getStatus,
  invalidate,
}: GitCliContext): Pick<
  GitCliRepo,
  "listLocalBranches" | "switchBranch" | "createBranchAndSwitch"
> {
  async function validateBranchName(
    resolution: GitResolvedRepository,
    branchName: string,
  ): Promise<GitBranchMutationIssue | null> {
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["check-ref-format", "--branch", branchName],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.timedOut || result.outputTruncated) {
      ensureGitCommandSucceeded("git check-ref-format --branch", result);
    }

    return result.exitCode === 0 ? null : toInvalidBranchNameIssue(result.stderr);
  }

  async function hasOperationInProgress(resolution: GitResolvedRepository): Promise<boolean> {
    // 进行中的 merge / rebase / cherry-pick 在不同 Git 版本上的报错并不完全稳定，
    // 这里先通过 git-dir 标记位做一次轻量探测，让上层能拿到更稳定的阻塞原因。
    const gitPathResult = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["rev-parse", ...GIT_OPERATION_MARKERS.flatMap((marker) => ["--git-path", marker])],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded("git rev-parse --git-path", gitPathResult);

    const candidatePaths = gitPathResult.stdout
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => (isAbsolute(line) ? line : resolve(resolution.repoRoot, line)));

    const markerExists = await Promise.all(candidatePaths.map((path) => fileExists(path)));
    return markerExists.some(Boolean);
  }

  async function listLocalBranches(workspacePath: string): Promise<GitLocalBranchListResult> {
    const status = await getStatus(workspacePath);
    if (!status.resolution.isGitAvailable || !status.resolution.isRepository) {
      return {
        headRefType: status.summary.headRefType,
        currentBranchName: status.summary.branchName,
        branches: [],
      };
    }

    const result = await commandProvider.run({
      cwd: status.resolution.repoRoot,
      args: [
        "for-each-ref",
        "refs/heads",
        "--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)",
      ],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
    ensureGitCommandSucceeded("git for-each-ref refs/heads", result);

    return {
      headRefType: status.summary.headRefType,
      currentBranchName: status.summary.branchName,
      branches: parseBranchRefRecords(
        result.stdout,
        status.summary.headRefType === "branch" ? status.summary.branchName : null,
      ),
    };
  }

  async function switchBranch(
    workspacePath: string,
    targetBranchName: string,
  ): Promise<GitBranchMutationResult> {
    const status = await getStatus(workspacePath);
    const resolution = ensureRepositoryAvailable(status.resolution, "switch branches");
    const normalizedBranchName = targetBranchName.trim();
    if (normalizedBranchName.length === 0) {
      return toBranchMutationFailure({
        action: "switch",
        branchName: null,
        summary: status.summary,
        issues: [toInvalidBranchNameIssue()],
      });
    }

    if (
      status.summary.headRefType === "branch" &&
      status.summary.branchName === normalizedBranchName
    ) {
      return toBranchMutationSuccess({
        action: "switch",
        branchName: normalizedBranchName,
        didChange: false,
        created: false,
        summary: status.summary,
      });
    }

    // 这里优先返回当前仓库已知的阻塞状态，避免 UI 只能看到一条模糊的 Git 原生错误。
    if (status.entries.some((entry) => entry.isConflicted)) {
      return toBranchMutationFailure({
        action: "switch",
        branchName: normalizedBranchName,
        summary: status.summary,
        issues: [
          {
            code: "conflicts-present",
            message: "Repository still has unresolved conflicts.",
          },
        ],
      });
    }

    if (await hasOperationInProgress(resolution)) {
      return toBranchMutationFailure({
        action: "switch",
        branchName: normalizedBranchName,
        summary: status.summary,
        issues: [
          {
            code: "operation-in-progress",
            message: "Another Git operation is still in progress.",
          },
        ],
      });
    }

    const invalidBranchIssue = await validateBranchName(resolution, normalizedBranchName);
    if (invalidBranchIssue) {
      return toBranchMutationFailure({
        action: "switch",
        branchName: normalizedBranchName,
        summary: status.summary,
        issues: [invalidBranchIssue],
      });
    }

    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["switch", "--no-guess", normalizedBranchName],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0) {
      return toBranchMutationFailure({
        action: "switch",
        branchName: normalizedBranchName,
        summary: status.summary,
        issues: parseGitBranchMutationIssues(result),
      });
    }

    invalidate(workspacePath);
    const nextStatus = await getStatus(workspacePath);
    return toBranchMutationSuccess({
      action: "switch",
      branchName: normalizedBranchName,
      didChange: true,
      created: false,
      summary: nextStatus.summary,
    });
  }

  async function createBranchAndSwitch(
    workspacePath: string,
    branchName: string,
    startPoint?: string,
  ): Promise<GitBranchMutationResult> {
    const status = await getStatus(workspacePath);
    const resolution = ensureRepositoryAvailable(status.resolution, "create and switch branches");
    const normalizedBranchName = branchName.trim();
    if (normalizedBranchName.length === 0) {
      return toBranchMutationFailure({
        action: "create-and-switch",
        branchName: null,
        summary: status.summary,
        issues: [toInvalidBranchNameIssue()],
      });
    }

    if (status.entries.some((entry) => entry.isConflicted)) {
      return toBranchMutationFailure({
        action: "create-and-switch",
        branchName: normalizedBranchName,
        summary: status.summary,
        issues: [
          {
            code: "conflicts-present",
            message: "Repository still has unresolved conflicts.",
          },
        ],
      });
    }

    if (await hasOperationInProgress(resolution)) {
      return toBranchMutationFailure({
        action: "create-and-switch",
        branchName: normalizedBranchName,
        summary: status.summary,
        issues: [
          {
            code: "operation-in-progress",
            message: "Another Git operation is still in progress.",
          },
        ],
      });
    }

    const invalidBranchIssue = await validateBranchName(resolution, normalizedBranchName);
    if (invalidBranchIssue) {
      return toBranchMutationFailure({
        action: "create-and-switch",
        branchName: normalizedBranchName,
        summary: status.summary,
        issues: [invalidBranchIssue],
      });
    }

    const normalizedStartPoint = startPoint?.trim();
    // startPoint 可能来自外部输入；如果值本身以 `-` 开头，
    // Git 会把它继续当成 switch 的选项解析，而不是起始引用。
    // 这里显式插入 `--` 终止选项解析，确保后面的值始终按位置参数处理。
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: normalizedStartPoint
        ? ["switch", "--no-guess", "-c", normalizedBranchName, "--", normalizedStartPoint]
        : ["switch", "--no-guess", "-c", normalizedBranchName],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0) {
      return toBranchMutationFailure({
        action: "create-and-switch",
        branchName: normalizedBranchName,
        summary: status.summary,
        issues: parseGitBranchMutationIssues(result),
      });
    }

    invalidate(workspacePath);
    const nextStatus = await getStatus(workspacePath);
    return toBranchMutationSuccess({
      action: "create-and-switch",
      branchName: normalizedBranchName,
      didChange: true,
      created: true,
      summary: nextStatus.summary,
    });
  }

  return { listLocalBranches, switchBranch, createBranchAndSwitch };
}
