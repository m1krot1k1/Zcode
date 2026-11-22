import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { GitIdentity, GitWorkspaceRepositoryInfo } from "@zcode/shared";
import { DEFAULT_GIT_COMMAND_TIMEOUT_MS, normalizeWorkspaceInRepoPath } from "../../config.js";
import type { GitCommandProvider } from "../../providers/gitCommandProvider.js";
import {
  ensureGitCommandSucceeded,
  isMissingWorkingDirectoryResult,
  isNotRepositoryResult,
  parseGitConfigValue,
} from "../gitCliHelpers.js";
import type { GitCliRepo, GitResolvedRepository } from "../gitCliTypes.js";
import { reuseInFlightRequest, type GitCliState } from "./state.js";

function normalizeWatchPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.replace(/[\\/]+$/, "");
}

function addAutoRefreshWatchPath(
  paths: GitResolvedRepository["autoRefreshWatchPaths"],
  path: string,
  recursive: boolean,
): void {
  const normalizedPath = normalizeWatchPath(path);
  if (!normalizedPath || paths.some((entry) => entry.path === normalizedPath)) {
    return;
  }

  paths.push({
    path: normalizedPath,
    recursive,
  });
}

function buildAutoRefreshWatchPaths(params: {
  workspacePath: string;
  absoluteGitDir: string;
  gitCommonDir: string;
}): GitResolvedRepository["autoRefreshWatchPaths"] {
  const paths: GitResolvedRepository["autoRefreshWatchPaths"] = [];
  // Linux 上对 workspacePath 做 recursive fs.watch 会为整棵 workspace
  // 分配 watcher；慢挂载或大型生成目录会阻塞 workspace Host。workspace 内容 watcher
  // 由 UI 按 workspace Host 平台决定，这里只输出 Git 元数据边界。

  // Git 元数据可能在 linked worktree 或 separate git-dir 中位于 repoRoot 之外。
  // UI 只知道工作区路径，不能猜 `.git` 布局；这里用 Git 自身解析出的目录作为刷新边界。
  addAutoRefreshWatchPath(paths, params.absoluteGitDir, true);
  const resolvedCommonDir = params.gitCommonDir
    ? isAbsolute(params.gitCommonDir)
      ? params.gitCommonDir
      : // `git rev-parse --git-common-dir` 的相对结果以命令 cwd 为基准，
        // 子目录 workspace 若误用 repoRoot 会把 `/root` + `../.git` 解析成 `/.git`。
        resolve(params.workspacePath, params.gitCommonDir)
    : params.absoluteGitDir;
  addAutoRefreshWatchPath(paths, resolvedCommonDir, true);

  return paths;
}

