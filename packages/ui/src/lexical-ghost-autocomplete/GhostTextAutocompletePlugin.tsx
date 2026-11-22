import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
} from "lexical";
import { $getPromptMarkdown } from "@/mentions/promptSerialization.js";
import { PROGRAMMATIC_UPDATE_TAG } from "@/lib/editorUpdateTags.js";
import { $createGhostTextNode, $isGhostTextNode, type GhostTextNode } from "./GhostTextNode.js";
import { takeNextWord, type ChatAutocompleteResponse } from "@zcode/shared";
import type { ChatAutocompleteState } from "./useChatAutocomplete.js";
import type { GhostAutocompleteConfig } from "./contract.js";

/**
 * `GhostTextAutocompletePlugin` — представление ghost-подсказки в Lexical.
 *
 * Порядок событий:
 * 1. Пользователь печатает → плагин собирает префикс и вызывает `chatAutocomplete.request`.
 * 2. Хук отдаёт `suggestion` → плагин вставляет `GhostTextNode` в конец параграфа
 *    с тегом `history-merge`, чтобы `Ctrl+Z` не отменял чужую правку.
 * 3. `Tab` заменяет ghost-узел на `TextNode` и фиксирует шаг истории;
 *    `ArrowRight` принимает одно слово, оставляя остаток; `Escape` скрывает до
 *    следующего изменения; клик по подсказке = принять всё.
 *
 * Совместимость: `Tab` регистрируется на `COMMAND_PRIORITY_LOW`, поэтому открытые
 * панели `/` и `@` (у них `CRITICAL`) продолжают забирать клавишу первыми.
 */

export interface GhostTextAutocompletePluginProps {
  config: GhostAutocompleteConfig;
  state: ChatAutocompleteState;
  request: (promptState: {
    text: string;
    cursorAtEnd: boolean;
    hasSelection: boolean;
    hasActiveTriggerPanel: boolean;
    isComposing: boolean;
  }) => void;
  cancel: () => void;
  reset: () => void;
  accept: (fullPrompt: string, acceptedSlice: string) => void;
  /** Открыта ли панель `/` или `@`: плагин обязан уступать им клавиши. */
  isTriggerPanelOpen: () => boolean;
}

const HISTORY_MERGE_TAG = "history-merge";

function $findGhostNode(): GhostTextNode | null {
  const lastParagraph = $getRoot().getLastChild();
  if (!lastParagraph || !$isParagraphNode(lastParagraph)) return null;
  const lastChild = lastParagraph.getLastChild();
  return $isGhostTextNode(lastChild) ? lastChild : null;
}

function $removeGhostNode(): void {
  const ghost = $findGhostNode();
  if (ghost) ghost.remove();
}

/**
 * Ставит ghost-узел последним ребёнком последнего параграфа.
 * Если подсказка уже стоит, обновляет текст вместо пересоздания (без мигания).
 */
function $upsertGhostNode(suggestion: string, source: string): void {
  const root = $getRoot();
  const lastParagraph = root.getLastChild();
  if (!lastParagraph) return;
  if (!$isParagraphNode(lastParagraph)) return;
  const existing = $findGhostNode();
  if (existing) {
    existing.setGhostText(suggestion);
    return;
  }
  const node = $createGhostTextNode({ text: suggestion, source });
  lastParagraph.append(node);
}

