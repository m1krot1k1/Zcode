import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { GitDiffQuery, GitDiffResult } from "@zcode/shared";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_DIFF_BYTES,
  DEFAULT_GIT_DIFF_TIMEOUT_MS,
  DEFAULT_GIT_OUTPUT_BYTES,
  getGitNullDevicePath,
} from "../../config.js";
import type { GitCommandProvider } from "../../providers/gitCommandProvider.js";
import {
  buildUntrackedTextDiffResult,
  ensureGitCommandSucceeded,
  fileExists,
  inferKindFromNumstat,
  normalizeInputPath,
  parseNumstat,
  toDiffResult,
} from "../gitCliHelpers.js";
import type {
  GitBranchComparisonChange,
  GitBranchComparisonSnapshot,
  GitCliRepo,
} from "../gitCliTypes.js";
import type { GitCliContext } from "./context.js";

function toUnavailableDiff(path: string, summary: string): GitDiffResult {
  return {
    path,
    availability: "unavailable",
    patch: null,
    beforeContent: null,
    afterContent: null,
    summary,
  };
}

interface GitDiffContents {
  beforeContent: string;
  afterContent: string;
}

function toCompleteDiffContents(
  beforeContent: string | null,
  afterContent: string | null,
): GitDiffContents | null {
  // 完整 diff 的任一侧读取失败后若被补成空字符串，UI 会把“不可读”误判成
  // “文件为空”，进而把整个文件渲染成新增或删除。完整内容对必须一起成功或一起降级。
  if (beforeContent === null || afterContent === null) {
    return null;
  }

  return { beforeContent, afterContent };
}

function isPreviewableText(content: string): boolean {
  return !content.includes("\0");
}

async function readWorkingTreePreviewContent(absolutePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || fileStat.size > DEFAULT_GIT_DIFF_BYTES) {
      return null;
    }

    const content = await readFile(absolutePath, "utf-8");
    return isPreviewableText(content) ? content : null;
  } catch {
    // 文件删除和原子保存窗口都会让 stat/readFile 失败；这里不能猜成合法空文件。
    return null;
  }
}

async function readGitBlobPreviewContent({
  commandProvider,
  repoRoot,
  ref,
  repoRelativePath,
}: {
  commandProvider: GitCommandProvider;
  repoRoot: string;
  ref: string;
  repoRelativePath: string;
}): Promise<string | null> {
  const result = await commandProvider.run({
    cwd: repoRoot,
    args: ["show", `${ref}:${repoRelativePath}`],
    timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
  });

  if (
    result.timedOut ||
    result.outputTruncated ||
    result.exitCode !== 0 ||
    !isPreviewableText(result.stdout)
  ) {
    return null;
  }

  return result.stdout;
}

async function readBranchDiffContents({
  commandProvider,
  repoRoot,
  repoRelativePath,
  trackingBranchName,
}: {
  commandProvider: GitCommandProvider;
  repoRoot: string;
  repoRelativePath: string;
  trackingBranchName: string;
}): Promise<GitDiffContents | null> {
  const mergeBaseResult = await commandProvider.run({
    cwd: repoRoot,
    args: ["merge-base", trackingBranchName, "HEAD"],
    timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
  });
  const mergeBase = mergeBaseResult.exitCode === 0 ? mergeBaseResult.stdout.trim() : "";
  const beforeContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: mergeBase || trackingBranchName,
    repoRelativePath,
  });
  const afterContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "HEAD",
    repoRelativePath,
  });

  return toCompleteDiffContents(beforeContent, afterContent);
}

async function readStagedDiffContents({
  commandProvider,
  repoRoot,
  repoRelativePath,
}: {
  commandProvider: GitCommandProvider;
  repoRoot: string;
  repoRelativePath: string;
}): Promise<GitDiffContents | null> {
  const beforeContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "HEAD",
    repoRelativePath,
  });
  const afterContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "",
    repoRelativePath,
  });

  return toCompleteDiffContents(beforeContent, afterContent);
}

async function readUnstagedDiffContents({
  absolutePath,
  commandProvider,
  repoRoot,
  repoRelativePath,
}: {
  absolutePath: string;
  commandProvider: GitCommandProvider;
  repoRoot: string;
  repoRelativePath: string;
}): Promise<GitDiffContents | null> {
  const beforeContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "",
    repoRelativePath,
  });
  const afterContent = await readWorkingTreePreviewContent(absolutePath);

  return toCompleteDiffContents(beforeContent, afterContent);
}

function withDiffContents(diff: GitDiffResult, contents: GitDiffContents | null): GitDiffResult {
  if (diff.availability !== "patch") {
    return diff;
  }

  if (!contents) {
    // Git patch 已经成功生成时，全文预览失败只应关闭 MultiFileDiff，不能把正确 patch 一并丢弃。
    return diff;
  }

  return {
    ...diff,
    beforeContent: contents.beforeContent,
    afterContent: contents.afterContent,
  };
}

