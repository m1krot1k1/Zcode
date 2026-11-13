import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitCommitGraphCommit, GitCommitGraphRef, GitPushResult } from "@zcode/shared";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_OUTPUT_BYTES,
  DEFAULT_GIT_PUSH_OUTPUT_BYTES,
  DEFAULT_GIT_PUSH_TIMEOUT_MS,
  normalizeGitPath,
} from "../../config.js";
import {
  ensureGitCommandSucceeded,
  ensureRepositoryAvailable,
  normalizeInputPath,
  parseStatusPorcelain,
} from "../gitCliHelpers.js";
import type {
  GitCliRepo,
  GitCommitGraphSnapshot,
  GitResolvedRepository,
  GitStatusSnapshot,
} from "../gitCliTypes.js";
import type { GitCliContext } from "./context.js";

const DEFAULT_GIT_GRAPH_MAX_COUNT = 100;
const MAX_GIT_GRAPH_MAX_COUNT = 200;
const GIT_GRAPH_RECORD_SEPARATOR = "\x1e";
const GIT_GRAPH_FIELD_SEPARATOR = "\x00";

function normalizeGitGraphMaxCount(maxCount: number | undefined): number {
  if (typeof maxCount !== "number" || !Number.isFinite(maxCount)) {
    return DEFAULT_GIT_GRAPH_MAX_COUNT;
  }

  return Math.min(MAX_GIT_GRAPH_MAX_COUNT, Math.max(1, Math.floor(maxCount)));
}

function normalizeGitGraphSkip(skip: number | undefined): number {
  if (typeof skip !== "number" || !Number.isFinite(skip)) {
    return 0;
  }

  return Math.max(0, Math.floor(skip));
}

function addGitGraphRef(refs: GitCommitGraphRef[], ref: GitCommitGraphRef): void {
  if (refs.some((candidate) => candidate.kind === ref.kind && candidate.name === ref.name)) {
    return;
  }

  refs.push(ref);
}

function parseGitGraphDecorationRef(rawRef: string): GitCommitGraphRef | null {
  const ref = rawRef.trim();
  if (!ref) {
    return null;
  }

  if (ref === "HEAD") {
    return { name: "HEAD", kind: "head" };
  }

  const tagPrefix = "tag: ";
  if (ref.startsWith(tagPrefix)) {
    const tagRef = ref.slice(tagPrefix.length).trim();
    const name = tagRef.startsWith("refs/tags/") ? tagRef.slice("refs/tags/".length) : tagRef;
    return name ? { name, kind: "tag" } : null;
  }

  if (ref.startsWith("refs/heads/")) {
    const name = ref.slice("refs/heads/".length);
    return name ? { name, kind: "branch" } : null;
  }

  if (ref.startsWith("refs/remotes/")) {
    const name = ref.slice("refs/remotes/".length);
    return name ? { name, kind: "remote" } : null;
  }

  if (ref.startsWith("refs/tags/")) {
    const name = ref.slice("refs/tags/".length);
    return name ? { name, kind: "tag" } : null;
  }

  return { name: ref, kind: ref.includes("/") ? "remote" : "branch" };
}

function parseGitGraphRefs(rawDecorations: string): GitCommitGraphRef[] {
  const refs: GitCommitGraphRef[] = [];
  for (const rawDecoration of rawDecorations.split(",")) {
    const decoration = rawDecoration.trim();
    if (!decoration) {
      continue;
    }

    const headPointer = "HEAD -> ";
    if (decoration.startsWith(headPointer)) {
      addGitGraphRef(refs, { name: "HEAD", kind: "head" });
      const pointedRef = parseGitGraphDecorationRef(decoration.slice(headPointer.length));
      if (pointedRef) {
        addGitGraphRef(refs, pointedRef);
      }
      continue;
    }

    const parsedRef = parseGitGraphDecorationRef(decoration);
    if (parsedRef) {
      addGitGraphRef(refs, parsedRef);
    }
  }

  return refs;
}

