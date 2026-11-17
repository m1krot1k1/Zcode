import { mergeStage4Section, matchesStage4Search } from "./contract.js";

export const example = {
  patch: mergeStage4Section(
    { enabled: false, debounceMs: 250, cursorAtEndOnly: true },
    { enabled: true },
  ),
  searchHit: matchesStage4Search("debounce", ["Chat autocomplete", "Debounce, ms"]),
};
