import { describe, expect, it } from "vitest";
import {
  CHAT_AUTOCOMPLETE_MAX_PREFIX_CHARS,
  CHAT_AUTOCOMPLETE_MAX_SUGGESTION_CHARS,
  chatAutocompleteRequestSchema,
  chatAutocompleteResponseSchema,
  chatAutocompleteSettingsSchema,
} from "./contract.js";
import {
  clipGhostSuggestion,
  detectAssistantVoiceSuggestion,
  detectLexiconLanguage,
  filterAssistantVoiceSuggestion,
  removePrefixOverlap,
  sanitizeForLexicon,
  shannonEntropyPerChar,
  takeNextWord,
} from "./postprocess.js";
import { sharedChatAutocompleteModule } from "./module.js";

const baseRequest = {
  requestId: "req_autocomplete_0001",
  workspacePath: "/repo/zcode",
  prefix: "исправь гонку субагентов в ",
} as const;

describe("chat-autocomplete module manifest", () => {
  it("declares the managed module id", () => {
    expect(sharedChatAutocompleteModule.id).toBe("shared-chat-autocomplete");
  });
});

describe("chat-autocomplete request contract", () => {
  it("defaults context switches, suffix and open tabs", () => {
    const parsed = chatAutocompleteRequestSchema.parse(baseRequest);
    expect(parsed.context).toEqual({
      history: true,
      openFiles: true,
      diffs: true,
      codeIndex: true,
      userLexicon: true,
    });
    expect(parsed.suffix).toBe("");
    expect(parsed.openTabPaths).toEqual([]);
    expect(parsed.cursorAtEndOfLine).toBe(true);
  });

  it("rejects unknown fields so transports cannot smuggle extra payload", () => {
    expect(chatAutocompleteRequestSchema.safeParse({ ...baseRequest, extra: "nope" }).success).toBe(
      false,
    );
  });

  it("enforces prefix limits and the minimum sensible length", () => {
    expect(chatAutocompleteRequestSchema.safeParse({ ...baseRequest, prefix: "abc" }).success).toBe(
      false,
    );
    expect(
      chatAutocompleteRequestSchema.safeParse({
        ...baseRequest,
        prefix: "x".repeat(CHAT_AUTOCOMPLETE_MAX_PREFIX_CHARS + 1),
      }).success,
    ).toBe(false);
  });

  it("accepts each context toggle independently", () => {
    const parsed = chatAutocompleteRequestSchema.parse({
      ...baseRequest,
      context: {
        history: false,
        openFiles: true,
        diffs: false,
        codeIndex: false,
        userLexicon: false,
      },
    });
    expect(parsed.context).toMatchObject({
      history: false,
      openFiles: true,
      diffs: false,
    });
  });
});

describe("chat-autocomplete response contract", () => {
  it("keeps the suggestion empty-capable but requires source and latency", () => {
    const parsed = chatAutocompleteResponseSchema.parse({
      requestId: "req_autocomplete_0001",
      suggestion: "",
      source: "prefix_cache_exact",
      latencyMs: 0,
    });
    expect(parsed.suggestion).toBe("");
    expect(parsed.modelUsed).toBeNull();
  });

  it("rejects an unknown source", () => {
    expect(
      chatAutocompleteResponseSchema.safeParse({
        requestId: "req_autocomplete_0001",
        suggestion: "ok",
        source: "magic",
        latencyMs: 1,
      }).success,
    ).toBe(false);
  });
});

describe("ghost suggestion post-processing", () => {
  it("cuts multi-line model output to the first line", () => {
    expect(clipGhostSuggestion("добавь тесты на реестр\nвторой абзац")).toBe(
      "добавь тесты на реестр",
    );
  });

  it("drops trailing code comments and enforces the char cap", () => {
    expect(clipGhostSuggestion("верни диффы // внутренний комментарий")).toBe("верни диффы");
    expect(
      clipGhostSuggestion("a".repeat(CHAT_AUTOCOMPLETE_MAX_SUGGESTION_CHARS + 40)),
    ).toHaveLength(CHAT_AUTOCOMPLETE_MAX_SUGGESTION_CHARS);
  });

  it("removes overlap on a BPE boundary without gluing words", () => {
    expect(removePrefixOverlap("исправь гонку", "гонку субагентов")).toBe(" субагентов");
    expect(removePrefixOverlap("добавь ", "тесты в пакет")).toBe("тесты в пакет");
  });

  it("takes exactly one next word for ArrowRight acceptance", () => {
    expect(takeNextWord("  субагентов через FileLockRegistry")).toEqual({
      word: "  субагентов ",
      rest: "через FileLockRegistry",
    });
    expect(takeNextWord("одно")).toEqual({ word: "одно", rest: "" });
  });
});