function parseGitGraphRecords(stdout: string): GitCommitGraphCommit[] {
  return stdout
    .split(GIT_GRAPH_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record): GitCommitGraphCommit | null => {
      const [hash, parents, authorName, authoredAtSeconds, subject, decorations] =
        record.split(GIT_GRAPH_FIELD_SEPARATOR);
      if (!hash) {
        return null;
      }

      const timestampSeconds = authoredAtSeconds
        ? Number.parseInt(authoredAtSeconds, 10)
        : Number.NaN;
      return {
        hash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        refs: parseGitGraphRefs(decorations ?? ""),
        subject: subject ?? "",
        authorName: authorName || null,
        authoredAtMs: Number.isNaN(timestampSeconds) ? null : timestampSeconds * 1000,
      };
    })
    .filter((commit): commit is GitCommitGraphCommit => Boolean(commit));
}

function parseTrackingRemoteName(trackingBranchName: string | null): string | null {
  const remoteName = trackingBranchName?.split("/")[0]?.trim() ?? "";
  return remoteName.length > 0 ? remoteName : null;
}

function parseRemoteList(stdout: string): string[] {
  return stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface GitIndexEntry {
  mode: string;
  objectHash: string;
  stage: string;
  path: string;
}

function parseGitIndexEntries(stdout: string): GitIndexEntry[] {
  return stdout
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const tabIndex = record.indexOf("\t");
      if (tabIndex < 0) {
        throw new Error("Failed to parse staged Git index entry.");
      }

      const [mode, objectHash, stage] = record.slice(0, tabIndex).trim().split(/\s+/);
      const path = normalizeGitPath(record.slice(tabIndex + 1));
      if (!mode || !objectHash || !stage || !path) {
        throw new Error("Failed to parse staged Git index entry.");
      }

      return { mode, objectHash, stage, path };
    });
}

