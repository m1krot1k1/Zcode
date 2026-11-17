import type {
  ChatAutocompleteAcceptedSuggestion,
  ChatAutocompleteCancelParams,
  ChatAutocompleteContextOptions,
  ChatAutocompleteRequest,
  ChatAutocompleteResponse,
} from "@zcode/shared";

/**
 * Контракт managed-модуля `ui-lexical-ghost-autocomplete`.
 *
 * Модуль владеет только представлением ghost-текста внутри Lexical: нативной
 * inline-нодой, приоритетами клавиш и локальной инвалидацией. Сеть, дебаунс-политика
 * и кэш живут в `services-chat-autocomplete`; здесь только их конфигурация.
 */

/** Какой клавишей принимать подсказку целиком / пословно (настраивается). */
export interface GhostAutocompleteKeymap {
  /** Принять всю подсказку. По умолчанию `Tab`. */
  acceptAll: "Tab";
  /** Принять следующее слово. По умолчанию `ArrowRight`; можно отключить. */
  acceptWord: "ArrowRight" | "off";
  /** Отклонить и скрыть до следующего изменения. Всегда `Escape`. */
  dismiss: "Escape";
}

export interface GhostAutocompleteConfig {
  enabled: boolean;
  /** Базовый дебаунс из настроек; адаптивность применяется внутри хука. */
  baseDebounceMs: number;
  context: ChatAutocompleteContextOptions;
  keymap: GhostAutocompleteKeymap;
  /** Показывать подсказку только когда курсор в самом конце текста. */
  cursorAtEndOnly: boolean;
  /** Минимальная длина префикса, после которой вообще спрашиваем модель. */
  minPrefixChars: number;
  modelSelection?: { providerId: string; modelId: string };
}

export const DEFAULT_GHOST_AUTOCOMPLETE_CONFIG: GhostAutocompleteConfig = {
  enabled: false,
  baseDebounceMs: 250,
  context: { history: true, openFiles: true, diffs: true, codeIndex: true, userLexicon: true },
  keymap: { acceptAll: "Tab", acceptWord: "ArrowRight", dismiss: "Escape" },
  cursorAtEndOnly: true,
  minPrefixChars: 6,
};

/** Запрос подсказки из редактора: только то, что нужно для сервиса. */
export interface GhostAutocompletePromptState {
  /** Полный текст без ghost-ноды. */
  text: string;
  /** Курсор в конце текста и выделения нет. */
  cursorAtEnd: boolean;
  hasSelection: boolean;
  /** Активна slash-команда или mention-панель — подсказку не показываем. */
  hasActiveTriggerPanel: boolean;
  /** Идёт IME-композиция. */
  isComposing: boolean;
}

/** Почему подсказка не запрашивается: код нужен тестам и диагностике, не UI. */
export type GhostAutocompleteSkipReason =
  | "disabled"
  | "empty_text"
  | "short_prefix"
  | "cursor_not_at_end"
  | "selection"
  | "trigger_panel_open"
  | "ime_composing"
  | "duplicate_of_input";

/** Чистое решение «спрашивать ли модель»: одна функция, покрытая тестами. */
export function resolveGhostAutocompleteSkip(
  state: GhostAutocompletePromptState,
  config: Pick<GhostAutocompleteConfig, "enabled" | "minPrefixChars" | "cursorAtEndOnly">,
): GhostAutocompleteSkipReason | null {
  if (!config.enabled) return "disabled";
  if (state.isComposing) return "ime_composing";
  if (state.hasSelection) return "selection";
  if (state.hasActiveTriggerPanel) return "trigger_panel_open";
  const text = state.text.trimEnd();
  if (text.length === 0) return "empty_text";
  if (text.length < config.minPrefixChars) return "short_prefix";
  if (config.cursorAtEndOnly && !state.cursorAtEnd) return "cursor_not_at_end";
  return null;
}

/**
 * Порт сервиса, достаточный ghost-плагину.
 *
 * UI-слой не импортирует реализацию сервиса из `@zcode/services`: ему нужен только
 * этот узкий контракт, который удовлетворяет и Host-сервис, и RPC-прокси.
 */
export interface GhostAutocompleteServicePort {
  complete(request: ChatAutocompleteRequest): Promise<ChatAutocompleteResponse>;
  cancel(params: ChatAutocompleteCancelParams): Promise<void>;
  recordAcceptedSuggestion(params: ChatAutocompleteAcceptedSuggestion): Promise<void>;
}
