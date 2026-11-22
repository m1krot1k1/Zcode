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
    // Бюджет задаётся в токенах: ответ упаковывается до сериализации и никогда не режется
    // побайтово, поэтому JSON остаётся валидным при любом лимите.
    maxTokens: 1500,
  });
  // Results contain workspace-relative paths; the UI resolves them through the file service.
  return result.results;
}

/**
 * Reconcile exact paths after an editor save or a committed file transaction.
 * The service updates only these paths; a watcher batch uses the same entry point.
 */
export async function reconcileEditedFiles(
  service: CodeIntelligenceService,
  workspacePath: string,
  changed: string[],
  removed: string[] = [],
): Promise<void> {
  await service.notifyFilesMutated({ workspacePath, changed, removed });
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
