import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveAdaptiveGhostDebounceMs, type ChatAutocompleteResponse } from "@zcode/shared";
import { logger } from "../logger.js";
import {
  resolveGhostAutocompleteSkip,
  type GhostAutocompleteConfig,
  type GhostAutocompletePromptState,
  type GhostAutocompleteServicePort,
} from "./contract.js";

/**
 * Состояние ghost-подсказки в хуке.
 *
 * Здесь только клиентская политика: адаптивный дебаунс, отмена устаревшего запроса
 * и «защита от мигания». Контент подсказки не хранится как бизнес-факт — только до
 * момента принятия, после чего он уходит в историю Lexical.
 */
export interface ChatAutocompleteState {
  suggestion: string;
  source: ChatAutocompleteResponse["source"] | null;
  isLoading: boolean;
  /** Префикс, для которого получена подсказка: нужен для локальной инвалидации. */
  prefix: string | null;
}

const INITIAL_STATE: ChatAutocompleteState = {
  suggestion: "",
  source: null,
  isLoading: false,
  prefix: null,
};

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `auto_${Date.now().toString(36)}_${requestCounter}`;
}

export interface UseChatAutocompleteOptions {
  service: GhostAutocompleteServicePort | null;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
  activeFilePath?: string;
  openTabPaths?: readonly string[];
  config: GhostAutocompleteConfig;
}

export interface UseChatAutocompleteResult extends ChatAutocompleteState {
  /** Запросить подсказку для текущего текста (вызывается дебаунс-таймером плагина). */
  request: (state: GhostAutocompletePromptState) => void;
  /** Немедленно отменить активный запрос (пользователь продолжил печатать). */
  cancel: () => void;
  /** Скрыть подсказку и забыть префикс до следующего изменения. */
  reset: () => void;
  /** Зафиксировать принятие: сбросить состояние и записать в профиль лексики. */
  accept: (fullPrompt: string, acceptedSlice: string) => void;
  /** Один лишний запрос уже отменён — плагину не нужно ничего делать. */
  isStale: (prefix: string) => boolean;
}

/**
 * Клиентская обвязка ghost-автодополнения.
 *
 * Инварианты:
 * - одновременно живёт не более одного запроса; новый отменяет предыдущий;
 * - при быстром наборе дебаунс растёт (`resolveAdaptiveDebounceMs`), чтобы не жечь токены;
 * - ошибки и таймауты тихо прячут подсказку: ghost-текст не показывает тосты;
 * - после принятия подсказка мгновенно исчезает из состояния (нода уже заменена плагином).
 */
export function useChatAutocomplete(
  options: UseChatAutocompleteOptions,
): UseChatAutocompleteResult {
  const [state, setState] = useState<ChatAutocompleteState>(INITIAL_STATE);
  const activeRequestId = useRef<string | null>(null);
  const mounted = useRef(true);
  const typingTimestamps = useRef<number[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const requestId = activeRequestId.current;
      if (requestId) {
        void options.service?.cancel({ requestId }).catch(() => {});
        activeRequestId.current = null;
      }
      if (timer.current) clearTimeout(timer.current);
    };
  }, [options.service]);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const requestId = activeRequestId.current;
    if (!requestId) return;
    activeRequestId.current = null;
    void options.service?.cancel({ requestId }).catch(() => {});
    setState((previous) => ({ ...previous, isLoading: false }));
  }, [options.service]);

  const reset = useCallback(() => {
    cancel();
    setState(INITIAL_STATE);
  }, [cancel]);

  /**
   * @param state — снимок редактора на момент вызова.
   */
  const request = useCallback(
    (promptState: GhostAutocompletePromptState) => {
      const config = options.config;
      const skip = resolveGhostAutocompleteSkip(promptState, config);
      if (skip) {
        // Пустой/невалидный ввод инвалидирует подсказку мгновенно, без ожидания дебаунса.
        if (state.suggestion || state.isLoading) reset();
        return;
      }
      const service = options.service;
      if (!service) return;
      if (state.prefix !== null && promptState.text === state.prefix && state.suggestion) {
        // Ввод не изменился — показывать ту же подсказку повторно не нужно.
        return;
      }

      const now = Date.now();
      typingTimestamps.current = [...typingTimestamps.current.slice(-4), now];
      const intervals = typingTimestamps.current
        .slice(1)
        .map((value, index) => value - typingTimestamps.current[index]!);
      const debounceMs = resolveAdaptiveGhostDebounceMs(config.baseDebounceMs, intervals);

      if (timer.current) clearTimeout(timer.current);
      const previousRequestId = activeRequestId.current;
      if (previousRequestId) {
        // Отменяем устаревший запрос сразу: ответ не должен «догнать» курсор.
        activeRequestId.current = null;
        void service.cancel({ requestId: previousRequestId }).catch(() => {});
      }
      setState((previous) => ({ ...previous, isLoading: true }));

      timer.current = setTimeout(() => {
        timer.current = null;
        const requestId = nextRequestId();
        activeRequestId.current = requestId;
        void service
          .complete({
            requestId,
            workspacePath: options.workspacePath,
            ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
            prefix: promptState.text.slice(-2_000),
            suffix: "",
            cursorAtEndOfLine: promptState.cursorAtEnd,
            ...(options.activeFilePath ? { activeFilePath: options.activeFilePath } : {}),
            openTabPaths: [...(options.openTabPaths ?? [])].slice(0, 8),
            context: config.context,
            debounceMs,
            ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}),
          })
          .then((response) => {
            if (!mounted.current || activeRequestId.current !== requestId) return;
            activeRequestId.current = null;
            setState({
              suggestion: response.suggestion,
              source: response.source,
              isLoading: false,
              prefix: promptState.text,
            });
          })
          .catch((error: unknown) => {
            if (!mounted.current || activeRequestId.current !== requestId) return;
            activeRequestId.current = null;
            setState(INITIAL_STATE);
            const code =
              error && typeof error === "object" && "code" in error
                ? String((error as { code: unknown }).code)
                : "model_failed";
            // Отмена/таймаут — нормальный сценарий ghost-текста, не ошибка пользователя.
            if (code === "aborted" || code === "timeout" || code === "empty_suggestion") return;
            logger.warn("Chat autocomplete failed", { code });
          });
      }, debounceMs);
    },
    [options, reset, state.isLoading, state.prefix, state.suggestion],
  );

  const accept = useCallback(
    (fullPrompt: string, acceptedSlice: string) => {
      setState(INITIAL_STATE);
      const service = options.service;
      if (!service) return;
      void service
        .recordAcceptedSuggestion({
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          fullPrompt,
          acceptedSlice,
        })
        .catch(() => {
          // Профиль лексики — вспомогательный: сбой записи не влияет на ввод.
        });
    },
    [options.service, options.workspaceIdentity, options.workspacePath],
  );

  const isStale = useCallback(
    (prefix: string) => state.prefix !== null && state.prefix !== prefix,
    [state.prefix],
  );

  return useMemo(
    () => ({ ...state, request, cancel, reset, accept, isStale }),
    [accept, cancel, isStale, request, reset, state],
  );
}