export function createCommitsApi({
  commandProvider,
  resolveRepository,
  getStatus,
  invalidate,
}: GitCliContext): Pick<GitCliRepo, "getCommitGraph" | "commit" | "push"> {
  async function readOptionalGitConfig(
    resolution: GitResolvedRepository,
    key: string,
  ): Promise<string | null> {
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["config", "--get", key],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.timedOut || result.outputTruncated) {
      ensureGitCommandSucceeded(`git config --get ${key}`, result);
    }

    if (result.exitCode === 0) {
      const value = result.stdout.trim();
      return value.length > 0 ? value : null;
    }

    if (result.exitCode === 1) {
      return null;
    }

    ensureGitCommandSucceeded(`git config --get ${key}`, result);
    return null;
  }

  async function listRemotes(resolution: GitResolvedRepository): Promise<string[]> {
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["remote"],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
    ensureGitCommandSucceeded("git remote", result);
    return parseRemoteList(result.stdout);
  }

  async function resolvePushRemote(status: GitStatusSnapshot): Promise<string> {
    const resolution = ensureRepositoryAvailable(status.resolution, "push changes");
    const branchName = status.summary.branchName?.trim() ?? "";
    if (branchName.length === 0) {
      throw new Error("Cannot resolve a Git push remote without a current branch.");
    }

    const branchRemote = await readOptionalGitConfig(resolution, `branch.${branchName}.remote`);
    if (branchRemote) {
      return branchRemote;
    }

    const pushDefaultRemote = await readOptionalGitConfig(resolution, "remote.pushDefault");
    if (pushDefaultRemote) {
      return pushDefaultRemote;
    }

    const remotes = await listRemotes(resolution);
    if (remotes.includes("origin")) {
      return "origin";
    }

    if (remotes.length === 1) {
      return remotes[0]!;
    }

    if (remotes.length === 0) {
      throw new Error("No Git remote is configured for the current repository.");
    }

    throw new Error(
      "Multiple Git remotes are configured. Configure branch.<name>.remote or remote.pushDefault first.",
    );
  }

  async function getCommitGraph(
    workspacePath: string,
    maxCount?: number,
    skip?: number,
  ): Promise<GitCommitGraphSnapshot> {
    const resolution = await resolveRepository(workspacePath);
    if (!resolution.isGitAvailable || !resolution.isRepository) {
      return {
        resolution,
        commits: [],
        hasMore: false,
      };
    }

    const normalizedMaxCount = normalizeGitGraphMaxCount(maxCount);
    const normalizedSkip = normalizeGitGraphSkip(skip);
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: [
        "log",
        // --all 会把 refs/zcode/checkpoints 等内部 hidden refs 拉进 Git Graph。
        // Graph 只展示用户可见历史，因此限定到 HEAD、分支、标签和远端分支。
        "HEAD",
        "--branches",
        "--tags",
        "--remotes",
        "--date-order",
        "--topo-order",
        `--skip=${normalizedSkip}`,
        `--max-count=${normalizedMaxCount + 1}`,
        "--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D%x1e",
      ],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toLowerCase();
      if (
        stderr.includes("does not have any commits yet") ||
        stderr.includes("your current branch") ||
        stderr.includes("bad default revision") ||
        stderr.includes("ambiguous argument 'head'")
      ) {
        return {
          resolution,
          commits: [],
          hasMore: false,
        };
      }

      ensureGitCommandSucceeded("git log visible refs", result);
    }

    const parsedCommits = parseGitGraphRecords(result.stdout);
    return {
      resolution,
      commits: parsedCommits.slice(0, normalizedMaxCount),
      hasMore: parsedCommits.length > normalizedMaxCount,
    };
  }

  async function commit(
    workspacePath: string,
    message: string,
    paths?: string[],
    options?: { stagedOnly?: boolean },
  ): Promise<{ commitHash: string }> {
    const resolution = ensureRepositoryAvailable(
      await resolveRepository(workspacePath),
      "commit changes",
    );
    const trimmedMessage = message.trim();
    if (trimmedMessage.length === 0) {
      throw new Error("Commit message cannot be empty");
    }
    const repoPaths =
      paths && paths.length > 0
        ? Array.from(
            new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path)))),
          )
        : [];

    if (options?.stagedOnly && repoPaths.length > 0) {
      const scopedStatusResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["status", "--porcelain=v2", "-z", "--", ...repoPaths],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      ensureGitCommandSucceeded("git status selected paths", scopedStatusResult);

      const cleanupRepoPaths = Array.from(
        new Set([
          ...repoPaths,
          ...parseStatusPorcelain(scopedStatusResult.stdout)
            .entries.filter((entry) => repoPaths.includes(entry.path))
            .map((entry) => entry.originalPath)
            .filter((path): path is string => Boolean(path)),
        ]),
      );
      const stagedEntriesResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["ls-files", "--stage", "-z", "--", ...repoPaths],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      ensureGitCommandSucceeded("git ls-files selected staged entries", stagedEntriesResult);
      const stagedEntries = parseGitIndexEntries(stagedEntriesResult.stdout);
      if (stagedEntries.some((entry) => entry.stage !== "0")) {
        throw new Error("Cannot commit selected staged paths while index conflicts exist.");
      }

      const headResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["rev-parse", "--verify", "HEAD"],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      });
      const parentHash = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
      const tempIndexDir = await mkdtemp(join(tmpdir(), "zcode-git-index-"));
      const tempIndexPath = join(tempIndexDir, "index");
      const tempIndexEnv = { GIT_INDEX_FILE: tempIndexPath };

      try {
        const readTreeResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: parentHash ? ["read-tree", parentHash] : ["read-tree", "--empty"],
          env: tempIndexEnv,
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        });
        ensureGitCommandSucceeded("git read-tree selected commit base", readTreeResult);

        if (cleanupRepoPaths.length > 0) {
          const removeResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["update-index", "--force-remove", "--", ...cleanupRepoPaths],
            env: tempIndexEnv,
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          });
          ensureGitCommandSucceeded("git update-index remove selected paths", removeResult);
        }

        for (const entry of stagedEntries) {
          const addResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: [
              "update-index",
              "--add",
              "--cacheinfo",
              entry.mode,
              entry.objectHash,
              entry.path,
            ],
            env: tempIndexEnv,
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          });
          ensureGitCommandSucceeded("git update-index add selected paths", addResult);
        }

        const scopedCommitResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["commit", "-m", trimmedMessage],
          env: tempIndexEnv,
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
        });
        ensureGitCommandSucceeded("git commit selected staged paths", scopedCommitResult);

        const hashResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["rev-parse", "HEAD"],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        });
        ensureGitCommandSucceeded("git rev-parse selected commit HEAD", hashResult);
        const commitHash = hashResult.stdout.trim();

        // 提交当前会话文件时不能把真实 index 整体替换成临时 index。
        // 这里只把已提交的路径同步到新 HEAD，保留其它已暂存文件继续等待用户手动提交。
        const resetSelectedResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["reset", "--quiet", "HEAD", "--", ...cleanupRepoPaths],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        });
        ensureGitCommandSucceeded("git reset selected committed paths", resetSelectedResult);
        invalidate(workspacePath);
        return { commitHash };
      } finally {
        await rm(tempIndexDir, { recursive: true, force: true });
      }
    }

    const commitResult = await commandProvider.run({
      cwd: resolution.repoRoot,
      args:
        repoPaths.length > 0
          ? ["commit", "-m", trimmedMessage, "--", ...repoPaths]
          : ["commit", "-m", trimmedMessage],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
    ensureGitCommandSucceeded("git commit", commitResult);
    invalidate(workspacePath);

    const hashResult = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["rev-parse", "HEAD"],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded("git rev-parse HEAD", hashResult);
    return { commitHash: hashResult.stdout.trim() };
  }

  async function push(workspacePath: string): Promise<GitPushResult> {
    const status = await getStatus(workspacePath);
    const resolution = ensureRepositoryAvailable(status.resolution, "push changes");
    const branchName = status.summary.branchName?.trim() ?? "";
    if (status.summary.headRefType !== "branch" || branchName.length === 0) {
      throw new Error("Cannot push while HEAD is detached.");
    }

    const hasTrackingBranch = Boolean(status.summary.trackingBranchName);
    const remoteName = hasTrackingBranch
      ? parseTrackingRemoteName(status.summary.trackingBranchName)
      : await resolvePushRemote(status);
    const pushResult = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: hasTrackingBranch
        ? ["push"]
        : ["push", "--set-upstream", remoteName ?? "origin", branchName],
      // 关键业务逻辑：push 是显式用户动作，而且可能被 pre-push hook 拉长。
      // 这里单独使用更长超时，避免测试/校验脚本尚未跑完就被前端误判成 push 失败。
      timeoutMs: DEFAULT_GIT_PUSH_TIMEOUT_MS,
      // 关键业务逻辑：pre-push hook 可能输出完整测试日志。
      // 这里单独放宽输出上限，避免在 push 真正完成前因为 hook 输出过多被截断。
      maxOutputBytes: DEFAULT_GIT_PUSH_OUTPUT_BYTES,
    });
    ensureGitCommandSucceeded("git push", pushResult);
    invalidate(workspacePath);

    const nextStatus = await getStatus(workspacePath);
    return {
      branchName,
      trackingBranchName: nextStatus.summary.trackingBranchName,
      remoteName: remoteName ?? parseTrackingRemoteName(nextStatus.summary.trackingBranchName),
      setUpstream: !hasTrackingBranch,
      summary: nextStatus.summary,
    };
  }

  return { getCommitGraph, commit, push };
}
