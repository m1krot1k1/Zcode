import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { EmbeddingErrorCode, EmbeddingProvider } from "./contract.js";

/**
 * Провайдеры эмбеддингов: валидация endpoint/model и батчевые запросы.
 *
 * Здесь сохранена проверенная логика v1 (loopback-only для Ollama, HTTPS для внешних
 * OpenAI-compatible, валидация порядка векторов, ограниченные повторы на 429/5xx),
 * потому что она решает реальные проблемы безопасности и устойчивости. Всё, что относилось
 * к схеме v1 (`index_meta`, текстовые PK, LIKE-поиск), удалено — им владеет worker-слой.
 */

export const MAX_EMBED_BATCH = 32;

export interface EmbeddingConfig {
  provider?: EmbeddingProvider;
  endpoint?: string;
  model?: string;
  identity?: string;
  apiKeyConfigured?: boolean;
  /** Только для запроса: секрет из `ICredentialService`; никогда не возвращается наружу. */
  apiKey?: string;
}

export function embeddingConfigIdentity(config: {
  provider: EmbeddingProvider;
  endpoint: string;
  model: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([config.provider, config.endpoint, config.model]))
    .digest("hex");
}

/**
 * Endpoint, введённый как origin (`http://host:port`), раньше уходил POST-ом в `/`.
 * Локальные OpenAI-compatible/Ollama-серверы часто отвечают 200 на любой путь,
 * поэтому проверка соединения проходила HTTP-слой и падала только на разборе JSON.
 * Дописываем стандартный путь, не трогая уже указанные пользователем пути.
 */
function normalizeEmbeddingEndpoint(provider: EmbeddingProvider, parsed: URL): string {
  const path = parsed.pathname.replace(/\/+$/u, "");
  if (path === "") {
    return `${parsed.origin}${provider === "ollama" ? "/api/embeddings" : "/v1/embeddings"}`;
  }
  if (provider === "openai-compatible" && path === "/v1") {
    return `${parsed.origin}/v1/embeddings`;
  }
  if (provider === "ollama" && path === "/api") {
    return `${parsed.origin}/api/embeddings`;
  }
  return `${parsed.origin}${path}`;
}

export function validateEmbeddingConfig(
  providerValue: EmbeddingProvider | null | undefined,
  endpointValue?: string | null,
  modelValue?: string | null,
): EmbeddingConfig {
  const provider = providerValue ?? "ollama";
  const endpoint = endpointValue?.trim();
  const model = modelValue?.trim();
  if (!endpoint && !model) return {};
  if (!endpoint || !model) throw new Error("Both embedding endpoint and model are required.");
  if (provider !== "ollama" && provider !== "openai-compatible")
    throw new Error("Unsupported embedding provider.");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Embedding endpoint must be a valid URL.");
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    (isIP(hostname.replace(/^\[|\]$/g, "")) === 4 && hostname.startsWith("127."));
  const protocolAllowed =
    provider === "ollama"
      ? parsed.protocol === "http:" && loopback
      : parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback);
  if (
    !protocolAllowed ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    endpoint.includes("?") ||
    endpoint.includes("#") ||
    endpoint.length > 2048 ||
    !/^[\p{L}\p{N}._:/-]{1,120}$/u.test(model)
  ) {
    throw new Error(
      "Embedding configuration must use an allowed credential-free endpoint and a valid model name.",
    );
  }
  const normalizedEndpoint = normalizeEmbeddingEndpoint(provider, parsed);
  return {
    provider,
    endpoint: normalizedEndpoint,
    model,
    identity: embeddingConfigIdentity({
      provider,
      endpoint: normalizedEndpoint,
      model,
    }),
  };
}

class EmbeddingHttpError extends Error {
  constructor(readonly status: number) {
    super(`Embedding endpoint returned HTTP ${status}.`);
    this.name = "EmbeddingHttpError";
  }
}

function embeddingHttpErrorCode(status: number): EmbeddingErrorCode {
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "provider-error";
}

export function embeddingFailureFromError(error: unknown): {
  code: EmbeddingErrorCode;
  httpStatus?: number;
} {
  if (error instanceof EmbeddingHttpError) {
    return { code: embeddingHttpErrorCode(error.status), httpStatus: error.status };
  }
  const message = error instanceof Error ? error.message : "";
  if (/invalid vector|invalid.*batch|vector order/i.test(message))
    return { code: "invalid-response" };
  if (/timeout|timed out|abort/i.test(message)) return { code: "timeout" };
  return { code: "request-failed" };
}

function retryDelayMs(response: Response, retryIndex: number): number | null {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const parsed = Number.isFinite(seconds)
      ? Math.max(0, seconds * 1000)
      : Math.max(0, Date.parse(retryAfter) - Date.now());
    if (Number.isFinite(parsed)) return parsed <= 30_000 ? parsed : null;
  }
  return Math.min(500 * 2 ** retryIndex, 2_000);
}

export async function requestEmbeddings(
  config: EmbeddingConfig,
  input: string[],
  fetchImpl: typeof fetch,
): Promise<number[][]> {
  if (!config.endpoint || !config.model || input.length === 0) return [];
  const vectors: number[][] = [];
  for (let offset = 0; offset < input.length; offset += MAX_EMBED_BATCH) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          input: input.slice(offset, offset + MAX_EMBED_BATCH),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) break;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) throw new EmbeddingHttpError(response.status);
      const delayMs = retryDelayMs(response, attempt);
      if (delayMs === null) throw new EmbeddingHttpError(response.status);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!response?.ok) throw new EmbeddingHttpError(response?.status ?? 0);
    const payload: unknown = await response.json();
    const expectedCount = Math.min(MAX_EMBED_BATCH, input.length - offset);
    let embeddings: unknown;
    if (config.provider === "openai-compatible") {
      const data =
        payload && typeof payload === "object" && "data" in payload
          ? (payload as { data?: unknown }).data
          : undefined;
      if (!Array.isArray(data) || data.length !== expectedCount) {
        throw new Error("OpenAI-compatible embedding endpoint returned an invalid vector batch.");
      }
      const ordered: unknown[] = Array(expectedCount);
      for (const item of data) {
        if (!item || typeof item !== "object" || !("index" in item) || !("embedding" in item))
          throw new Error("OpenAI-compatible embedding endpoint returned an invalid vector.");
        const index = (item as { index?: unknown }).index;
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= expectedCount ||
          ordered[index] !== undefined
        ) {
          throw new Error("OpenAI-compatible embedding endpoint returned invalid vector order.");
        }
        ordered[index] = (item as { embedding: unknown }).embedding;
      }
      embeddings = ordered;
    } else {
      embeddings =
        payload && typeof payload === "object" && "embeddings" in payload
          ? (payload as { embeddings?: unknown }).embeddings
          : undefined;
    }
    if (!Array.isArray(embeddings) || embeddings.length !== expectedCount) {
      throw new Error("Embedding endpoint returned an invalid vector batch.");
    }
    for (const embedding of embeddings) {
      if (
        !Array.isArray(embedding) ||
        embedding.length === 0 ||
        !embedding.every((value) => typeof value === "number" && Number.isFinite(value))
      ) {
        throw new Error("Embedding endpoint returned an invalid vector.");
      }
      vectors.push(embedding as number[]);
    }
  }
  return vectors;
}
