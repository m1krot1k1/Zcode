import { describe, expect, it } from "vitest";
import { parseCursorModelCatalog } from "../src/cursor-cli-runtime/adapters/cursorModelCatalogParser.js";

describe("parseCursorModelCatalog", () => {
  it("пропускает заголовки, маркеры текущей модели и дубликаты", () => {
    const models = parseCursorModelCatalog(
      [
        "Available models",
        "",
        "composer - Composer 1",
        "* claude-4.5-sonnet - Claude 4.5 Sonnet (current)",
        "> gpt-5 - GPT-5",
        "gpt-5 - GPT-5 duplicate",
        "✓ gemini-3-pro - Gemini 3 Pro",
        "-------------",
      ].join("\n"),
    );

    expect(models.map((model) => model.modelId)).toEqual([
      "composer",
      "claude-4.5-sonnet",
      "gpt-5",
      "gemini-3-pro",
    ]);
    expect(models[1]).toEqual({
      modelId: "claude-4.5-sonnet",
      name: "Claude 4.5 Sonnet",
      source: "cli",
    });
  });

  it("игнорирует небезопасные и пустые идентификаторы", () => {
    const models = parseCursorModelCatalog(
      ["composer-1 Composer 1", "bad id with spaces", "; rm -rf /", "\t", "gpt-5"].join("\n"),
    );
    // `bad` валиден как первый токен; `;` и пустые строки отбрасываются.
    expect(models.map((model) => model.modelId)).toEqual(["composer-1", "bad", "gpt-5"]);
  });

  it("не публикует строку Tip как модель", () => {
    const models = parseCursorModelCatalog(
      [
        "auto - Auto",
        "composer-1 - Composer 1",
        'Tip: run "cursor-agent models" again after signing in',
        "Note: model names may change",
      ].join("\n"),
    );

    expect(models.map((model) => model.modelId)).toEqual(["auto", "composer-1"]);
  });

  it("возвращает пустой массив для пустого вывода", () => {
    expect(parseCursorModelCatalog("")).toEqual([]);
  });
});
