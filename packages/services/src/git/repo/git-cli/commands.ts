import { DEFAULT_GIT_COMMAND_TIMEOUT_MS } from "../../config.js";
import {
  ensureGitCommandSucceeded,
  ensureRepositoryAvailable,
  normalizeInputPath,
} from "../gitCliHelpers.js";
import type { GitCliRepo, GitResolvedRepository } from "../gitCliTypes.js";
import type { GitCliContext } from "./context.js";

async function resolveRepoPaths(
  resolution: GitResolvedRepository,
  paths: string[],
): Promise<string[]> {
  return Array.from(
    new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path)))),
  );
}

export function createCommandsApi({
  commandProvider,
  resolveRepository,
  invalidate,
}: GitCliContext): Pick<GitCliRepo, "stage" | "unstage" | "discard"> {
  async function stage(workspacePath: string, paths: string[]): Promise<void> {
    const resolution = ensureRepositoryAvailable(
      await resolveRepository(workspacePath),
      "stage paths",
    );
    const repoPaths = await resolveRepoPaths(resolution, paths);
    if (repoPaths.length === 0) {
      return;
    }

    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["add", "--", ...repoPaths],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded("git add", result);
    invalidate(workspacePath);
  }

  async function unstage(workspacePath: string, paths: string[]): Promise<void> {
    const resolution = ensureRepositoryAvailable(
      await resolveRepository(workspacePath),
      "unstage paths",
    );
    const repoPaths = await resolveRepoPaths(resolution, paths);
    if (repoPaths.length === 0) {
      return;
    }

    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["restore", "--staged", "--", ...repoPaths],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded("git restore --staged", result);
    invalidate(workspacePath);
  }

  async function discard(workspacePath: string, paths: string[], staged: boolean): Promise<void> {
    const resolution = ensureRepositoryAvailable(
      await resolveRepository(workspacePath),
      "discard paths",
    );
    const repoPaths = await resolveRepoPaths(resolution, paths);
    if (repoPaths.length === 0) {
      return;
    }

    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: staged
        ? ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...repoPaths]
        : ["restore", "--worktree", "--", ...repoPaths],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded("git restore", result);
    invalidate(workspacePath);
  }

  return { stage, unstage, discard };
}
