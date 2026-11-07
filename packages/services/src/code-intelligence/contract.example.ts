import type { CodeIntelligenceService, CodeSearchResult } from "./contract.js";

/** Create the workspace index and query it through the Host service contract. */
export async function indexAndSearch(
  service: CodeIntelligenceService,
  workspacePath: string,
): Promise<CodeSearchResult[]> {
  await service.indexWorkspace({ workspacePath });
  const result = await service.search({ workspacePath, query: "workspace identity", limit: 8 });
  // Results contain workspace-relative paths; the UI resolves them through the file service.
  return result.results;
}
