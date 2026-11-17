import type {
  PromptEnhanceCancelParams,
  PromptEnhanceRequest,
  PromptEnhanceResult,
  PromptEnhanceStreamDelta,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * `PromptEnhancerService` — Host-сервис нативного улучшения промптов.
 *
 * Один канал обслуживает Desktop Local Host, Remote SSH Server и Web Remote. Сервис сам
 * собирает контекст (гибридный поиск, диффы, правила проекта) и вызывает модель; клиент
 * лишь присылает черновик и получает улучшенный текст с провенансом.
 */
export interface PromptEnhancerService {
  /**
   * Улучшить черновик. Бросает `PromptEnhanceError` с `aborted` / `timeout`, если запрос
   * отменён или не уложился в бюджет; ошибки модели приходят как `model_failed`.
   */
  enhance(request: PromptEnhanceRequest): Promise<PromptEnhanceResult>;

  /** Прервать активный запрос по `requestId`. Идемпотентно: неизвестный id — no-op. */
  cancel(params: PromptEnhanceCancelParams): Promise<void>;

  /** Потоковые дельты улучшенного текста; возвращает функцию отписки. */
  onStreamDelta(listener: (event: PromptEnhanceStreamDelta) => void): () => void;
}

export const IPromptEnhancerService = createServiceDescriptor<PromptEnhancerService>(
  ServiceChannels.PromptEnhancer,
);