export function GhostTextAutocompletePlugin({
  config,
  state,
  request,
  cancel,
  reset,
  accept,
  isTriggerPanelOpen,
}: GhostTextAutocompletePluginProps) {
  const [editor] = useLexicalComposerContext();
  const composingRef = useRef(false);
  const dismissedRef = useRef<string | null>(null);
  const lastSuggestionRef = useRef<string>("");
  const stateRef = useRef(state);
  stateRef.current = state;
  const configRef = useRef(config);
  configRef.current = config;

  /** Курсор в самом конце текста и без выделения. */
  const readSelectionState = (
    editorInstance: LexicalEditor,
  ): { cursorAtEnd: boolean; hasSelection: boolean; text: string } => {
    let text = "";
    let cursorAtEnd = false;
    let hasSelection = false;
    editorInstance.getEditorState().read(() => {
      text = $getPromptMarkdown();
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      hasSelection = !selection.isCollapsed();
      if (!selection.isCollapsed()) return;
      const anchor = selection.anchor;
      if (anchor.type !== "text") {
        // Пустой параграф/элементный якорь считаем «в конце».
        cursorAtEnd = true;
        return;
      }
      const node = anchor.getNode();
      const tail = node.getTextContent().slice(anchor.offset);
      cursorAtEnd = tail.length === 0 && !$findGhostNode();
    });
    return { cursorAtEnd, hasSelection, text };
  };

  // IME: во время композиции подсказку не запрашиваем и не показываем.
  useEffect(() => {
    return editor.registerRootListener((rootElement, previousRootElement) => {
      const start = () => {
        composingRef.current = true;
        cancel();
      };
      const end = () => {
        queueMicrotask(() => {
          composingRef.current = false;
        });
      };
      previousRootElement?.removeEventListener("compositionstart", start);
      previousRootElement?.removeEventListener("compositionend", end);
      rootElement?.addEventListener("compositionstart", start);
      rootElement?.addEventListener("compositionend", end);
    });
  }, [cancel, editor]);

  // Сбор префикса и запрос: любое изменение текста инвалидирует прошлую подсказку.
  useEffect(() => {
    return editor.registerUpdateListener(({ tags, dirtyLeaves, dirtyElements }) => {
      if (tags.has(PROGRAMMATIC_UPDATE_TAG) || tags.has(HISTORY_MERGE_TAG)) return;
      if (dirtyLeaves.size === 0 && dirtyElements.size === 0) return;
      const { cursorAtEnd, hasSelection, text } = readSelectionState(editor);
      // Пользователь продолжил печатать: старая подсказка больше не актуальна.
      if (dismissedRef.current !== null && dismissedRef.current !== text) {
        dismissedRef.current = null;
      }
      if (dismissedRef.current === text) {
        $removeGhostNodeInUpdate(editor);
        return;
      }
      request({
        text,
        cursorAtEnd,
        hasSelection,
        hasActiveTriggerPanel: isTriggerPanelOpen(),
        isComposing: composingRef.current,
      });
    });
  }, [editor, isTriggerPanelOpen, request]);

  // Отрисовка подсказки: только когда текст не изменился и ghost ещё не отклонён.
  useEffect(() => {
    if (dismissedRef.current !== null) return;
    if (!state.suggestion) {
      if (lastSuggestionRef.current) {
        $removeGhostNodeInUpdate(editor);
        lastSuggestionRef.current = "";
      }
      return;
    }
    if (lastSuggestionRef.current === state.suggestion) return;
    lastSuggestionRef.current = state.suggestion;
    editor.update(
      () => {
        // ghost-нода не должна оставаться, если панель триггера открылась.
        if (isTriggerPanelOpen()) {
          $removeGhostNode();
          return;
        }
        $upsertGhostNode(state.suggestion, state.source ?? "model");
      },
      { tag: HISTORY_MERGE_TAG },
    );
  }, [editor, isTriggerPanelOpen, state.source, state.suggestion]);

  // Клавиши. Tab — LOW: панели `/` и `@` с CRITICAL забирают его первыми.
  useEffect(() => {
    const acceptAll = () => {
      const suggestion = stateRef.current.suggestion;
      if (!suggestion) return false;
      let accepted = "";
      editor.update(
        () => {
          const ghost = $findGhostNode();
          if (!ghost) return;
          accepted = ghost.getGhostText();
          const replacement = $createTextNode(accepted);
          ghost.replace(replacement);
          replacement.selectEnd();
        },
        // Без history-merge: принятие подсказки — полноценный шаг Undo.
      );
      if (accepted) {
        const fullText = readSelectionState(editor).text;
        accept(fullText, accepted);
      }
      lastSuggestionRef.current = "";
      return Boolean(accepted);
    };

    const acceptWord = () => {
      const suggestion = stateRef.current.suggestion;
      if (!suggestion) return false;
      const { word, rest } = takeNextWord(suggestion);
      if (!word) return false;
      editor.update(() => {
        const ghost = $findGhostNode();
        if (!ghost) return;
        const paragraph = ghost.getParent();
        if (!paragraph) return;
        const acceptedNode = $createTextNode(word);
        ghost.insertBefore(acceptedNode);
        if (rest) ghost.setGhostText(rest);
        else ghost.remove();
        acceptedNode.selectEnd();
      });
      // Словесное принятие тоже шаг истории; профиль лексики пополняется как принятие.
      accept(readSelectionState(editor).text, word);
      lastSuggestionRef.current = rest;
      return true;
    };

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (event?.isComposing) return false;
        if (isTriggerPanelOpen()) return false;
        if (!stateRef.current.suggestion) return false;
        event?.preventDefault();
        event?.stopPropagation();
        return acceptAll();
      },
      COMMAND_PRIORITY_LOW,
    );

    const unregisterArrowRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        if (configRef.current.keymap.acceptWord !== "ArrowRight") return false;
        if (event?.isComposing || event?.shiftKey || event?.altKey || event?.metaKey) {
          return false;
        }
        if (isTriggerPanelOpen()) return false;
        const { hasSelection } = readSelectionState(editor);
        if (hasSelection) return false;
        if (!stateRef.current.suggestion) return false;
        event?.preventDefault();
        return acceptWord();
      },
      COMMAND_PRIORITY_LOW,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        if (isTriggerPanelOpen()) return false;
        if (!stateRef.current.suggestion) return false;
        event?.preventDefault();
        dismissedRef.current = readSelectionState(editor).text;
        cancel();
        reset();
        lastSuggestionRef.current = "";
        editor.update(() => $removeGhostNode(), { tag: HISTORY_MERGE_TAG });
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterTab();
      unregisterArrowRight();
      unregisterEscape();
    };
  }, [accept, cancel, editor, isTriggerPanelOpen, reset]);

  // Клик по подсказке принимает её целиком (мышь — равноправный ввод).
  useEffect(() => {
    return editor.registerRootListener((rootElement, previousRootElement) => {
      const handler = (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.getAttribute("data-testid") !== "chat-ghost-text") return;
        event.preventDefault();
        if (!stateRef.current.suggestion) return;
        editor.update(() => {
          const ghost = $findGhostNode();
          if (!ghost) return;
          const accepted = ghost.getGhostText();
          const replacement = $createTextNode(accepted);
          ghost.replace(replacement);
          replacement.selectEnd();
        });
        lastSuggestionRef.current = "";
        accept(readSelectionState(editor).text, stateRef.current.suggestion);
      };
      previousRootElement?.removeEventListener("click", handler);
      rootElement?.addEventListener("click", handler);
      return () => {
        rootElement?.removeEventListener("click", handler);
      };
    });
  }, [accept, editor]);

  return null;
}

/** Удаление ghost-узла вне `editor.update` контекста вызова. */
function $removeGhostNodeInUpdate(editor: LexicalEditor): void {
  editor.update(() => $removeGhostNode(), { tag: HISTORY_MERGE_TAG });
}

export type { ChatAutocompleteResponse };
