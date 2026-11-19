import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import type { ProactiveSuggestionContext, ProactiveSuggestionSettings } from "@zcode/shared";

import {
  ComposerProactiveSuggestion,
  type ComposerProactiveSuggestionLabels,
} from "./ComposerProactiveSuggestion.js";
import {
  createProactiveSuggestionController,
  type ProactiveSuggestionController,
} from "./controller.js";
import type { ProactiveSuggestionServicePort, ProactiveSuggestionViewState } from "./contract.js";

export interface UseComposerProactiveSuggestionOptions {
  service: ProactiveSuggestionServicePort | null | undefined;
  settings?: ProactiveSuggestionSettings | undefined;
  sessionId: string | null;
  turnId: string | null;
  phase: string | null;
  draft: string;
  disabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  /** Снимок контекста; читается контроллером в момент запроса. */
  context?: ProactiveSuggestionContext | undefined;
  /** Приоритетный ленивый источник: вызывается только при старте запроса. */
  contextProvider?: (() => ProactiveSuggestionContext) | undefined;
  labels: ComposerProactiveSuggestionLabels;
  /** Реальный DOM-контейнер композера: только его focusout/keydown участвуют в lifecycle. */
  containerRef?: RefObject<HTMLElement | null> | undefined;
  onAccept: (text: string) => void;
  /** Возврат фокуса в contenteditable после принятия подсказки кликом. */
  focusEditor?: (() => void) | undefined;
  logger?: (message: string, meta?: Record<string, unknown>) => void;
}

const EMPTY_STATE: ProactiveSuggestionViewState = { text: null, loading: false };
const EMPTY_CONTEXT: ProactiveSuggestionContext = {
  messages: [],
  assistantResult: null,
  toolResults: [],
  testResults: [],
  diffs: [],
  openFiles: [],
};

export interface UseComposerProactiveSuggestionResult {
  node: React.ReactNode;
  focus: () => void;
}

function isEditorTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest('[contenteditable="true"]') !== null;
}

/**
 * React-обёртка чистого контроллера: подписка на focus/keydown внутри реального
 * контейнера композера, синхронизация входных данных и рендер подсказки.
 * Состояние текста принадлежит контроллеру.
 */
export function useComposerProactiveSuggestion(
  options: UseComposerProactiveSuggestionOptions,
): UseComposerProactiveSuggestionResult {
  const [state, setState] = useState<ProactiveSuggestionViewState>(EMPTY_STATE);
  const enabled = options.settings?.enabled ?? true;
  const hintRef = useRef<HTMLDivElement | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Bug 原因: memo зависел от identity `options.service`, и каждый рендер создавал
  // новый контроллер, отменяя in-flight запрос. Прокси стабилен, а транспорт
  // читается лениво из latest options; пересоздание — только при смене наличия сервиса.
  const hasService = Boolean(options.service);
  const stableServiceRef = useRef<ProactiveSuggestionServicePort | null>(null);
  if (hasService && !stableServiceRef.current) {
    stableServiceRef.current = {
      complete: (request) => {
        const service = optionsRef.current.service;
        return service
          ? service.complete(request)
          : Promise.reject(new Error("proactive suggestion service unavailable"));
      },
      cancel: (params) => {
        const service = optionsRef.current.service;
        return service ? service.cancel(params) : Promise.resolve();
      },
    };
  }
  if (!hasService) stableServiceRef.current = null;

  const controller = useMemo<ProactiveSuggestionController>(() => {
    return createProactiveSuggestionController({
      service: stableServiceRef.current,
      enabled,
      workspacePath: options.workspacePath,
      workspaceIdentity: options.workspaceIdentity,
      contextProvider: () =>
        optionsRef.current.contextProvider?.() ?? optionsRef.current.context ?? EMPTY_CONTEXT,
      onStateChange: setState,
      logger: (message, meta) => optionsRef.current.logger?.(message, meta),
    });
  }, [
    enabled,
    hasService,
    // logger намеренно читается через optionsRef: нестабильный callback не должен
    // пересоздавать контроллер и отменять уже отправленный запрос.
    options.workspaceIdentity,
    options.workspacePath,
  ]);

  // Смена контроллера (disable/enable, другой workspace) сбрасывает видимый текст,
  // не помечая turn decided: повторное включение допускает новый focus-trigger.
  useEffect(() => {
    setState(EMPTY_STATE);
  }, [controller]);

  useEffect(() => {
    controller.sync({
      sessionId: options.sessionId,
      turnId: options.turnId,
      phase: options.phase,
      draft: options.draft,
      disabled: options.disabled,
    });
  }, [
    controller,
    options.disabled,
    options.draft,
    options.phase,
    options.sessionId,
    options.turnId,
  ]);

  useEffect(() => () => controller.dispose(), [controller]);

  const accept = useCallback(() => {
    const text = controller.accept();
    if (!text) return;
    optionsRef.current.onAccept(text);
    optionsRef.current.focusEditor?.();
  }, [controller]);

  useEffect(() => {
    const container = options.containerRef?.current;
    if (!container) return undefined;
    const isInside = (node: Node | null): boolean => node !== null && container.contains(node);
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      // Уход фокуса в другой редактор (например, в соседнюю панель) не blur:
      // подсказка принадлежит композеру и не должна исчезать от чужого редактора.
      if (isEditorTarget(next)) return;
      if (isInside(next instanceof Node ? next : null)) return;
      if (hintRef.current && next instanceof Node && hintRef.current.contains(next)) {
        return;
      }
      controller.blur();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (isEditorTarget(event.target)) controller.focus();
    };
    const onClick = (event: MouseEvent) => {
      if (isEditorTarget(event.target)) controller.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const current = controller.getState();
      // Escape обязан работать и во время loading, когда текста ещё нет.
      if (!current.text && !current.loading) return;
      if (event.key === "Tab") {
        if (!current.text || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
          return;
        }
        event.preventDefault();
        accept();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        controller.dismiss();
      }
    };
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("focusout", onFocusOut);
    container.addEventListener("click", onClick);
    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
      container.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [accept, controller, options.containerRef]);

  return {
    node: (
      <ComposerProactiveSuggestion
        text={state.text}
        loading={state.loading}
        labels={options.labels}
        hintRef={hintRef}
        onAccept={accept}
        onDismiss={() => controller.dismiss()}
      />
    ),
    focus: () => controller.focus(),
  };
}
