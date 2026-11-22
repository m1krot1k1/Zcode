import { useCallback, useMemo, useRef } from "react";
import type { ReactNode, RefObject } from "react";

import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

import { useSettings } from "@/hooks/useSettingService.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import {
  selectSessionFileTransactions,
  useFileTransactionStore,
} from "@/store/fileTransactionStore.js";
import { resolveProactiveSuggestionTurnId } from "./contract.js";
import {
  buildProactiveSuggestionContext,
  buildProactiveSuggestionTransactionDiffs,
  readProactiveSuggestionOpenFilePaths,
  readProactiveSuggestionRows,
  type ProactiveSuggestionUiContext,
} from "./context.js";
import { useComposerProactiveSuggestion } from "./useComposerProactiveSuggestion.js";

/** Identity-срез композера: адаптер читает только snapshot/session/workspace поля. */
export interface ConversationProactiveSuggestionComposer {
  snapshot: ConversationSnapshot | null;
  sessionId?: string | null | undefined;
  workspacePath: string;
  workspaceIdentity?: string | undefined;
}

export interface UseConversationProactiveSuggestionOptions {
  /** Композер передаёт себя: адаптер читает только identity-поля и snapshot. */
  composer: ConversationProactiveSuggestionComposer;
  draft: string;
  disabled: boolean;
  /** Владелец текста: `setText`/`focus` редактора, без второго состояния. */
  inputApiRef: RefObject<LexicalChatInputHandle | null>;
  updateText: (next: string) => void;
  scheduleDraftPersist: () => void;
  /** Top content композера; подсказка рендерится над ним в той же surface. */
  topContentNode: ReactNode;
}

/** Контейнер composer region: только его focusout/keydown гасят подсказку. */
export interface ConversationProactiveSuggestionSurface {
  topContentNode: ReactNode;
  containerRef: RefObject<HTMLDivElement | null>;
}

function toSessionId(composer: ConversationProactiveSuggestionComposer): string | null {
  return composer.sessionId ?? null;
}

/**
 * Адаптер проактивной подсказки: ленивый контекст (rows/openFiles/diffs),
 * вычисление turn identity и принятие с заполнением существующего draft.
 * Поведение принадлежит `useComposerProactiveSuggestion` и контроллеру;
 * здесь только зависимости композера и рендер над top content.
 */
export function useConversationProactiveSuggestion(
  options: UseConversationProactiveSuggestionOptions,
): ConversationProactiveSuggestionSurface {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const { settings: sharedSettings } = useSettings({ services: services ?? undefined });
  const { composer, draft, inputApiRef, updateText, scheduleDraftPersist, disabled } = options;
  const sessionId = toSessionId(composer);
  const { snapshot, workspacePath, workspaceIdentity } = composer;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // Снимок проекции для ленивого чтения в момент запроса: обновляется каждым render
  // композера, поэтому provider видит актуальные строки, не подписывая контроллер.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rows = useMemo(() => readProactiveSuggestionRows(snapshot), [snapshot]);
  const turnId = useMemo(() => resolveProactiveSuggestionTurnId(rows), [rows]);
  // Контекст собирается лениво в момент запроса: openFiles живут в side-pane memory,
  // диффы — в fileTransactionStore, rows — в актуальном snapshotRef.
  const contextProvider = useCallback((): ProactiveSuggestionUiContext => {
    const currentSnapshot = snapshotRef.current;
    const currentSessionId = currentSnapshot?.sessionId ?? sessionId;
    const transactions = currentSessionId
      ? selectSessionFileTransactions(
          useFileTransactionStore.getState(),
          workspaceKey,
          currentSessionId,
        )
      : [];
    return buildProactiveSuggestionContext({
      rows: readProactiveSuggestionRows(currentSnapshot),
      openFiles: readProactiveSuggestionOpenFilePaths({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      }),
      diffs: buildProactiveSuggestionTransactionDiffs(transactions),
    });
  }, [sessionId, workspaceIdentity, workspaceKey, workspacePath]);
  const labels = useMemo(
    () => ({
      loading: intl.formatMessage({ id: "composer.proactiveSuggestion.loading" }),
      hint: intl.formatMessage({ id: "composer.proactiveSuggestion.hint" }),
      dismiss: intl.formatMessage({ id: "composer.proactiveSuggestion.dismiss" }),
    }),
    [intl],
  );
  const focusEditor = useCallback(() => {
    inputApiRef.current?.focus();
  }, [inputApiRef]);
  // Принятие заполняет существующий draft владельца (`updateText` + setText + persist)
  // и возвращает фокус; автоотправки нет.
  const acceptSuggestion = useCallback(
    (suggestion: string) => {
      const next = suggestion.trim();
      if (!next) return;
      inputApiRef.current?.setText(next);
      updateText(next);
      scheduleDraftPersist();
      inputApiRef.current?.focus();
    },
    [inputApiRef, scheduleDraftPersist, updateText],
  );
  const suggestion = useComposerProactiveSuggestion({
    service: services?.proactiveSuggestionService ?? null,
    settings: sharedSettings?.proactiveSuggestionSettings,
    sessionId,
    turnId,
    phase: snapshot?.control.phase ?? null,
    draft,
    disabled,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    contextProvider,
    labels,
    containerRef,
    onAccept: acceptSuggestion,
    focusEditor,
  });
  // Подсказка рендерится над строкой ввода внутри той же composer surface;
  // attachment/chip topContent остаётся отдельным memo владельца.
  const topContentNode = (
    <>
      {suggestion.node}
      {options.topContentNode}
    </>
  );
  return { topContentNode, containerRef };
}
