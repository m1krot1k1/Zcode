import { isAbsolute, resolve, sep } from "node:path";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, DEFAULT_GIT_OUTPUT_BYTES } from "../../config.js";
import type { GitCommandProvider } from "../../providers/gitCommandProvider.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  buildUntrackedStats,
  ensureGitCommandSucceeded,
  normalizeInputPath,
  parseNumstat,
  parseStatusPorcelain,
} from "../gitCliHelpers.js";
import {
  createEmptySummary,
  type GitCliRepo,
  type GitResolvedRepository,
  type GitStatusSnapshot,
} from "../gitCliTypes.js";
import { reuseInFlightRequest, type GitCliState } from "./state.js";

const log = createServiceLogger("git-repo");

export function createStatusApi({
  commandProvider,
  state,
  resolveRepository,
}: {
  commandProvider: GitCommandProvider;
  state: GitCliState;
  resolveRepository(workspacePath: string): Promise<GitResolvedRepository>;
}): Pick<GitCliRepo, "getStatus" | "getIgnoredPaths"> {
  function executeGitStatus(resolution: GitResolvedRepository, untrackedMode: "all" | "normal") {
    return commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["status", "--porcelain=v2", "--branch", `--untracked-files=${untrackedMode}`, "-z"],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
  }

  async function runGitStatus(resolution: GitResolvedRepository) {
    const useCollapsedUntracked = state.collapsedUntrackedRepoRoots.has(resolution.repoRoot);
    const result = await executeGitStatus(resolution, useCollapsedUntracked ? "normal" : "all");
    if (useCollapsedUntracked || !result.outputTruncated) {
      return result;
    }

    // 大仓库的逐文件未跟踪状态可能超过输出上限；直接放大上限会让后续行数统计
    // 并发读取上万个文件。首次超限后按 repoRoot 记住目录折叠模式，既保留可用的 Git
    // 摘要和变更入口，也避免每次自动刷新都重复执行一次必然失败的详细命令。
    state.collapsedUntrackedRepoRoots.add(resolution.repoRoot);
    log.warn(
      undefined,
      `git status detailed output exceeded limit; collapsing untracked directories repoRoot=${resolution.repoRoot}`,
    );
    return await executeGitStatus(resolution, "normal");
  }

  async function getStatus(workspacePath: string): Promise<GitStatusSnapshot> {
    // staged / unstaged / summary / branch 比较都依赖同一份状态快照，
    // 并发复用可以把一次渲染里的重复 `status + diff --numstat` 合并成一轮 Git CLI 调用。
    return await reuseInFlightRequest(state.statusRequests, workspacePath, async () => {
      const resolution = await resolveRepository(workspacePath);
      if (!resolution.isGitAvailable || !resolution.isRepository) {
        return {
          resolution,
          summary: createEmptySummary(resolution),
          entries: [],
          stagedStats: new Map(),
          unstagedStats: new Map(),
          untrackedStats: new Map(),
        };
      }

      const [statusResult, stagedStatsResult, unstagedStatsResult] = await Promise.all([
        // 默认保留逐文件未跟踪状态；只有确认当前 repoRoot 超限后，runGitStatus 才降级为目录折叠。
        runGitStatus(resolution),
        commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["diff", "--cached", "--numstat", "-z", "--find-renames", "--"],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
        }),
        commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["diff", "--numstat", "-z", "--find-renames", "--"],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
        }),
      ]);

      ensureGitCommandSucceeded("git status", statusResult);
      ensureGitCommandSucceeded("git diff --cached --numstat", stagedStatsResult);
      ensureGitCommandSucceeded("git diff --numstat", unstagedStatsResult);

      const parsedStatus = parseStatusPorcelain(statusResult.stdout);
      const untrackedStats = await buildUntrackedStats(resolution.repoRoot, parsedStatus.entries);

      return {
        resolution,
        summary: {
          workspacePath: resolution.workspacePath,
          repoRoot: resolution.repoRoot,
          workspaceInRepoPath: resolution.workspaceInRepoPath,
          autoRefreshWatchPaths: resolution.autoRefreshWatchPaths,
          branchName: parsedStatus.branchName,
          trackingBranchName: parsedStatus.trackingBranchName,
          headRefType: parsedStatus.headRefType,
          ahead: parsedStatus.ahead,
          behind: parsedStatus.behind,
          isDirty: parsedStatus.entries.length > 0,
          isGitAvailable: true,
          isRepository: true,
        },
        entries: parsedStatus.entries,
        stagedStats: parseNumstat(stagedStatsResult.stdout),
        unstagedStats: parseNumstat(unstagedStatsResult.stdout),
        untrackedStats,
      };
    });
  }

  async function getIgnoredPaths(workspacePath: string, paths: string[]): Promise<string[]> {
    if (paths.length === 0) {
      return [];
    }

    const resolution = await resolveRepository(workspacePath);
    if (!resolution.isGitAvailable || !resolution.isRepository) {
      return [];
    }

    const inputPairs = await Promise.all(
      paths.map(async (path) => {
        try {
          return {
            absolutePath: isAbsolute(path)
              ? path
              : resolve(resolution.workspacePath, path.split("/").join(sep)),
            repoRelativePath: await normalizeInputPath(resolution, path),
          };
        } catch {
          return null;
        }
      }),
    );
    const validInputPairs = inputPairs.filter(
      (pair): pair is { absolutePath: string; repoRelativePath: string } => Boolean(pair),
    );
    if (validInputPairs.length === 0) {
      return [];
    }

    const ignoredResult = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["check-ignore", "--", ...validInputPairs.map((pair) => pair.repoRelativePath)],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });

    if (ignoredResult.exitCode === 1) {
      return [];
    }

    ensureGitCommandSucceeded("git check-ignore", ignoredResult);

    const ignoredRepoRelativePaths = new Set(
      ignoredResult.stdout
        // 修复：`git check-ignore -z` 只能和 `--stdin` 一起使用；这里通过 argv 传路径，
        // 所以必须解析普通换行输出，否则命令会直接失败，文件树永远拿不到 ignored 状态。
        .split(/\r?\n/)
        .filter(Boolean)
        .map((path) => path.replace(/\\/g, "/")),
    );

    return validInputPairs
      .filter((pair) => ignoredRepoRelativePaths.has(pair.repoRelativePath))
      .map((pair) => pair.absolutePath);
  }

  return { getStatus, getIgnoredPaths };
}
