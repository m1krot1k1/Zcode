import {
  embeddingFailureFromError,
  requestEmbeddings,
  MAX_EMBED_BATCH,
  type EmbeddingConfig,
} from "../embeddings.js";
import type { EmbeddingErrorCode } from "../contract.js";
import {
  projectProviderVector,
  quantizeProjectedVector,
  quantizeSketchQ4,
} from "../ranking/localSketch.js";
import { readMeta, type IndexDatabase } from "./store.js";

/**
 * Реальные векторы провайдера эмбеддингов.
 *
 * Правила, которые здесь соблюдаются:
 *  - **нет сети по умолчанию**: если провайдер не сконфигурирован, модуль ничего не делает,
 *    и поиск работает на локальном скетче;
 *  - **секрет не персистится**: API-ключ приходит в запросе от Host (тот читает его из
 *    `ICredentialService`) и существует только в памяти воркера на время вызова;
 *  - **компактное хранение**: полноразмерный вектор (например, 1536 float) проецируется
 *    детерминированной signed-projection в 256 измерений и квантуется в 4 бита (128 байт).
 *
 * Замер: полноразмерный `provider_vec_i8` (1536 байт на чанк) записывался в схему v2, но не
 * читался ни поиском, ни постингами — искать и считать косинус по нему никто не мог, потому что
 * канал работает в 256-мерном пространстве проекции. В v3 он не хранится: остаётся только
 * проекция, что снимает до 1.5 КБ на чанк при включённом провайдере.
 */

export interface ProviderPlan {
  config: EmbeddingConfig;
  apiKey: string | undefined;
  fetchImpl: typeof fetch;
  /** Идентичность конфигурации: по ней проверяется, что векторы относятся к этой модели. */
  identity: string;
}

export function providerPlanOf(
  db: IndexDatabase,
  apiKey: string | undefined,
  fetchImpl: typeof fetch | undefined,
): ProviderPlan | null {
  const endpoint = readMeta(db, "embedding_endpoint");
  const model = readMeta(db, "embedding_model");
  const provider = readMeta(db, "embedding_provider");
  if (!endpoint || !model) return null;
  if (provider !== "ollama" && provider !== "openai-compatible") return null;
  return {
    config: { provider, endpoint, model },
    apiKey,
    fetchImpl: fetchImpl ?? fetch,
    identity: `${provider}|${endpoint}|${model}`,
  };
}

export interface ProviderChunkVector {
  /** 4-битная упакованная проекция: то, что попадает в `chunk_vectors.provider_sketch_q4`. */
  sketchQ4: Uint8Array;
  /** Масштаб 4-битной упаковки этой проекции. */
  sketchScale: number;
  /** Int8-представление проекции: из него строятся постинги (порог значимости в шкале Int8). */
  sketchInt8: Uint8Array;
  /** Значения проекции в Int8-шкале — источник для `sketch_postings`. */
  sketchSigned: readonly number[];
}

/**
 * Ошибка провайдера в терминах контракта: код категории и HTTP-статус без тела ответа.
 * Причина отдельного типа: тело ответа провайдера может содержать приватные диагностические
 * данные, поэтому наружу отдаётся только категория.
 */
export class ProviderEmbeddingError extends Error {
  constructor(
    readonly code: EmbeddingErrorCode,
    readonly httpStatus: number | undefined,
  ) {
    super(`Embedding provider failed: ${code}${httpStatus ? ` (HTTP ${httpStatus})` : ""}.`);
    this.name = "ProviderEmbeddingError";
  }
}

function wrapProviderError(error: unknown): ProviderEmbeddingError {
  if (error instanceof ProviderEmbeddingError) return error;
  const failure = embeddingFailureFromError(error);
  return new ProviderEmbeddingError(failure.code, failure.httpStatus);
}

/**
 * Считает векторы для содержимого чанков. Ошибки провайдера пробрасываются наверх:
 * вызывающий слой решает, пометить ли индекс как `degraded`, а не молча терять векторы.
 */
export async function embedChunkContents(
  plan: ProviderPlan,
  contents: readonly string[],
): Promise<ProviderChunkVector[]> {
  const vectors: ProviderChunkVector[] = [];
  try {
    for (let offset = 0; offset < contents.length; offset += MAX_EMBED_BATCH) {
      const batch = contents.slice(offset, offset + MAX_EMBED_BATCH);
      const embedded = await requestEmbeddings(
        { ...plan.config, ...(plan.apiKey ? { apiKey: plan.apiKey } : {}) },
        batch.map((content) => content.slice(0, 4000)),
        plan.fetchImpl,
      );
      if (embedded.length !== batch.length) {
        throw new Error("Embedding provider returned an unexpected number of vectors.");
      }
      for (const vector of embedded) {
        const projected = projectProviderVector(vector);
        const packed = quantizeSketchQ4(projected);
        const int8 = quantizeProjectedVector(projected);
        const signed: number[] = new Array(int8.length);
        for (let index = 0; index < int8.length; index += 1) {
          const raw = int8[index] ?? 0;
          signed[index] = raw > 127 ? raw - 256 : raw;
        }
        vectors.push({
          sketchQ4: packed.bytes,
          sketchScale: packed.scale,
          sketchInt8: int8,
          sketchSigned: signed,
        });
      }
    }
  } catch (error) {
    throw wrapProviderError(error);
  }
  return vectors;
}

/** Проекция запроса в то же пространство, в котором лежат векторы чанков. */
export async function embedQuery(plan: ProviderPlan, query: string): Promise<Uint8Array | null> {
  try {
    const [vector] = await requestEmbeddings(
      { ...plan.config, ...(plan.apiKey ? { apiKey: plan.apiKey } : {}) },
      [query.slice(0, 4000)],
      plan.fetchImpl,
    );
    if (!vector) return null;
    return quantizeProjectedVector(projectProviderVector(vector));
  } catch (error) {
    throw wrapProviderError(error);
  }
}
