import {
  COMPOSER_ENHANCE_TARGET,
  isEnhancePromptEnabled,
  resolveEnhanceUndoText,
} from "./contract.js";

/** Кнопка композера: активна только на осмысленном черновике. */
export function canEnhanceComposerDraft(draftText: string): boolean {
  return isEnhancePromptEnabled(draftText, COMPOSER_ENHANCE_TARGET);
}

/** «Undo Enhance» возвращает ровно исходный текст или `null`, если откатывать нечего. */
export function undoEnhance(previousDraft: string | undefined, currentText: string): string | null {
  return resolveEnhanceUndoText(previousDraft, currentText);
}
