import type { ProactiveSuggestionContext, ProactiveSuggestionRequest } from "@zcode/shared";

import {
  canShowProactiveSuggestion,
  type ProactiveSuggestionServicePort,
  type ProactiveSuggestionSnapshotInput,
  type ProactiveSuggestionViewState,
} from "./contract.js";

export interface ProactiveSuggestionControllerOptions {
  service: ProactiveSuggestionServicePort | null;
  enabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  contextProvider: () => ProactiveSuggestionContext;
  onStateChange: (state: ProactiveSuggestionViewState) => void;
  createRequestId?: () => string;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ProactiveSuggestionController {
  sync(input: ProactiveSuggestionSnapshotInput): void;
  focus(): void;
  blur(): void;
  draftChanged(text: string): void;
  accept(): string | null;
  dismiss(): void;
  dispose(): void;
  getState(): ProactiveSuggestionViewState;
}

const TERMINAL_CODES = new Set(["aborted", "timeout", "empty_suggestion"]);
/** Жёсткий лимит запросов на один turn: после двух попыток подсказка не запрашивается. */
export const PROACTIVE_SUGGESTION_MAX_ATTEMPTS = 2;

function turnKeyOf(input: ProactiveSuggestionSnapshotInput): string | null {
  if (!input.sessionId || !input.turnId) return null;
  return `${input.sessionId}:${input.turnId}`;
}

/**
 * Чистый контроллер подсказки (без React и DOM).
 *
 * - trigger — только focus/click при уже завершённом turn; переход
 *   phase→completed при установленном фокусе сам запрос не создаёт.
 * - blur во время in-flight отменяет и скрывает, но НЕ помечает turn decided;
 *   полученный текст кэшируется и показывается на повторном focus без запроса.
 * - decided навсегда ставят accept, Escape/dismiss и первый ввод текста.
 * - не более PROACTIVE_SUGGESTION_MAX_ATTEMPTS запросов на turn (blur тоже расходует попытку).
 */
export function createProactiveSuggestionController(
  options: ProactiveSuggestionControllerOptions,
): ProactiveSuggestionController {
  let input: ProactiveSuggestionSnapshotInput = {
    sessionId: null,
    turnId: null,
    phase: null,
    draft: "",
    disabled: false,
  };
  let currentTurnKey: string | null = null;
  let decided = false;
  let attempts = 0;
  let cachedText: string | null = null;
  let visibleText: string | null = null;
  let loading = false;
  let requestId: string | null = null;
  let sequence = 0;
  let autoId = 0;
  let disposed = false;

  const emit = (): void => {
    options.onStateChange({ text: visibleText, loading });
  };

  const cancelActive = (): void => {
    if (!loading && !requestId) return;
    sequence += 1;
    const id = requestId;
    requestId = null;
    loading = false;
    if (id && options.service) {
      void options.service.cancel({ requestId: id }).catch(() => {});
    }
  };

  const resetTurn = (): void => {
    cancelActive();
    decided = false;
    attempts = 0;
    cachedText = null;
    visibleText = null;
    loading = false;
    emit();
  };

  const start = (): void => {
    const service = options.service;
    const { sessionId, turnId } = input;
    if (!service || !sessionId || !turnId) return;
    const mySequence = (sequence += 1);
    const id = options.createRequestId?.() ?? `proactive-${Date.now()}-${(autoId += 1)}`;
    requestId = id;
    attempts += 1;
    loading = true;
    visibleText = null;
    emit();
    const request: ProactiveSuggestionRequest = {
      requestId: id,
      sessionId,
      turnId,
      draftEmpty: true,
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      context: options.contextProvider(),
    };
    const expectedTurnKey = `${sessionId}:${turnId}`;
    service.complete(request).then(
      (response) => {
        if (disposed || mySequence !== sequence) return;
        if (currentTurnKey !== expectedTurnKey) return;
        requestId = null;
        loading = false;
        if (response.suggestion) {
          cachedText = response.suggestion;
          visibleText = response.suggestion;
        } else {
          cachedText = null;
          visibleText = null;
        }
        emit();
      },
      (error: unknown) => {
        if (disposed || mySequence !== sequence) return;
        requestId = null;
        loading = false;
        visibleText = null;
        emit();
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "model_failed";
        if (!TERMINAL_CODES.has(code)) {
          options.logger?.("Proactive suggestion failed", { code });
        }
      },
    );
  };

  const accept = (): string | null => {
    if (!visibleText) return null;
    const text = visibleText;
    decided = true;
    cachedText = text;
    visibleText = null;
    loading = false;
    emit();
    return text;
  };

  return {
    sync(next) {
      const previousTurnKey = currentTurnKey;
      input = next;
      currentTurnKey = turnKeyOf(next);
      if (previousTurnKey !== currentTurnKey) {
        resetTurn();
        return;
      }
      if (next.disabled) {
        if (visibleText || loading || decided || attempts > 0 || cachedText) {
          resetTurn();
        }
        return;
      }
      const valid = next.phase === "completedSuccess" && !next.disabled && Boolean(currentTurnKey);
      if (!valid) {
        if (visibleText || loading) {
          cancelActive();
          visibleText = null;
          loading = false;
          emit();
        }
        return;
      }
      if (next.draft.trim() !== "" && (visibleText || loading)) {
        cancelActive();
        visibleText = null;
        loading = false;
        decided = true;
        emit();
      }
    },

    focus() {
      if (disposed) return;
      if (
        !canShowProactiveSuggestion({
          enabled: options.enabled,
          hasService: Boolean(options.service),
          phase: input.phase,
          draft: input.draft,
          disabled: input.disabled,
          sessionId: input.sessionId,
          turnId: input.turnId,
          decided,
        })
      ) {
        return;
      }
      if (visibleText) return;
      if (cachedText) {
        visibleText = cachedText;
        emit();
        return;
      }
      if (loading || attempts >= PROACTIVE_SUGGESTION_MAX_ATTEMPTS) return;
      start();
    },

    blur() {
      cancelActive();
      if (visibleText) visibleText = null;
      emit();
    },

    draftChanged(text) {
      if (text.trim() === "") return;
      if (visibleText || loading) {
        cancelActive();
        visibleText = null;
        loading = false;
        decided = true;
        emit();
      }
    },

    accept,

    dismiss() {
      if (!currentTurnKey) return;
      decided = true;
      cancelActive();
      visibleText = null;
      loading = false;
      emit();
    },

    dispose() {
      disposed = true;
      cancelActive();
      visibleText = null;
      loading = false;
    },

    getState() {
      return { text: visibleText, loading };
    },
  };
}
