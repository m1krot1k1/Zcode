// Транскрипт → SessionEvent: barrel публичного API.
//
// Реализация разделена по лимиту строк:
// - transcript-hydration-primitives.ts — общие типы, нормализаторы и доступ к частям;
// - transcript-hydration-parts.ts — синтез событий из частей сообщений;
// - transcript-hydration-turns.ts — обход транскрипта и границы turn;
// - transcript-hydration-footprint.ts — замеры покрытия транскрипта/проекции.
//
// Потребители (replay, cold-event-merge, тесты) импортируют те же имена, что и раньше.
export type { HydratedGoalVerificationEntry } from "./transcript-hydration-primitives.js";
export { goalVerificationEntriesFromSessionEntries } from "./transcript-hydration-parts.js";
export { synthesizeEventsFromMessages } from "./transcript-hydration-turns.js";
export { eventsCoverTranscript } from "./transcript-hydration-footprint.js";
