import type { EmbeddingTestResult, EmbeddingProvider } from "./contract.js";
import {
  MAX_EMBED_BATCH,
  embeddingFailureFromError,
  requestEmbeddings,
  validateEmbeddingConfig,
} from "./embeddings.js";
import type { EmbeddingCredentialStore } from "./embeddingSettings.js";

export async function probeEmbeddingProvider(
  params: {
    provider: EmbeddingProvider;
    endpoint: string;
    model: string;
    apiKey?: string;
  },
  credentialKey: string,
  credentialService: EmbeddingCredentialStore | undefined,
  fetchImpl: typeof fetch,
): Promise<EmbeddingTestResult> {
  const startedAt = Date.now();
  let config: ReturnType<typeof validateEmbeddingConfig>;
  try {
    config = validateEmbeddingConfig(params.provider, params.endpoint, params.model);
  } catch {
    return { ok: false, errorCode: "invalid-config", elapsedMs: Date.now() - startedAt };
  }

  try {
    if (
      params.apiKey &&
      (params.apiKey.length > 4096 ||
        params.apiKey.includes("\r") ||
        params.apiKey.includes("\n") ||
        params.apiKey.includes(String.fromCharCode(0)))
    )
      throw new Error("invalid credential");
    const savedApiKey = params.apiKey?.trim() ? null : await credentialService?.load(credentialKey);
    const probeInputs = Array.from(
      { length: MAX_EMBED_BATCH },
      (_, index) => `zcode fixed embedding connection check ${index + 1}`,
    );
    const vectors = await requestEmbeddings(
      {
        ...config,
        ...(params.apiKey?.trim()
          ? { apiKey: params.apiKey.trim() }
          : savedApiKey?.trim()
            ? { apiKey: savedApiKey.trim() }
            : {}),
      },
      probeInputs,
      fetchImpl,
    );
    const vector = vectors[0];
    return vector
      ? { ok: true, dimensions: vector.length, elapsedMs: Date.now() - startedAt }
      : { ok: false, errorCode: "invalid-response", elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const failure = embeddingFailureFromError(error);
    return {
      ok: false,
      errorCode: failure.code,
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      elapsedMs: Date.now() - startedAt,
    };
  }
}
