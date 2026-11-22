import { describe, expect, it } from "vitest";
import { resolveAdaptiveGhostDebounceMs, takeNextWord } from "./postprocess.js";
import {
  CHAT_AUTOCOMPLETE_REQUEST_TIMEOUT_MS,
  chatAutocompleteRequestSchema,
} from "./contract.js";

/**
 * Семантика клавиш и дебаунса, на которую опирается Lexical-плагин.
 *
 * `takeNextWord` — ровно то, что делает `ArrowRight` (принять слово и оставить
 * остаток); `resolveAdaptiveGhostDebounceMs` — то, что защищает от «мигания»
 * подсказок при быстром наборе. Плагин — тонкий адаптер над этими функциями.
 */
describe("ghost autocomplete key semantics", () => {
  it("принимает одно слово и оставляет остаток подсказки", () => {
    expect(takeNextWord("write the failing test first")).toEqual({
      word: "write ",
      rest: "the failing test first",
    });
  });

  it("возвращает пустое слово, когда принимать нечего", () => {
    expect(takeNextWord("").word).toBe("");
    expect(takeNextWord("   ").word).toBe("");
  });

  it("растёт при быстром наборе и ограничен 700 мс", () => {
    const base = 250;
    expect(resolveAdaptiveGhostDebounceMs(base, [])).toBe(base);
    const fast = resolveAdaptiveGhostDebounceMs(base, [40, 50, 60]);
    expect(fast).toBeGreaterThan(base);
    expect(resolveAdaptiveGhostDebounceMs(base, [10, 10, 10, 10])).toBeLessThanOrEqual(700);
    // Медианный человеческий темп не должен замедлять подсказку.
    expect(resolveAdaptiveGhostDebounceMs(base, [300, 350, 400])).toBe(base);
  });

  it("жёсткий таймаут запроса не превышает 1200 мс", () => {
    expect(CHAT_AUTOCOMPLETE_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(1_200);
  });

  it("запрос без обязательных полей отклоняется до обращения к модели", () => {
    expect(
      chatAutocompleteRequestSchema.safeParse({
        requestId: "req_1",
        workspacePath: "/w",
        prefix: "abc",
        cursorAtEndOfLine: true,
      }).success,
    ).toBe(false);
    expect(
      chatAutocompleteRequestSchema.safeParse({
        requestId: "req_12345678",
        workspacePath: "/w",
        prefix: "please add unit tests for the parser",
        cursorAtEndOfLine: true,
      }).success,
    ).toBe(true);
  });
});
