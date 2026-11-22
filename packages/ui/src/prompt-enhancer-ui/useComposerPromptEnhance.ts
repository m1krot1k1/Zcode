import { useCallback, useEffect, useRef, useState } from "react";
import type { PromptEnhanceResult } from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { usePromptEnhancer } from "@/hooks/usePromptEnhancer.js";
import { logger } from "@/logger.js";
import { COMPOSER_ENHANCE_TARGET, isEnhancePromptEnabled } from "./contract.js";

/**
 * Единственный владелец состояния «Улучшить промпт» в композере.
 *
 * Живёт в `ConversationComposer`, поэтому кнопка и slash-команда `/enhance`
 * видят один и тот же запрос: нельзя запустить два параллельных улучшения
 * или показать «Отменить» в одном месте при уже завершённом запросе.
 *
 * Хук не знает о Lexical: применение текста делегируется `onApply`.
 */

export interface UseComposerPromptEnhanceOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId?: string | null;
  collaborationMode?: string;
  activeFilePaths?: readonly string[];
  /** Записать улучшенный текст в редактор (Undo-совместимо). */
  onApply: (enhancedText: string) => void;
}

export interface ComposerPromptEnhancePreview {
  before: string;
  after: string;
  result: PromptEnhanceResult;
}

export interface ComposerPromptEnhanceState {
  /** Сервис и настройка доступны: кнопку можно показывать. */
  available: boolean;
  /** Включено в настройках (`promptEnhancerSettings.enabled`). */
  enabledBySettings: boolean;
  /** Автоустановка предложенных навыков (`autoInstallSuggestedSkills`, по умолчанию true). */
  autoInstallSuggestedSkills: boolean;
  isRunning: boolean;
  /** Черновик достаточно содержателен для запуска. */
  canEnhance: boolean;
  /** Исходный черновик доступен для отката. */
  canUndo: boolean;
  /** Последний улучшенный текст; уже применён в редактор. */
  lastResult: ComposerPromptEnhancePreview | null;
  errorCode: string | null;
  enhance: (draftText: string) => Promise<boolean>;
  cancel: () => Promise<void>;
  undo: () => void;
}

const UNDO_VISIBLE_MS = 30_000;

export function useComposerPromptEnhance(
  options: UseComposerPromptEnhanceOptions,
): ComposerPromptEnhanceState {
  const services = useOptionalServices();
  const service = services?.promptEnhancerService ?? null;
  const { settings } = useSettings({ services: services ?? undefined });
  const enhancerSettings = settings?.promptEnhancerSettings;
  const enabledBySettings = enhancerSettings?.enabled ?? true;
  const autoInstallSuggestedSkills = enhancerSettings?.autoInstallSuggestedSkills ?? true;
  const [canUndo, setCanUndo] = useState(false);
  // Последний результат нужен автоустановке предложенных навыков и Undo. Это не
  // consent-граница: улучшенный текст уже записан в редактор сразу после ответа модели.
  const [lastResult, setLastResult] = useState<ComposerPromptEnhancePreview | null>(null);
  const [appliedOriginal, setAppliedOriginal] = useState<string | null>(null);
  const undoExpiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { onApply } = options;

  const clearUndo = useCallback(() => {
    if (undoExpiry.current) clearTimeout(undoExpiry.current);
    undoExpiry.current = null;
    setCanUndo(false);
    setAppliedOriginal(null);
  }, []);

  const showUndo = useCallback(() => {
    setCanUndo(true);
    if (undoExpiry.current) clearTimeout(undoExpiry.current);
    undoExpiry.current = setTimeout(() => setCanUndo(false), UNDO_VISIBLE_MS);
  }, []);

  useEffect(() => clearUndo, [clearUndo]);

  const enhancer = usePromptEnhancer({
    promptEnhancerService: service ?? {
      enhance: () => Promise.reject(new Error("prompt enhancer is unavailable")),
      cancel: () => Promise.resolve(),
      onStreamDelta: () => () => {},
    },
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    target: COMPOSER_ENHANCE_TARGET.target,
    style: COMPOSER_ENHANCE_TARGET.style,
    ...(options.collaborationMode ? { collaborationMode: options.collaborationMode } : {}),
    ...(options.activeFilePaths ? { activeFilePaths: options.activeFilePaths } : {}),
  });

  const enhance = useCallback(
    async (draftText: string): Promise<boolean> => {
      if (!service || !enabledBySettings) return false;
      if (!isEnhancePromptEnabled(draftText, COMPOSER_ENHANCE_TARGET)) return false;
      setLastResult(null);
      const result = await enhancer.enhance(draftText);
      if (!result) return false;
      // Пользователь не должен подтверждать «было/стало»: результат сразу заменяет
      // текст в композере, а Undo оставляет исходный черновик доступным.
      onApply(result.enhancedText);
      setAppliedOriginal(draftText);
      showUndo();
      setLastResult({ before: draftText, after: result.enhancedText, result });
      logger.info("Prompt enhancement applied", {
        target: COMPOSER_ENHANCE_TARGET.target,
        framework: result.framework,
        domain: result.domain,
        taskKind: result.taskKind,
        chars: result.enhancedText.length,
        capabilitySuggestionCount: result.capabilitySuggestions.length,
      });
      return true;
    },
    [enabledBySettings, enhancer, onApply, service, showUndo],
  );

  const cancel = useCallback(async () => {
    await enhancer.cancel();
  }, [enhancer]);

  const undo = useCallback(() => {
    const previousDraft = appliedOriginal ?? enhancer.undo();
    if (previousDraft !== undefined) onApply(previousDraft);
    clearUndo();
    enhancer.reset();
  }, [appliedOriginal, clearUndo, enhancer, onApply]);

  return {
    available: service !== null,
    enabledBySettings,
    autoInstallSuggestedSkills,
    isRunning: enhancer.isRunning,
    canEnhance: enabledBySettings,
    canUndo,
    lastResult,
    errorCode: enhancer.error?.code ?? null,
    enhance,
    cancel,
    undo,
  };
}
