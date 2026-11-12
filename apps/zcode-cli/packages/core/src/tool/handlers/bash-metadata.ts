/**
 * Мелкие извлекатели полей Bash-входа.
 *
 * Здесь остался только `readStringProperty`: пять legacy-обёрток
 * (`getBashDescription`/`getBashUserFacingName`/`getBashToolUseSummary`/
 * `getBashActivityDescription`/`getBashAutoClassifierInput`) не вызывались ни из
 * одного модуля — их логика живёт прямо в `bash.ts` рядом с tool entry.
 */
export function readStringProperty(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || !(key in input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
