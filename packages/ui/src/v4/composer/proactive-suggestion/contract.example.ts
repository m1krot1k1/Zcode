import { buildProactiveSuggestionContext, canShowProactiveSuggestion } from "./contract.js";

/** Пример: триггер разрешён только для завершённого turn с пустым черновиком. */
export function exampleTrigger(): boolean {
  return canShowProactiveSuggestion({
    enabled: true,
    hasService: true,
    phase: "completedSuccess",
    draft: "",
    disabled: false,
    sessionId: "s1",
    turnId: "t1",
    decided: false,
  });
}

export const exampleContext = buildProactiveSuggestionContext({
  rows: [{ kind: "userInput", turnId: "t1", text: "Добавь тест" }],
  openFiles: ["packages/ui/test/a.test.ts"],
  diffs: [{ path: "packages/ui/test/a.test.ts", summary: "+2 -1" }],
});
