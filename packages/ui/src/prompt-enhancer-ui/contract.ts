import type { PromptEnhanceStyle, PromptEnhanceTarget } from "@zcode/shared";

/**
 * Контракт managed-модуля `ui-prompt-enhancer`.
 *
 * Модуль владеет только интерактивными поверхностями улучшения промпта: кнопкой в
 * композере и действием в редакторах системных инструкций. Транспорт и модель —
 * в `services-prompt-enhancer`; UI получает узкий порт и сервис из `useServices()`.
 */

/** Узкий порт сервиса: ровно то, что нужно кнопке. */
export interface PromptEnhancerServicePort {
  enhance(
    request: import("@zcode/shared").PromptEnhanceRequest,
  ): Promise<import("@zcode/shared").PromptEnhanceResult>;
  cancel(params: import("@zcode/shared").PromptEnhanceCancelParams): Promise<void>;
}

export interface EnhancePromptTargetDescriptor {
  target: PromptEnhanceTarget;
  /** Минимальная длина черновика, ниже которой кнопка неактивна. */
  minDraftChars: number;
  style: PromptEnhanceStyle;
}

/** Композер: кнопка живёт рядом с отправкой и работает по черновику. */
export const COMPOSER_ENHANCE_TARGET: EnhancePromptTargetDescriptor = {
  target: "chat_user_prompt",
  minDraftChars: 3,
  style: "structured_engineering",
};

/** Редактор кастомных системных инструкций: другая цель и более глубокая структура. */
export const SYSTEM_PROMPT_ENHANCE_TARGET: EnhancePromptTargetDescriptor = {
  target: "custom_system_prompt",
  minDraftChars: 20,
  style: "deep_architectural",
};

/** Кнопка активна только на непустом осмысленном черновике. */
export function isEnhancePromptEnabled(
  draftText: string,
  descriptor: EnhancePromptTargetDescriptor,
): boolean {
  return draftText.trim().length >= descriptor.minDraftChars;
}

/**
 * Откат должен вернуть ровно исходный черновик (вместе с mention-чипами),
 * поэтому «Undo» хранит текст, а не diff.
 */
export function resolveEnhanceUndoText(
  previousDraft: string | undefined,
  currentText: string,
): string | null {
  if (previousDraft === undefined) return null;
  if (previousDraft === currentText) return null;
  return previousDraft;
}