export function createRepositoryApi({
  commandProvider,
  state,
}: {
  commandProvider: GitCommandProvider;
  state: GitCliState;
}): Pick<GitCliRepo, "resolveRepository" | "getWorkspaceRepositoryInfo" | "getIdentity"> {
  async function resolveRepository(workspacePath: string): Promise<GitResolvedRepository> {
    // 启动阶段 summary / changes / branch / identity 会并发读取同一个 workspace，
    // 这里复用进行中的仓库解析，避免一轮刷新里重复执行多次 `git rev-parse`。
    return await reuseInFlightRequest(
      state.repositoryResolutionRequests,
      workspacePath,
      async () => {
        const gitBinary = await commandProvider.resolveGitBinary();
        if (!gitBinary) {
          return {
            workspacePath,
            repoRoot: workspacePath,
            workspaceInRepoPath: ".",
            autoRefreshWatchPaths: [],
            isGitAvailable: false,
            isRepository: false,
          };
        }

        const result = await commandProvider.run({
          cwd: workspacePath,
          args: [
            "rev-parse",
            "--show-toplevel",
            "--show-prefix",
            "--absolute-git-dir",
            "--git-common-dir",
          ],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) {
          // 测试/窗口切换时 workspace 目录可能在并发请求过程中被删除（例如临时目录清理）。
          // 之前这里会直接抛错，若调用方是 fire-and-forget 链路就会形成 unhandled rejection，
          // 进而把 Vitest 跑挂成超时。目录缺失不属于“Git 协议失败”，应按“当前非可用仓库”降级返回。
          if (isMissingWorkingDirectoryResult(result)) {
            return {
              workspacePath,
              repoRoot: workspacePath,
              workspaceInRepoPath: ".",
              autoRefreshWatchPaths: [],
              isGitAvailable: true,
              isRepository: false,
            };
          }

          if (isNotRepositoryResult(result)) {
            return {
              workspacePath,
              repoRoot: workspacePath,
              workspaceInRepoPath: ".",
              autoRefreshWatchPaths: [],
              isGitAvailable: true,
              isRepository: false,
            };
          }

          ensureGitCommandSucceeded("git rev-parse", result);
        }

        const lines = result.stdout.replace(/\r\n/g, "\n").split("\n");
        const repoRoot = lines[0]?.trim();
        if (!repoRoot) {
          throw new Error("Failed to resolve Git repository root");
        }

        return {
          workspacePath,
          repoRoot,
          workspaceInRepoPath: normalizeWorkspaceInRepoPath(lines[1] ?? ""),
          autoRefreshWatchPaths: buildAutoRefreshWatchPaths({
            workspacePath,
            absoluteGitDir: lines[2]?.trim() ?? "",
            gitCommonDir: lines[3]?.trim() ?? "",
          }),
          isGitAvailable: true,
          isRepository: true,
        };
      },
    );
  }

  async function getWorkspaceRepositoryInfo(
    workspacePath: string,
  ): Promise<GitWorkspaceRepositoryInfo> {
    return await reuseInFlightRequest(
      state.workspaceRepositoryInfoRequests,
      workspacePath,
      async () => {
        const resolution = await resolveRepository(workspacePath);
        if (!resolution.isGitAvailable || !resolution.isRepository) {
          return {
            workspacePath,
            kind: "not-repository",
            isGitAvailable: resolution.isGitAvailable,
          };
        }

        const gitEntryPath = resolve(resolution.repoRoot, ".git");
        try {
          const gitEntryStat = await stat(gitEntryPath);
          if (gitEntryStat.isDirectory()) {
            return {
              workspacePath,
              kind: "main-tree",
              isGitAvailable: true,
            };
          }

          if (gitEntryStat.isFile()) {
            const gitEntryContent = await readFile(gitEntryPath, "utf-8");
            const firstLine = gitEntryContent.replace(/\r\n/g, "\n").split("\n")[0]?.trim() ?? "";
            const gitDirPrefix = "gitdir:";
            if (firstLine.startsWith(gitDirPrefix)) {
              const rawGitDir = firstLine.slice(gitDirPrefix.length).trim();
              const resolvedGitDir = rawGitDir
                ? isAbsolute(rawGitDir)
                  ? rawGitDir
                  : resolve(resolution.repoRoot, rawGitDir)
                : "";
              const normalizedGitDir = resolvedGitDir ? resolvedGitDir.replace(/\\/g, "/") : "";

              // 关键业务逻辑：linked worktree 的 `.git` 文件会指向
              // `<main-tree>/.git/worktrees/<name>`；这里只要命中这个结构就判为 worktree。
              // 其它 `.git` 文件形态（如 submodule / separate-git-dir）一律按 main-tree 放行，
              // 因为迁移过滤不是强依赖，宁可少过滤也不要误杀正常记录。
              if (normalizedGitDir.includes("/.git/worktrees/")) {
                return {
                  workspacePath,
                  kind: "linked-worktree",
                  isGitAvailable: true,
                };
              }
            }
          }
        } catch {
          // 这里的 worktree 识别只用于迁移候选过滤，不是 Git 主功能的强一致前置。
          // 因此遇到 `.git` 缺失、权限异常或非常规布局时，选择 fail-open 当成 main-tree，
          // 避免把本来可迁移的记录误过滤掉。
        }

        return {
          workspacePath,
          kind: "main-tree",
          isGitAvailable: true,
        };
      },
    );
  }

  async function getIdentity(workspacePath: string): Promise<GitIdentity> {
    const resolution = await resolveRepository(workspacePath);
    if (!resolution.isGitAvailable || !resolution.isRepository) {
      return {
        userName: null,
        userEmail: null,
        nameSource: null,
        emailSource: null,
        scopeLabel: null,
      };
    }

    const [nameResult, emailResult] = await Promise.all([
      commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["config", "--show-scope", "--show-origin", "--get", "user.name"],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      }),
      commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["config", "--show-scope", "--show-origin", "--get", "user.email"],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      }),
    ]);

    const name = parseGitConfigValue(nameResult);
    const email = parseGitConfigValue(emailResult);
    return {
      userName: name.value,
      userEmail: email.value,
      nameSource: name.source,
      emailSource: email.source,
      scopeLabel: name.scope ?? email.scope ?? null,
    };
  }

  return { resolveRepository, getWorkspaceRepositoryInfo, getIdentity };
}
