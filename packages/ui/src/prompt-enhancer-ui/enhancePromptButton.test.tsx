import { describe, expect, it } from "vitest";
import { COMPOSER_ENHANCE_TARGET, isEnhancePromptEnabled, resolveEnhanceUndoText } from "./contract.js";

/**
 * Логика кнопки `Enhance Prompt`: активность по черновику и корректный откат.
 * Рендер в jsdom не нужен — состояния кнопки целиком выводятся из этих предикатов
 * плюс `useComposerPromptEnhance`, чьи переходы проверяются в сервисных тестах.
 */
describe("enhance prompt button contract", () => {
  it("неактивна на пустом и слишком коротком вводе", () => {
    expect(isEnhancePromptEnabled("", COMPOSER_ENHANCE_TARGET)).toBe(false);
    expect(isEnhancePromptEnabled("  ab  ", COMPOSER_ENHANCE_TARGET)).toBe(false);
  });

  it("активна на осмысленном черновике", () => {
    expect(isEnhancePromptEnabled("fix the parser", COMPOSER_ENHANCE_TARGET)).toBe(true);
  });

  it("для системного промпта требуется более длинный текст", () => {
    expect(isEnhancePromptEnabled("short prompt", { target: "custom_system_prompt", minDraftChars: 20, style: "deep_architectural" })).toBe(false);
  });

  it("возвращает исходный черновик для Undo и ничего при отсутствии изменений", () => {
    expect(resolveEnhanceUndoText("original draft", "enhanced draft")).toBe("original draft");
    expect(resolveEnhanceUndoText("same", "same")).toBeNull();
    expect(resolveEnhanceUndoText(undefined, "anything")).toBeNull();
  });

  it("цель композера — пользовательский промпт со structured-стилем", () => {
    expect(COMPOSER_ENHANCE_TARGET.target).toBe("chat_user_prompt");
    expect(COMPOSER_ENHANCE_TARGET.style).toBe("structured_engineering");
  });
});
