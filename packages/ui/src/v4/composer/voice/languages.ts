import type { VoiceSpeechModel } from "@zcode/shared";

/**
 * Languages the user may pick for dictation: the current one plus every language the
 * catalog declares.
 *
 * The model catalog is filtered by the current language, so a single model must never
 * narrow the choice — otherwise the language could not be changed at all, because the
 * only way to reach another language would be a model that supports it.
 */
export function collectCatalogLanguages(
  models: readonly VoiceSpeechModel[],
  currentLanguage: string,
): string[] {
  const languages = new Set<string>();
  if (currentLanguage) languages.add(currentLanguage);
  for (const model of models) {
    for (const language of model.languages) languages.add(language);
  }
  return [...languages].sort();
}
