import type {
  ChatAutocompleteAcceptedSuggestion,
  ChatAutocompleteCancelParams,
  ChatAutocompleteLexiconProfile,
  ChatAutocompleteRequest,
  ChatAutocompleteResponse,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * `ChatAutocompleteService` — Host-сервис предиктивного ghost-text в композере.
 *
 * Один канал обслуживает Desktop Local Host, Remote SSH Server и Web Remote.
 * Сервис собирает компактный контекст (история, открытые файлы, диффы, код-индекс,
 * профиль лексики), вызывает быструю модель с жёстким бюджетом токенов и таймаутом,
 * держит 3-режимный кэш префиксов и отменяет устаревшие запросы через `AbortController`.
 */
export interface ChatAutocompleteService {
  /**
   * Получить короткое продолжение мысли пользователя. Бросает `ChatAutocompleteError`
   * с `aborted` / `timeout` / `empty_suggestion`; ошибки модели приходят как `model_failed`.
   */
  complete(request: ChatAutocompleteRequest): Promise<ChatAutocompleteResponse>;

  /** Прервать активный запрос по `requestId`. Идемпотентно: неизвестный id — no-op. */
  cancel(params: ChatAutocompleteCancelParams): Promise<void>;

  /** Записать принятую подсказку в профиль лексики (после `Tab`/`Enter`). */
  recordAcceptedSuggestion(params: ChatAutocompleteAcceptedSuggestion): Promise<void>;

  /** Прочитать текущий профиль лексики для workspace; `null` — профиля ещё нет. */
  getLexiconProfile(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ChatAutocompleteLexiconProfile | null>;

  /** Полностью очистить профиль лексики workspace (кнопка «очистить» в настройках). */
  clearLexiconProfile(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
}

export const IChatAutocompleteService = createServiceDescriptor<ChatAutocompleteService>(
  ServiceChannels.ChatAutocomplete,
);
