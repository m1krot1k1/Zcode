import type { GitWorkspaceRepositoryInfo } from "@zcode/shared";
import type { GitResolvedRepository, GitStatusSnapshot } from "../gitCliTypes.js";

export interface GitCliState {
  repositoryResolutionRequests: Map<string, Promise<GitResolvedRepository>>;
  workspaceRepositoryInfoRequests: Map<string, Promise<GitWorkspaceRepositoryInfo>>;
  statusRequests: Map<string, Promise<GitStatusSnapshot>>;
  collapsedUntrackedRepoRoots: Set<string>;
}

export function createGitCliState(): GitCliState {
  return {
    repositoryResolutionRequests: new Map(),
    workspaceRepositoryInfoRequests: new Map(),
    statusRequests: new Map(),
    collapsedUntrackedRepoRoots: new Set(),
  };
}

export function reuseInFlightRequest<T>(
  requests: Map<string, Promise<T>>,
  key: string,
  factory: () => Promise<T>,
): Promise<T> {
  const existing = requests.get(key);
  if (existing) {
    return existing;
  }

  const request = factory();
  requests.set(key, request);
  const cleanup = () => {
    if (requests.get(key) === request) {
      requests.delete(key);
    }
  };
  void request.then(cleanup, cleanup);
  return request;
}

export function invalidateState(state: GitCliState, workspacePath: string): void {
  state.repositoryResolutionRequests.delete(workspacePath);
  state.workspaceRepositoryInfoRequests.delete(workspacePath);
  state.statusRequests.delete(workspacePath);
}
