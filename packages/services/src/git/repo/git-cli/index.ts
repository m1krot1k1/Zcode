import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "../../providers/gitCommandProvider.js";
import type { GitCliRepo } from "../gitCliTypes.js";
import { createBranchesApi } from "./branches.js";
import { createCommandsApi } from "./commands.js";
import { createCommitsApi } from "./commits.js";
import type { GitCliContext } from "./context.js";
import { createDiffsApi } from "./diffs.js";
import { createRepositoryApi } from "./repository.js";
import { createStatusApi } from "./status.js";
import { createGitCliState, invalidateState } from "./state.js";

export function createGitCliRepo(options?: { commandProvider?: GitCommandProvider }): GitCliRepo {
  const commandProvider = options?.commandProvider ?? createGitCommandProvider();
  const state = createGitCliState();
  const invalidate = (workspacePath: string): void => {
    invalidateState(state, workspacePath);
  };

  const repositoryApi = createRepositoryApi({ commandProvider, state });
  const statusApi = createStatusApi({
    commandProvider,
    state,
    resolveRepository: repositoryApi.resolveRepository,
  });
  const context: GitCliContext = {
    commandProvider,
    resolveRepository: repositoryApi.resolveRepository,
    getStatus: statusApi.getStatus,
    invalidate,
  };

  return {
    invalidate,
    ...repositoryApi,
    ...statusApi,
    ...createDiffsApi(context),
    ...createBranchesApi(context),
    ...createCommitsApi(context),
    ...createCommandsApi(context),
  };
}