export function createDiffsApi({
  commandProvider,
  resolveRepository,
  getStatus,
}: GitCliContext): Pick<GitCliRepo, "getDiff" | "getBranchComparison"> {
  async function getDiff(params: GitDiffQuery): Promise<GitDiffResult> {
    const resolution = await resolveRepository(params.workspacePath);
    const absolutePath = isAbsolute(params.path)
      ? params.path
      : resolve(params.workspacePath, params.path.split("/").join(sep));
    if (!resolution.isGitAvailable) {
      return toUnavailableDiff(
        absolutePath,
        "Git binary is not available in the current environment.",
      );
    }

    if (!resolution.isRepository) {
      return toUnavailableDiff(absolutePath, "Workspace is not inside a Git repository.");
    }

    const repoRelativePath = await normalizeInputPath(resolution, params.path);
    if (params.sourceId === "branch") {
      const status = await getStatus(params.workspacePath);
      const trackingBranchName = status.summary.trackingBranchName;
      if (!trackingBranchName) {
        return toUnavailableDiff(absolutePath, "Current branch does not have an upstream branch.");
      }

      const branchDiffResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--no-ext-diff",
          "--no-color",
          "--binary",
          "--find-renames",
          `${trackingBranchName}...HEAD`,
          "--",
          repoRelativePath,
        ],
        timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
      });
      const parsedBranchDiff = toDiffResult(absolutePath, branchDiffResult, {
        emptySummary: "No branch comparison diff is available for this file.",
      });
      return withDiffContents(
        parsedBranchDiff,
        await readBranchDiffContents({
          commandProvider,
          repoRoot: resolution.repoRoot,
          repoRelativePath,
          trackingBranchName,
        }),
      );
    }

    const staged = params.staged ?? params.sourceId === "staged";
    const diffResult = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: staged
        ? ["diff", "--cached", "--no-ext-diff", "--no-color", "--binary", "--", repoRelativePath]
        : ["diff", "--no-ext-diff", "--no-color", "--binary", "--", repoRelativePath],
      timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
    });
    const parsedDiff = toDiffResult(absolutePath, diffResult, {
      emptySummary: "No Git diff is available for this file.",
    });
    if (parsedDiff.availability !== "unavailable" || staged) {
      const contents = staged
        ? await readStagedDiffContents({
            commandProvider,
            repoRoot: resolution.repoRoot,
            repoRelativePath,
          })
        : await readUnstagedDiffContents({
            absolutePath,
            commandProvider,
            repoRoot: resolution.repoRoot,
            repoRelativePath,
          });
      return withDiffContents(parsedDiff, contents);
    }

    // 未跟踪文件不会出现在 `git diff` 里，所以这里先生成一份稳定的单文件 patch。
    // 如果文件无法按文本预览，再退回 `--no-index`，继续兼容二进制等特殊场景。
    if (!(await fileExists(absolutePath))) {
      return parsedDiff;
    }

    const normalizedUntrackedDiff = await buildUntrackedTextDiffResult(
      absolutePath,
      repoRelativePath,
      DEFAULT_GIT_DIFF_BYTES,
    );
    if (normalizedUntrackedDiff) {
      return normalizedUntrackedDiff;
    }

    const noIndexDiffResult = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        "--binary",
        getGitNullDevicePath(),
        absolutePath,
      ],
      timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
    });
    return toDiffResult(absolutePath, noIndexDiffResult, {
      allowedExitCodes: [0, 1],
      emptySummary: "No previewable diff is available for this file.",
    });
  }

  async function getBranchComparison(workspacePath: string): Promise<GitBranchComparisonSnapshot> {
    const status = await getStatus(workspacePath);
    if (
      !status.resolution.isGitAvailable ||
      !status.resolution.isRepository ||
      !status.summary.trackingBranchName
    ) {
      return {
        resolution: status.resolution,
        baseRef: status.summary.trackingBranchName,
        headRef: status.summary.branchName ?? "HEAD",
        comparisonLabel: null,
        changes: [],
      };
    }

    const result = await commandProvider.run({
      cwd: status.resolution.repoRoot,
      args: [
        "diff",
        "--numstat",
        "-z",
        "--find-renames",
        `${status.summary.trackingBranchName}...HEAD`,
        "--",
      ],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
    ensureGitCommandSucceeded("git diff --numstat upstream...HEAD", result);

    const changes = Array.from(parseNumstat(result.stdout).entries()).map(
      ([path, stat]): GitBranchComparisonChange => ({
        path,
        originalPath: stat.originalPath ?? null,
        kind: inferKindFromNumstat(stat),
        added: stat.added,
        removed: stat.removed,
      }),
    );

    return {
      resolution: status.resolution,
      baseRef: status.summary.trackingBranchName,
      headRef: status.summary.branchName ?? "HEAD",
      comparisonLabel: status.summary.branchName
        ? `${status.summary.branchName} -> ${status.summary.trackingBranchName}`
        : `HEAD -> ${status.summary.trackingBranchName}`,
      changes,
    };
  }

  return { getDiff, getBranchComparison };
}
