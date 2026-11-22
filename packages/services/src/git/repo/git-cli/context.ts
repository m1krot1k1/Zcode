import type { GitCommandProvider } from "../../providers/gitCommandProvider.js";
import type { GitResolvedRepository, GitStatusSnapshot } from "../gitCliTypes.js";

export interface GitCliContext {
  commandProvider: GitCommandProvider;
  resolveRepository(workspacePath: string): Promise<GitResolvedRepository>;
  getStatus(workspacePath: string): Promise<GitStatusSnapshot>;
  invalidate(workspacePath: string): void;
}
