import type { CodeGraphOverview, CodeIntelligenceService, CodeSearchResult } from "./contract.js";

/** Create the workspace index and query it through the Host service contract. */
export async function indexAndSearch(
  service: CodeIntelligenceService,
  workspacePath: string,
): Promise<CodeSearchResult[]> {
  await service.indexWorkspace({ workspacePath });
  const result = await service.search({
    workspacePath,
    query: "workspace identity",
    limit: 8,
  });
  // Results contain workspace-relative paths; the UI resolves them through the file service.
  return result.results;
}

/** Read a bounded graph overview or focus a workspace-relative search hit. */
export async function inspectCodeGraph(
  service: CodeIntelligenceService,
  workspacePath: string,
  focus?: { symbol?: string; path?: string; startLine?: number },
): Promise<CodeGraphOverview> {
  return service.getGraphOverview({
    workspacePath,
    ...(focus ? { focus } : {}),
    limit: 60,
  });
}

/** Configure an OpenAI-compatible endpoint; secrets are entered separately at runtime. */
export async function configureOpenAiCompatibleEmbeddings(
  service: CodeIntelligenceService,
  workspacePath: string,
  endpoint: string,
  model: string,
): Promise<void> {
  await service.setEmbeddingConfig({
    workspacePath,
    provider: "openai-compatible",
    endpoint,
    model,
  });
}
