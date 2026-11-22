import type { ProactiveSuggestionRequest, ProactiveSuggestionResponse } from "@zcode/shared";

import type { ProactiveSuggestionRowLike } from "./context.js";

/** Минимальный порт сервиса: UI не знает о транспорте и дескрипторах. */
export interface ProactiveSuggestionServicePort {
  complete(request: ProactiveSuggestionRequest): Promise<ProactiveSuggestionResponse>;
  cancel(params: { requestId: string }): Promise<void>;
}

export interface ProactiveSuggestionSnapshotInput {
  sessionId: string | null;
  turnId: string | null;
  phase: string | null;
  draft: string;
  disabled: boolean;
}

export interface ProactiveSuggestionViewState {
  text: string | null;
  loading: boolean;
}

/** Единственный предикат триггера: completed + пустой draft + не disabled. */
export function canShowProactiveSuggestion(input: {
  enabled: boolean;
  hasService: boolean;
  phase: string | null;
  draft: string;
  disabled: boolean;
  sessionId: string | null;
  turnId: string | null;
  decided: boolean;
}): boolean {
  return (
    input.enabled &&
    input.hasService &&
    !input.disabled &&
    input.phase === "completedSuccess" &&
    input.draft.trim() === "" &&
    Boolean(input.sessionId) &&
    Boolean(input.turnId) &&
    !input.decided
  );
}

/** Turn identity: последняя строка проекции владеет turnId. */
export function resolveProactiveSuggestionTurnId(
  rows: readonly ProactiveSuggestionRowLike[],
): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const turnId = rows[index]?.turnId;
    if (turnId) return turnId;
  }
  return null;
}

/**
 * Сборка контекста и нормализация строк проекции вынесены в `context.ts`:
 * этот файл обязан оставаться в пределах max-contract-lines. Публичный API
 * модуля сохранён — импорты из `contract.js` продолжают работать.
 */
export {
  PROACTIVE_SUGGESTION_CONTEXT_LIMITS,
  buildProactiveSuggestionContext,
  buildProactiveSuggestionTransactionDiffs,
  readProactiveSuggestionOpenFilePaths,
  readProactiveSuggestionRows,
  type BuildProactiveSuggestionContextInput,
  type ProactiveSuggestionContextLimits,
  type ProactiveSuggestionDiffLike,
  type ProactiveSuggestionFileChangeLike,
  type ProactiveSuggestionRowLike,
  type ProactiveSuggestionTransactionFileLike,
  type ProactiveSuggestionTransactionLike,
  type ProactiveSuggestionUiContext,
} from "./context.js";
