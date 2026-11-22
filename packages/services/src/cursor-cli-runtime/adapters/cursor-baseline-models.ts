import type { CursorCliModelDescriptor } from "../contract.js";

/**
 * Документированный fallback-набор Cursor CLI. Публикуется, когда установленный бинарь
 * не отдаёт непустой список моделей, чтобы провайдер оставался выбираемым в Composer.
 * `source: "baseline"` отделяет эти записи от фактов, полученных от CLI.
 */
export const CURSOR_BASELINE_MODELS: readonly CursorCliModelDescriptor[] = Object.freeze(
  [
    ["composer-1", "Composer 1"],
    ["claude-4.5-sonnet", "Claude 4.5 Sonnet"],
    ["claude-4.5-haiku", "Claude 4.5 Haiku"],
    ["gpt-5", "GPT-5"],
    ["gpt-5-codex", "GPT-5 Codex"],
    ["gemini-3-pro", "Gemini 3 Pro"],
  ].map(([modelId, name]) =>
    Object.freeze({ modelId: modelId!, name: name!, source: "baseline" as const }),
  ),
);