describe("assistant voice filter", () => {
  it("rejects the observed assistant plan for the Russian draft", () => {
    const phrase = "Сначала изучу текущую архитектуру и `searchChannels.ts`, затем проверю";
    expect(detectAssistantVoiceSuggestion(phrase)).toBe("assistant_action_plan");
    expect(filterAssistantVoiceSuggestion(phrase)).toBe("");
  });

  it("rejects first-person action plans in Russian and English", () => {
    for (const phrase of [
      "Затем проверю",
      "Проверю сборку и тесты",
      "Изучу текущую архитектуру",
      "Сначала я посмотрю реестр",
      "Давайте посмотрим",
      "First, I will inspect the module",
      "I'll check the tests",
      "Let me look at the schema",
    ]) {
      expect(filterAssistantVoiceSuggestion(phrase), phrase).toBe("");
    }
  });

  it("rejects assistant meta commentary and markdown plans", () => {
    for (const phrase of [
      "Конечно, вот что я предлагаю",
      "Надеюсь, это поможет",
      "Here's the plan",
      "# План",
      "```ts",
      "Шаги: 1. Проверить сборку",
      "Step 1: read the schema",
    ]) {
      expect(filterAssistantVoiceSuggestion(phrase), phrase).toBe("");
    }
  });

  it("keeps legitimate user-voice continuations unchanged", () => {
    for (const phrase of [
      "Сначала надо проверить текущую архитектуру",
      "Сначала нужно изучить альтернативы",
      "Проверить, что сборка остаётся зелёной",
      "Изучить зрелые инструменты и выбрать два",
      "Затем добавить тесты на реестр",
      "1. Добавить тесты на реестр",
    ]) {
      expect(filterAssistantVoiceSuggestion(phrase), phrase).toBe(phrase);
    }
  });

  it("sees through quotes, markdown emphasis and list bullets", () => {
    expect(filterAssistantVoiceSuggestion("**Сначала изучу** модуль")).toBe("");
    expect(filterAssistantVoiceSuggestion("- Затем проверю тесты")).toBe("");
    expect(filterAssistantVoiceSuggestion("«Проверю сборку»")).toBe("");
  });
});

describe("chat autocomplete settings defaults", () => {
  it("enables ghost autocomplete by default with bounded cost knobs", () => {
    const parsed = chatAutocompleteSettingsSchema.parse({});
    expect(parsed.enabled).toBe(true);
    expect(parsed.minPrefixChars).toBe(6);
    expect(parsed.debounceMs).toBe(250);
  });
});

describe("lexicon privacy filter", () => {
  it("strips API keys, bearer tokens and emails", () => {
    const cleaned = sanitizeForLexicon(
      "проверь sk-abcdefgh12345678 и ghp_ABCDEFGHIJ0123, пиши на dev@example.com",
    );
    expect(cleaned).toContain("проверь");
    expect(cleaned).not.toContain("sk-");
    expect(cleaned).not.toContain("ghp_");
    expect(cleaned).not.toContain("@example.com");
  });

  it("strips home-directory paths and password assignments", () => {
    const cleaned = sanitizeForLexicon("открой /home/alice/secret/project и password=hunter2super");
    expect(cleaned).not.toContain("/home/alice");
    expect(cleaned?.toLowerCase()).not.toContain("password=");
  });

  it("drops high-entropy tokens and returns null for an unusable line", () => {
    expect(shannonEntropyPerChar("aaaaaaaa")).toBeLessThan(1);
    expect(shannonEntropyPerChar("q7Xv2Lm9Pd4Rz8Kt1Nb6")).toBeGreaterThan(4);
    expect(sanitizeForLexicon("q7Xv2Lm9Pd4Rz8Kt1Nb6Wc3Yh5")).toBeNull();
  });

  it("detects the user language by script", () => {
    expect(detectLexiconLanguage("добавь юнит-тесты")).toBe("ru");
    expect(detectLexiconLanguage("添加单元测试")).toBe("zh");
    expect(detectLexiconLanguage("please add unit tests")).toBe("en");
    expect(detectLexiconLanguage("   ")).toBe("unknown");
  });
});
