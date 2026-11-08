import type { CodeIndexStatus, CodeWorkspaceRef } from "./contract.js";
import {
  getEmbeddingConfig,
  statusFromDb,
  validateEmbeddingConfig,
  writeText,
  type CodeIndexDatabase,
} from "./database.js";

export interface EmbeddingCredentialStore {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

type SetEmbeddingConfigParams = CodeWorkspaceRef & {
  provider?: "ollama" | "openai-compatible" | null;
  endpoint?: string | null;
  model?: string | null;
  apiKey?: string | null;
};

export function embeddingCredentialKey(workspaceKey: string): string {
  return `code-intelligence:${workspaceKey}:embedding-api-key`;
}

export async function updateEmbeddingConfig(
  db: CodeIndexDatabase,
  params: SetEmbeddingConfigParams,
  credentialKey: string,
  credentialService?: EmbeddingCredentialStore,
): Promise<CodeIndexStatus> {
  const hasExplicitClear =
    params.provider === null || params.endpoint === null || params.model === null;
  const previousConfig = getEmbeddingConfig(db);
  const nextEndpoint = hasExplicitClear
    ? undefined
    : params.endpoint === undefined
      ? previousConfig.endpoint
      : params.endpoint;
  const nextModel = hasExplicitClear
    ? undefined
    : params.model === undefined
      ? previousConfig.model
      : params.model;
  const nextProvider = hasExplicitClear
    ? undefined
    : params.provider === undefined
      ? (previousConfig.provider ?? "ollama")
      : params.provider;
  const keyOnlyClear =
    !hasExplicitClear &&
    params.endpoint === undefined &&
    params.model === undefined &&
    params.provider === undefined &&
    params.apiKey === null &&
    !previousConfig.endpoint &&
    !previousConfig.model;
  if (!hasExplicitClear && !keyOnlyClear && (!nextEndpoint?.trim() || !nextModel?.trim())) {
    throw new Error(
      "Both embedding endpoint and model are required. Use null to clear the configuration.",
    );
  }
  const config =
    hasExplicitClear || keyOnlyClear
      ? {}
      : validateEmbeddingConfig(nextProvider, nextEndpoint, nextModel);

  let nextApiKey: string | null | undefined;
  if (typeof params.apiKey === "string") {
    const trimmed = params.apiKey.trim();
    if (
      trimmed &&
      (trimmed.length > 4096 ||
        trimmed.includes("\r") ||
        trimmed.includes("\n") ||
        trimmed.includes("\0"))
    )
      throw new Error("Embedding API key has an invalid format.");
    nextApiKey = trimmed || undefined;
  } else if (params.apiKey === null || hasExplicitClear) {
    nextApiKey = null;
  }
  if (typeof nextApiKey === "string" && !credentialService)
    throw new Error("Secure credential storage is unavailable.");

  const previousApiKey = await credentialService?.load(credentialKey);
  const keyConfigured =
    nextApiKey === null
      ? false
      : typeof nextApiKey === "string"
        ? true
        : (previousConfig.apiKeyConfigured ?? Boolean(previousApiKey));
  let credentialChanged = false;
  if (nextApiKey === null && previousApiKey && credentialService) {
    await credentialService.delete(credentialKey);
    credentialChanged = true;
  } else if (typeof nextApiKey === "string" && previousApiKey !== nextApiKey) {
    await credentialService!.save(credentialKey, nextApiKey);
    credentialChanged = true;
  }

  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    if (config.endpoint && config.model && config.provider) {
      writeText(db, "embedding_provider", config.provider);
      writeText(db, "embedding_endpoint", config.endpoint);
      writeText(db, "embedding_model", config.model);
      writeText(db, "embedding_api_key_configured", String(keyConfigured));
    } else {
      db.prepare(
        "DELETE FROM index_meta WHERE key IN ('embedding_provider','embedding_endpoint','embedding_model','vectors_model','embedding_api_key_configured')",
      ).run();
      db.prepare("UPDATE chunks SET embedding = NULL, embedding_model = NULL").run();
    }
    if (config.identity && previousConfig.identity !== config.identity) {
      db.prepare("UPDATE chunks SET embedding = NULL, embedding_model = NULL").run();
      writeText(db, "vectors_model", "");
    }
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) db.exec("ROLLBACK");
    if (credentialChanged && credentialService) {
      try {
        if (previousApiKey) await credentialService.save(credentialKey, previousApiKey);
        else await credentialService.delete(credentialKey);
      } catch {
        // Preserve the original DB error and keep credential contents out of diagnostics.
      }
    }
    throw error;
  }
  return statusFromDb(db);
}
