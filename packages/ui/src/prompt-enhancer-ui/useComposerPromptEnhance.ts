import { useCallback, useEffect, useRef, useState } from "react";
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

export interface ComposerPromptEnhanceState {
  /** Сервис и настройка доступны: кнопку можно показывать. */
  available: boolean;
  /** Включено в настройках (`promptEnhancerSettings.enabled`). */
  enabledBySettings: boolean;
  isRunning: boolean;
  /** Черновик достаточно содержателен для запуска. */
  canEnhance: boolean;
  /** Исходный черновик доступен для отката. */
  canUndo: boolean;
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
  const [canUndo, setCanUndo] = useState(false);
  const undoExpiry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { onApply } = options;

  const clearUndo = useCallback(() => {
    if (undoExpiry.current) clearTimeout(undoExpiry.current);
    undoExpiry.current = null;
    setCanUndo(false);
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
      // Исходный черновик хранит сам хук (`previousDraft`), чтобы Undo возвращал байт-в-байт.
      const result = await enhancer.enhance(draftText);
      if (!result) return false;
      onApply(result.enhancedText);
      setCanUndo(true);
      if (undoExpiry.current) clearTimeout(undoExpiry.current);
      undoExpiry.current = setTimeout(() => setCanUndo(false), UNDO_VISIBLE_MS);
      logger.info("Prompt enhanced in composer", {
        target: COMPOSER_ENHANCE_TARGET.target,
        chars: result.enhancedText.length,
      });
      return true;
    },
    [enabledBySettings, enhancer, onApply, service],
  );

  const cancel = useCallback(async () => {
    await enhancer.cancel();
  }, [enhancer]);

  const undo = useCallback(() => {
    const previousDraft = enhancer.undo();
    if (previousDraft !== undefined) onApply(previousDraft);
    clearUndo();
  }, [clearUndo, enhancer, onApply]);

  return {
    available: service !== null,
    enabledBySettings,
    isRunning: enhancer.isRunning,
    canEnhance: enabledBySettings,
    canUndo,
    errorCode: enhancer.error?.code ?? null,
    enhance,
    cancel,
    undo,
  };
}
